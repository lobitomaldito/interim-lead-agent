import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
    getUnprocessedSeeds,
    batchCreateCaseFiles,
    batchUpdateSeedsStatus,
    batchCreateEvidence,
    checkDuplicate,
} from '@/lib/airtable';
import { CachedBrregLookup, getBrregConfirmation } from '@/lib/bronnysund';
import { batchProcessSeeds, generateWhyNowBatch, generateSummaryBatch, generateStructuredAnalysisBatch } from '@/lib/gemini';
import { searchCorroboration } from '@/lib/search';
import { scrapeUrl, resetFirecrawlBudget, getFirecrawlStats } from '@/lib/firecrawl';
import { getScoringWeights, computeStartScores } from '@/config/scoring-config';
import { logger } from '@/lib/logger';
import { groupSeedsByCompany } from '@/lib/corroboration';

// ============================================
// CONFIGURATION
// ============================================
export const maxDuration = 300; // 5 minutes max

// ============================================
// ESL+ THRESHOLDS (per Addendum v1.0)
// ============================================
const THRESHOLDS = {
    C_MIN: 0.60,          // Minimum C for qualification (Addendum §3)
    MAX_ITERATIONS: 5,
};

// ============================================
// SCORING HELPERS (per Addendum v1.0)
// ============================================
function computeC(E: number, W: number, V: number, R: number): number {
    return (E + W + V + (1 - R)) / 4;
}

function computeStars(C: number): number {
    if (C >= 0.75) return 3;
    if (C >= 0.65) return 2;
    if (C >= 0.60) return 1;
    return 0;
}

// ============================================
// MAIN ENDPOINT - BATCH PROCESSING
// ============================================
export async function POST(request: NextRequest) {
    const authError = requireAuth(request);
    if (authError) return authError;

    const startTime = Date.now();
    const apiCallsUsed = { gemini: 0, bronnysund: 0, airtable: 0, firecrawl: 0 };

    // Mode: production (max 10, stars only) or test (max 25, full scores)
    const { searchParams } = new URL(request.url);
    const mode = (searchParams.get('mode') === 'production' ? 'production' : 'test') as 'production' | 'test';
    const maxLeads = mode === 'production' ? 10 : 25;

    // Load current dynamic weights
    const SCORING_WEIGHTS = getScoringWeights();

    try {
        // 1. Hent alle ubehandlede seeds i ETT kall
        const unprocessedSeeds = await getUnprocessedSeeds();
        apiCallsUsed.airtable++;

        if (unprocessedSeeds.length === 0) {
            return NextResponse.json({
                message: 'No seeds to process',
                mode,
                apiCalls: apiCallsUsed
            });
        }

        // 2. Cross-source corroboration: group seeds by company
        const seedGroups = groupSeedsByCompany(unprocessedSeeds);
        logger.info(`📥 Processing ${unprocessedSeeds.length} seeds → ${seedGroups.length} company groups`, { mode, component: 'process-esl' });

        // 3. Brønnøysund: Batch lookup med caching
        const orgNumbers = [...new Set(seedGroups.map(g => g.canonical_org_number).filter(Boolean))];
        const brregCache = new CachedBrregLookup();
        const brregData = await brregCache.batchLookup(orgNumbers);
        apiCallsUsed.bronnysund += brregCache.getApiCallCount();

        // 4. Initial scoring & Verification (per group, not per seed)
        const caseFilesData = await Promise.all(seedGroups.map(async (group) => {
            const seed = group.primary_seed;
            const sourceType = seed.source_type || 'default';
            const sourceWeights = SCORING_WEIGHTS[sourceType] || SCORING_WEIGHTS.default;
            const trigger = seed.trigger_detected || 'LeadershipChange';
            const startScores = computeStartScores(sourceWeights, trigger, sourceType);

            // Try org number lookup first, fall back to name search
            let company = group.canonical_org_number ? (brregData.get(group.canonical_org_number.replace(/\s/g, '')) || null) : null;
            if (!company && group.canonical_name) {
                company = await brregCache.searchByName(group.canonical_name);
                if (company && mode === 'test') {
                    logger.audit(`Name search match: "${group.canonical_name}" → ${company.navn} (${company.organisasjonsnummer})`, { mode, component: 'process-esl' });
                }
            }

            const verification = CachedBrregLookup.verify(company);

            if (mode === 'test') {
                logger.audit(`Verification for ${group.canonical_name}: ${JSON.stringify(verification)}`, { mode, component: 'process-esl' });
            }

            // UNIVERSAL EMPLOYEE FILTER: Enforce 30+ employees for ALL sources (Phase 6)
            const employees = company?.antallAnsatte ?? 0;
            const employeeCheckFailed = employees > 0 && employees < 30;

            if (employeeCheckFailed) {
                if (mode === 'test') {
                    logger.audit(
                        `Employee filter: ${group.canonical_name} rejected (${employees} employees, need 30+)`,
                        { mode, component: 'process-esl' }
                    );
                }
                // Return with hard_stop veto
                const effectiveSeed = { ...seed };
                if (group.source_count > 1) {
                    effectiveSeed.raw_content = group.merged_raw_content;
                }

                return {
                    seed: effectiveSeed,
                    company_name: group.canonical_name || company?.navn || 'Unknown',
                    org_number: group.canonical_org_number || company?.organisasjonsnummer || '',
                    E: Math.min(1.0, startScores.E + group.corroboration_boost),
                    W: Math.min(1.0, startScores.W + group.corroboration_boost),
                    V: verification.V,
                    R: startScores.R,
                    brreg_data: company,
                    verification: {
                        ...verification,
                        hard_stop: true,
                        reasoning: `Too few employees: ${employees} (min 30)`
                    },
                    is_duplicate: false,
                    status: 'processing' as const,
                    source_count: group.source_count,
                    merged_triggers: group.merged_triggers,
                };
            }

            // Use resolved org number (from seed or name search)
            const resolvedOrgNumber = group.canonical_org_number || company?.organisasjonsnummer || '';

            // Anti-repetition: Addendum §4 — dedup key is (company, trigger, role)
            const role = mapTriggerToRole(trigger);
            const isDuplicate = resolvedOrgNumber
                ? await checkDuplicate(resolvedOrgNumber, trigger, role)
                : false;

            if (isDuplicate && mode === 'test') {
                logger.audit(`Duplicate detected: ${group.canonical_name} (${trigger}, ${role})`, { mode, component: 'process-esl' });
            }

            // Apply trigger modifier + corroboration boost for multi-source leads
            const E_initial = Math.min(1.0, startScores.E + group.corroboration_boost);
            const W_initial = Math.min(1.0, startScores.W + group.corroboration_boost);

            // For multi-source groups, use merged content so Gemini sees all context
            const effectiveSeed = { ...seed };
            if (group.source_count > 1) {
                effectiveSeed.raw_content = group.merged_raw_content;
                effectiveSeed.excerpt = `[${group.source_count} kilder] ${seed.excerpt || ''}`;
                if (mode === 'test') {
                    logger.audit(`Corroborated: ${group.canonical_name} from ${group.source_types.join(', ')} (boost: +${group.corroboration_boost.toFixed(2)})`, { mode, component: 'process-esl' });
                }
            }

            // For non-Brreg seeds: append Brreg confirmation/profile for richer Gemini context
            const isBrregSource = sourceType.startsWith('brreg') || sourceType === 'bronnysund';
            if (!isBrregSource && company) {
                const confirmation = getBrregConfirmation(company);
                if (confirmation.confirms_crisis) {
                    effectiveSeed.raw_content = (effectiveSeed.raw_content || effectiveSeed.excerpt || '') +
                        `\n\nBRREG BEKREFTER: ${confirmation.crisis_signals.join(', ')}. ${confirmation.company_profile}`;
                } else if (confirmation.company_profile) {
                    effectiveSeed.raw_content = (effectiveSeed.raw_content || effectiveSeed.excerpt || '') +
                        `\n\nBRREG PROFIL: ${confirmation.company_profile}`;
                }
            }

            return {
                seed: effectiveSeed,
                company_name: group.canonical_name || company?.navn || 'Unknown',
                org_number: resolvedOrgNumber,
                E: E_initial,
                W: W_initial,
                V: verification.V,
                R: startScores.R,
                brreg_data: company,
                verification,
                is_duplicate: isDuplicate,
                status: 'processing' as const,
                source_count: group.source_count,
                merged_triggers: group.merged_triggers,
            };
        }));

        // 4. BATCH Gemini scoring (Stage 1)
        // Filter out hard stops (veto: entity not found OR not Østlandet) and duplicates
        const toScore = caseFilesData.filter(c => !c.verification.hard_stop && !c.is_duplicate);

        if (toScore.length === 0) {
            const seedIds = unprocessedSeeds.map(s => s.id);
            await batchUpdateSeedsStatus(seedIds, true);
            apiCallsUsed.airtable++;

            return NextResponse.json({
                message: 'All seeds were filtered by vetoes or deduplication',
                mode,
                processed: unprocessedSeeds.length,
                skipped: unprocessedSeeds.length,
                apiCalls: apiCallsUsed
            });
        }

        // Addendum §5: No free-form Gemini learning from feedback
        let scoredCases = await batchProcessSeeds(toScore as any);
        apiCallsUsed.gemini++;

        // 5. STAGE 2: Targeted Seeking for leads just below C threshold
        const needsEvidence = scoredCases.filter(c => {
            const C = computeC(c.E, c.W, c.V, c.R);
            return C < THRESHOLDS.C_MIN && C >= 0.50;
        });

        if (needsEvidence.length > 0) {
            logger.info(`🔍 Stage 2: Seeking evidence for ${needsEvidence.length} promising leads`, { mode, component: 'process-esl' });

            for (const c of needsEvidence) {
                const searchResults = await searchCorroboration(c.company_name, c.seed.trigger_type || c.seed.trigger_detected || '');
                if (searchResults.length > 0) {
                    c.seed.raw_content = (c.seed.raw_content || '') + '\n\nSUPPLEMENTAL EVIDENCE:\n' +
                        searchResults.map(sr => `[${sr.title}]: ${sr.content || sr.description}`).join('\n---\n');
                }
            }

            const reScored = await batchProcessSeeds(needsEvidence);
            apiCallsUsed.gemini++;

            scoredCases = scoredCases.map(c => {
                const updated = reScored.find(rs => rs.org_number === c.org_number);
                return updated || c;
            });
        }

        // 6. Qualification: C ≥ 0.60 (Addendum §3)
        const qualified = scoredCases.filter(c => {
            const C = computeC(c.E, c.W, c.V, c.R);
            return C >= THRESHOLDS.C_MIN;
        });

        const dropped = scoredCases.filter(c => !qualified.includes(c));

        // Apply output cap: sort by C descending, take max leads
        const sortedQualified = qualified.sort((a, b) =>
            computeC(b.E, b.W, b.V, b.R) - computeC(a.E, a.W, a.V, a.R)
        );
        const cappedQualified = sortedQualified.slice(0, maxLeads);

        // 6b. Deep content scrape for qualified leads (1 Firecrawl credit each)
        // Only scrape specific article URLs — not listing pages or API endpoints
        const LISTING_URL_PATTERNS = [
            'euronext.com/en/markets',
            'newsweb.oslobors.no',
            '/api/',
            'data.brreg.no',
        ];

        if (cappedQualified.length > 0) {
            resetFirecrawlBudget();
            let deepScrapedCount = 0;

            for (const c of cappedQualified) {
                const sourceUrl = c.seed.source_url;
                if (!sourceUrl) continue;

                // Skip listing pages and API URLs — only scrape actual articles
                const isListingPage = LISTING_URL_PATTERNS.some(p => sourceUrl.includes(p));
                if (isListingPage) continue;

                logger.info(`📰 Deep scraping for ${c.company_name}: ${sourceUrl.slice(0, 80)}...`, { mode, component: 'process-esl' });
                const scrapeResult = await scrapeUrl(sourceUrl);

                if (scrapeResult.success && scrapeResult.content) {
                    // Truncate to keep context manageable for Gemini
                    const truncated = scrapeResult.content.length > 3000
                        ? scrapeResult.content.slice(0, 3000) + '\n\n[...trunkert]'
                        : scrapeResult.content;

                    c.seed.raw_content = (c.seed.raw_content || '') +
                        `\n\nFULL ARTIKKEL (${sourceUrl}):\n${truncated}`;
                    deepScrapedCount++;
                }
            }

            const stats = getFirecrawlStats();
            logger.info(`📰 Deep scrape complete: ${deepScrapedCount}/${cappedQualified.length} leads enriched (${stats.credits_used} Firecrawl credits)`, { mode, component: 'process-esl' });
            apiCallsUsed.firecrawl = stats.credits_used;
        }

        // 7. BATCH generer Why Now, Oppsummering og Strukturert Analyse for ALLE kvalifiserte i denne batchen
        let whyNowTexts: Map<string, string> = new Map();
        let summaries: Map<string, string> = new Map();
        let structuredAnalysis: Map<string, any> = new Map();

        if (qualified.length > 0) {
            [whyNowTexts, summaries, structuredAnalysis] = await Promise.all([
                generateWhyNowBatch(qualified),
                generateSummaryBatch(qualified),
                generateStructuredAnalysisBatch(qualified)
            ]);
            apiCallsUsed.gemini += 3;
        }

        // 7b. Quality filter: Only keep leads with quality_score >= 60 (Phase 6)
        const highQualityLeads = qualified.filter(c => {
            const analysis = structuredAnalysis.get(c.org_number);
            if (!analysis) return false;

            const isHighQuality = analysis.quality_score >= 60;
            if (!isHighQuality && mode === 'test') {
                logger.audit(
                    `Rejected by quality filter: ${c.company_name} (score: ${analysis.quality_score}, reason: ${analysis.rejection_reason})`,
                    { mode, component: 'process-esl' }
                );
            }
            return isHighQuality;
        });

        const qualityRejected = qualified.filter(c => !highQualityLeads.includes(c));

        // 8. Update Airtable in batches
        if (scoredCases.length > 0) {
            await batchCreateCaseFiles(scoredCases.map(c => {
                const C = computeC(c.E, c.W, c.V, c.R);
                const isQualified = highQualityLeads.includes(c);  // Phase 6: Use quality-filtered leads
                const analysis = structuredAnalysis.get(c.org_number);
                const stars = isQualified ? computeStars(C) : 0;

                return {
                    company_name: c.company_name,
                    org_number: c.org_number,
                    trigger_hypothesis: c.seed.trigger_type || c.seed.trigger_detected || 'LeadershipChange',
                    E: Math.round(c.E * 100) / 100,
                    W: Math.round(c.W * 100) / 100,
                    V: c.V,
                    R: Math.round(c.R * 100) / 100,
                    status: isQualified ? 'qualified' : 'dropped',
                    why_now_text: analysis?.strategisk_begrunnelse || whyNowTexts.get(c.org_number) || c.gemini_reasoning || '',
                    qualified_at: isQualified ? new Date().toISOString() : undefined,
                    created_at: new Date().toISOString(),
                    suggested_role: mapTriggerToRole(c.seed.trigger_type || c.seed.trigger_detected || ''),
                    report_date: new Date().toISOString().split('T')[0],
                    is_ostlandet: c.verification.is_ostlandet,
                    has_operations: c.verification.has_operations,
                    source_type: c.seed.source_type,
                    // TODO: Uncomment after adding source_url field to Airtable CaseFiles (see AIRTABLE_SETUP.md)
                    // source_url: c.seed.source_url || '',
                    case_summary: summaries.get(c.org_number) || c.seed.excerpt || c.seed.raw_content?.slice(0, 500) || '',

                    // Phase 6: Structured Norwegian analysis fields
                    situasjonsanalyse: analysis?.situasjonsanalyse,
                    strategisk_begrunnelse: analysis?.strategisk_begrunnelse,
                    quality_score: analysis?.quality_score,
                    rejection_reason: !isQualified ? analysis?.rejection_reason : undefined,
                };
            }));
            logger.info(`✅ batchCreateCaseFiles completed for ${scoredCases.length} records`, { mode, component: 'process-esl' });
            apiCallsUsed.airtable++;
        }

        // Mark Seeds as processed
        const seedIds = unprocessedSeeds.map(s => s.id);
        await batchUpdateSeedsStatus(seedIds, true);
        apiCallsUsed.airtable++;

        const duration = Date.now() - startTime;

        // Response format depends on mode (Addendum §3)
        if (mode === 'production') {
            // Production: stars only, no numerical scores
            return NextResponse.json({
                success: true,
                mode,
                qualified: cappedQualified.length,
                dropped: dropped.length + qualityRejected.length,
                leads: highQualityLeads.map(c => ({
                    company_name: c.company_name,
                    stars: computeStars(computeC(c.E, c.W, c.V, c.R)),
                    why_now_text: whyNowTexts.get(c.org_number) || c.gemini_reasoning || '',
                    suggested_role: mapTriggerToRole(c.seed.trigger_type || c.seed.trigger_detected || ''),
                })),
                duration: `${duration}ms`,
            });
        }

        // Test mode: full scores and explanation
        return NextResponse.json({
            success: true,
            mode,
            processed: unprocessedSeeds.length,
            qualified: cappedQualified.length,
            dropped: dropped.length + qualityRejected.length,
            skipped: unprocessedSeeds.length - toScore.length,
            leads: highQualityLeads.map(c => {
                const C = computeC(c.E, c.W, c.V, c.R);
                return {
                    company_name: c.company_name,
                    org_number: c.org_number,
                    C: Math.round(C * 100) / 100,
                    E: Math.round(c.E * 100) / 100,
                    W: Math.round(c.W * 100) / 100,
                    V: c.V,
                    R: Math.round(c.R * 100) / 100,
                    stars: computeStars(C),
                    trigger: c.seed.trigger_type || c.seed.trigger_detected,
                    suggested_role: mapTriggerToRole(c.seed.trigger_type || c.seed.trigger_detected || ''),
                    why_now_text: whyNowTexts.get(c.org_number) || c.gemini_reasoning || '',
                    reasoning: c.gemini_reasoning || '',
                };
            }),
            duration: `${duration}ms`,
            apiCalls: apiCallsUsed,
            efficiency: `${(unprocessedSeeds.length / (apiCallsUsed.gemini + apiCallsUsed.bronnysund + apiCallsUsed.airtable)).toFixed(1)} seeds/API call`
        });

    } catch (error) {
        logger.error('ESL Processing error:', error, { mode, component: 'process-esl' });
        return NextResponse.json(
            { error: 'Processing failed', details: String(error) },
            { status: 500 }
        );
    }
}

function mapTriggerToRole(trigger: string): string {
    const mapping: Record<string, string> = {
        LeadershipChange: 'Daglig leder',
        Restructuring: 'Økonomisjef',
        MergersAcquisitions: 'Daglig leder',
        StrategicReview: 'Daglig leder',
        OperationalCrisis: 'Driftsdirektør',
        RegulatoryLegal: 'Daglig leder',
        CostProgram: 'Økonomisjef',
        HiringSignal: 'Daglig leder',
        OwnershipGovernance: 'Økonomisjef',
        TransformationProgram: 'Driftsdirektør',
    };
    return mapping[trigger] || 'Daglig leder';
}

// Allow GET for testing
export async function GET(request: NextRequest) {
    return POST(request);
}
