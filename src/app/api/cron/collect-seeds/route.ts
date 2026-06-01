import { NextRequest, NextResponse } from 'next/server';
import { fetchDNRSS, preFilterItems } from '@/lib/rss';
import { searchBankruptcies, fetchKunngjoringer, fetchBrregUpdates, verifyCompany, enrichBrregSeed, CachedBrregLookup, isViableBrregLead } from '@/lib/bronnysund';
import { detectTriggers } from '@/lib/gemini';
import { createSeed, checkDuplicate } from '@/lib/airtable';
import { scrapeUrl, resetFirecrawlBudget, getFirecrawlStats } from '@/lib/firecrawl';
import { searchNewsContext } from '@/lib/search';
import { fetchEuronextAnnouncements } from '@/lib/euronext';
// import { fetchFinnJobs } from '@/lib/finn'; // Disabled - see Stage 4 below
import { requireAuth } from '@/lib/auth';

// Max Firecrawl credits to spend on news enrichment for Brreg seeds
const MAX_NEWS_ENRICHMENT_SEARCHES = 10;

// Buffered Brreg seed before writing to Airtable
interface BufferedSeed {
    data: any; // Seed data for createSeed()
    employees: number; // For sorting (enrich largest companies first)
    resultKey: 'bronnysund_seeds' | 'brreg_updates_seeds' | 'brreg_kunngjoringer_seeds';
}

// Use Node.js runtime for Airtable SDK compatibility
export const maxDuration = 300; // 5 minutes max

/**
 * Seed Collection Cron Job
 * Collects potential leads from multiple sources:
 * 1. Brønnøysund bankruptcies (free API)
 * 1.25. Brreg Update Monitor (status changes + role changes, free API)
 * 1.5. Brreg Kunngjøringer (scrape w2.brreg.no)
 * 2. RSS feeds (DN, E24, Finansavisen, NTB)
 * 3. Targeted scraping (NewsWeb, Finansavisen PR)
 * 4. FINN Jobb (DISABLED - pending corroboration repurpose)
 */
export async function GET(request: NextRequest) {
    const authError = requireAuth(request);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    // Reset Firecrawl credit budget at start of each run (max 20 credits)
    resetFirecrawlBudget();

    let opsCount = 0;
    const startTime = Date.now();
    const results = {
        bronnysund_seeds: 0,
        brreg_updates_seeds: 0,
        brreg_kunngjoringer_seeds: 0,
        rss_seeds: 0,
        firecrawl_seeds: 0,
        finn_seeds: 0,
        duplicates_skipped: 0,
        errors: [] as string[],
    };

    const checkLimit = () => {
        if (opsCount >= limit) {
            console.log(`⚠️ Limit of ${limit} operations reached. Stopping.`);
            return true;
        }
        return false;
    };

    try {
        // ============================================
        // BRREG STAGES: Buffer seeds, then enrich with news before writing
        // ============================================
        const brregSeedBuffer: BufferedSeed[] = [];

        // 1. Fetch bankruptcies from Brønnøysund (free API)
        console.log('Fetching bankruptcies from Brønnøysund...');
        const bankruptcies = await searchBankruptcies(30);

        for (const company of bankruptcies) {
            try {
                const verification = verifyCompany(company);
                if (!verification.is_ostlandet) continue;

                const viability = isViableBrregLead(company);
                if (!viability.viable) continue;

                const isDuplicate = await checkDuplicate(company.organisasjonsnummer);
                if (isDuplicate) {
                    results.duplicates_skipped++;
                    continue;
                }

                brregSeedBuffer.push({
                    data: {
                        company_name: company.navn,
                        org_number: company.organisasjonsnummer,
                        source_type: 'bronnysund',
                        source_url: `https://data.brreg.no/enhetsregisteret/oppslag/enheter/${company.organisasjonsnummer}`,
                        trigger_detected: 'Restructuring',
                        excerpt: `Konkurs meldt ${company.konkursdato || 'nylig'}. ${company.antallAnsatte || 0} ansatte.`,
                        collected_at: new Date().toISOString(),
                        processed: false
                    },
                    employees: company.antallAnsatte || 0,
                    resultKey: 'bronnysund_seeds',
                });
            } catch (error) {
                results.errors.push(`Brønnøysund seed error: ${error}`);
            }
        }

        // 1.25. Brreg Update Monitor (status changes + role changes — free API)
        if (!checkLimit()) {
            console.log('Fetching Brreg update monitor...');
            try {
                const updates = await fetchBrregUpdates(2);

                const brregLookup = new CachedBrregLookup();
                const orgNumbers = updates.map(u => u.org_number).filter(Boolean);
                const companyDataMap = orgNumbers.length > 0
                    ? await brregLookup.batchLookup(orgNumbers)
                    : new Map();

                for (const update of updates) {
                    try {
                        const isDuplicate = await checkDuplicate(update.org_number || update.company_name);
                        if (isDuplicate) {
                            results.duplicates_skipped++;
                            continue;
                        }

                        const sourceType = update.change_type === 'role_change'
                            ? 'brreg_role_change'
                            : 'brreg_status_update';

                        const companyData = companyDataMap.get(update.org_number) || null;
                        const enrichedContent = enrichBrregSeed(
                            {
                                source_type: sourceType,
                                excerpt: update.excerpt,
                                created_at: update.update_date,
                            },
                            companyData
                        );

                        brregSeedBuffer.push({
                            data: {
                                company_name: update.company_name,
                                org_number: update.org_number,
                                source_type: sourceType,
                                source_url: update.source_url,
                                trigger_detected: update.trigger_category,
                                excerpt: update.excerpt.slice(0, 500),
                                raw_content: enrichedContent,
                                collected_at: new Date().toISOString(),
                                processed: false,
                            },
                            employees: companyData?.antallAnsatte || 0,
                            resultKey: 'brreg_updates_seeds',
                        });
                    } catch (error) {
                        results.errors.push(`Brreg update seed error: ${error}`);
                    }
                }
            } catch (error) {
                results.errors.push(`Brreg Update Monitor failed: ${error}`);
            }
        }

        // 1.5. Brreg Kunngjøringer (gjeldsforhandling, fusjon, fisjon, tvangsoppløsning)
        if (!checkLimit()) {
            console.log('Fetching Brreg kunngjøringer...');
            try {
                opsCount += 2; // 1 Firecrawl scrape + 1 Gemini parse
                const kunngjoringer = await fetchKunngjoringer(7);

                const kBrregLookup = new CachedBrregLookup();
                const kOrgNumbers = kunngjoringer.map(k => k.org_number).filter(Boolean);
                const kCompanyData = kOrgNumbers.length > 0
                    ? await kBrregLookup.batchLookup(kOrgNumbers)
                    : new Map();

                for (const k of kunngjoringer) {
                    try {
                        if (k.org_number) {
                            const kCompany = kCompanyData.get(k.org_number) || null;
                            const viability = isViableBrregLead(kCompany);
                            if (!viability.viable) continue;
                        }

                        const isDuplicate = await checkDuplicate(k.org_number || k.company_name);
                        if (isDuplicate) {
                            results.duplicates_skipped++;
                            continue;
                        }

                        brregSeedBuffer.push({
                            data: {
                                company_name: k.company_name,
                                org_number: k.org_number || '',
                                source_type: 'brreg_kunngjoringer',
                                source_url: 'https://w2.brreg.no/kunngjoring/kombisok.jsp',
                                trigger_detected: k.trigger_category,
                                excerpt: `${k.announcement_type}: ${k.excerpt}`.slice(0, 500),
                                collected_at: new Date().toISOString(),
                                processed: false
                            },
                            employees: kCompanyData.get(k.org_number)?.antallAnsatte || 0,
                            resultKey: 'brreg_kunngjoringer_seeds',
                        });
                    } catch (error) {
                        results.errors.push(`Brreg kunngjøring seed error: ${error}`);
                    }
                }
            } catch (error) {
                results.errors.push(`Brreg kunngjøringer failed: ${error}`);
            }
        }

        // 1.75. NEWS ENRICHMENT: Search for news about top Brreg leads (by employee count)
        // Budget: max 10 Firecrawl searches (1 credit each, metadata only)
        if (brregSeedBuffer.length > 0) {
            // Sort by employee count DESC — enrich largest companies first
            const sorted = [...brregSeedBuffer].sort((a, b) => b.employees - a.employees);
            const toEnrich = sorted.slice(0, MAX_NEWS_ENRICHMENT_SEARCHES);

            console.log(`📰 News enrichment: searching for ${toEnrich.length} of ${brregSeedBuffer.length} Brreg leads...`);

            for (const buffered of toEnrich) {
                try {
                    const newsResult = await searchNewsContext(buffered.data.company_name);
                    if (newsResult.hasNews) {
                        buffered.data.raw_content = (buffered.data.raw_content || buffered.data.excerpt || '') +
                            '\n\n' + newsResult.newsContext;
                        console.log(`  ✓ Found news for ${buffered.data.company_name}`);
                    }
                    opsCount++; // Count Firecrawl search credit
                } catch (error) {
                    results.errors.push(`News enrichment error for ${buffered.data.company_name}: ${error}`);
                }
            }
        }

        // Write all buffered Brreg seeds to Airtable
        for (const buffered of brregSeedBuffer) {
            try {
                await createSeed(buffered.data);
                results[buffered.resultKey]++;
            } catch (error) {
                results.errors.push(`Brreg seed write error: ${error}`);
            }
        }

        console.log(`📊 Brreg stages complete: ${brregSeedBuffer.length} seeds buffered and written`);

        // 2. Fetch and analyze RSS (DN + E24 + Finansavisen)
        // This uses Gemini tokens.
        if (!checkLimit()) {
            console.log('Fetching RSS feeds...');
            const dnItems = await fetchDNRSS();

            console.log(`📰 Fetched ${dnItems.length} from DN feed`);

            let e24Items: any[] = [];
            try {
                const { fetchE24RSS } = await import('@/lib/rss');
                e24Items = await fetchE24RSS();
                console.log(`📰 Fetched ${e24Items.length} from E24 feed`);
            } catch (e) {
                console.warn('E24 RSS failed, skipping');
            }

            let finansavisenItems: any[] = [];
            try {
                const { fetchFinansavisenRSS } = await import('@/lib/rss');
                finansavisenItems = await fetchFinansavisenRSS();
                console.log(`📰 Fetched ${finansavisenItems.length} from Finansavisen feed`);
            } catch (e) {
                console.warn('Finansavisen RSS failed');
            }

            let ntbItems: any[] = [];
            try {
                const { fetchNTBRSS } = await import('@/lib/rss');
                ntbItems = await fetchNTBRSS();
                console.log(`📰 Fetched ${ntbItems.length} from NTB feed`);
            } catch (e) {
                console.warn('NTB RSS failed');
            }

            let rett24Items: any[] = [];
            try {
                const { fetchRett24RSS } = await import('@/lib/rss');
                rett24Items = await fetchRett24RSS();
                console.log(`📰 Fetched ${rett24Items.length} from Rett24 feed`);
            } catch (e) {
                console.warn('Rett24 RSS failed');
            }

            let digiItems: any[] = [];
            try {
                const { fetchDigiRSS } = await import('@/lib/rss');
                digiItems = await fetchDigiRSS();
                console.log(`📰 Fetched ${digiItems.length} from Digi feed`);
            } catch (e) {
                console.warn('Digi RSS failed');
            }

            const rssItems = [...dnItems, ...e24Items, ...finansavisenItems, ...ntbItems, ...rett24Items, ...digiItems];
            // Filter down to reduce potential waste before Gemini
            const filteredItems = preFilterItems(rssItems).slice(0, Math.max(0, limit - opsCount));

            for (const item of filteredItems) {
                if (checkLimit()) break;

                try {
                    opsCount++; // Counting Gemini call
                    const sourceName = item.link.includes('dn.no') ? 'dn_rss' :
                        item.link.includes('e24.no') ? 'e24' :
                            item.link.includes('finansavisen.no') ? 'finansavisen' :
                                item.link.includes('ntb.no') || item.link.includes('rss.app') ? 'ntb' :
                                    item.link.includes('rett24.no') ? 'rett24_rss' :
                                        item.link.includes('digi.no') ? 'digi_rss' : 'dn_rss';

                    let contentToAnalyze = `${item.title}\n\n${item.description}`;

                    // NEW Nuanced Scraping Policy
                    const isMixedSource = ['dn.no', 'e24.no', 'finansavisen.no'].some(d => item.link.includes(d));
                    const descLen = (item.description || '').length;

                    // Logic: 
                    // - For mixed sources, only scrape if description is extremely thin (< 100 chars)
                    // - For other sources (X.com, press releases), scrape if under 400 chars
                    let shouldScrape = false;
                    if (isMixedSource && descLen < 100) shouldScrape = true;
                    if (!isMixedSource && descLen < 400) shouldScrape = true;

                    if (shouldScrape && item.link) {
                        console.log(`🔍 Deep Scraping ${item.title.slice(0, 20)}... (${item.link})`);
                        const scrape = await scrapeUrl(item.link);

                        if (scrape.success && scrape.content) {
                            // Simple Paywall detection: If text is short and contains buy/login keywords
                            const paywallKeywords = ['abonnement', 'logg inn', 'kjøp tilgang', 'plussartikkel'];
                            const isPaywall = paywallKeywords.some(k => scrape.content!.toLowerCase().includes(k)) && scrape.content!.length < 1500;

                            if (!isPaywall) {
                                contentToAnalyze += `\n\nSCRAPED CONTENT:\n${scrape.content}`;
                            } else {
                                console.log(`🚫 Paywall detected for ${item.link}, sticking to RSS teaser.`);
                            }
                        }
                    }

                    const triggerResult = await detectTriggers(
                        contentToAnalyze,
                        'news_article',
                        sourceName
                    );

                    console.log(`[DEBUG] Gemini result for ${item.title.slice(0, 30)}...:`, JSON.stringify(triggerResult));

                    if (triggerResult.no_trigger_found || triggerResult.triggers_found.length === 0) continue;

                    const companyName = triggerResult.company_mentioned.name || 'Unknown';
                    if (companyName === 'Unknown') continue;

                    const isDuplicate = await checkDuplicate(triggerResult.company_mentioned.org_number || companyName);
                    if (isDuplicate) {
                        results.duplicates_skipped++;
                        continue;
                    }

                    // Ensure trigger matches Airtable Select options
                    const validTriggers = [
                        'LeadershipChange', 'Restructuring', 'MergersAcquisitions', 'StrategicReview',
                        'OperationalCrisis', 'RegulatoryLegal', 'CostProgram', 'HiringSignal',
                        'OwnershipGovernance', 'TransformationProgram'
                    ];
                    const detectedTrigger = triggerResult.triggers_found[0]?.category || 'LeadershipChange';
                    const finalTrigger = validTriggers.includes(detectedTrigger) ? detectedTrigger : 'LeadershipChange';

                    await createSeed({
                        company_name: companyName,
                        org_number: triggerResult.company_mentioned.org_number || '',
                        source_type: sourceName,
                        source_url: item.link,
                        trigger_detected: finalTrigger,
                        excerpt: (triggerResult.triggers_found[0]?.excerpt || item.description || item.title).slice(0, 500),
                        collected_at: new Date().toISOString(),
                        processed: false
                    });
                    results.rss_seeds++;
                } catch (error) {
                    results.errors.push(`RSS item error: ${error}`);
                }
            }
        }

        // 3a. NewsWeb/Euronext 2-Stage Intelligent Scraper
        // Stage 1: Scrape listing (1 credit) → analyze → Stage 2: Deep scrape interesting (5-10 credits)
        if (!checkLimit()) {
            try {
                const { scrapeNewsWebListing, deepScrapeNewsWebAnnouncements } = await import('@/lib/newsweb');

                // Stage 1: Get all announcements + identify interesting ones
                const newsWebResult = await scrapeNewsWebListing();
                opsCount += newsWebResult.creditsUsed; // 1 Firecrawl credit
                opsCount++; // Gemini trigger detection

                if (newsWebResult.interesting.length > 0) {
                    console.log(`📰 NewsWeb: ${newsWebResult.interesting.length} interesting announcements found`);

                    // Stage 2: Deep scrape only interesting announcements
                    const fullContent = await deepScrapeNewsWebAnnouncements(newsWebResult.interesting);
                    opsCount += newsWebResult.interesting.length; // Firecrawl credits for deep scrape

                    // Create seeds for each interesting announcement with full content
                    for (const announcement of newsWebResult.interesting) {
                        const isDuplicate = await checkDuplicate(announcement.company_name);
                        if (isDuplicate) {
                            results.duplicates_skipped++;
                            continue;
                        }

                        const validTriggers = [
                            'LeadershipChange', 'Restructuring', 'MergersAcquisitions', 'StrategicReview',
                            'OperationalCrisis', 'RegulatoryLegal', 'CostProgram', 'HiringSignal',
                            'OwnershipGovernance', 'TransformationProgram'
                        ];
                        const detectedTrigger = announcement.triggers?.[0] || 'LeadershipChange';
                        const finalTrigger = validTriggers.includes(detectedTrigger) ? detectedTrigger : 'LeadershipChange';

                        const content = fullContent.get(announcement.company_name) || announcement.title;

                        await createSeed({
                            company_name: announcement.company_name,
                            org_number: '', // Will be looked up later
                            source_type: 'newsweb',
                            source_url: announcement.url,
                            trigger_detected: finalTrigger,
                            excerpt: announcement.title.slice(0, 500),
                            raw_content: content,
                            collected_at: new Date().toISOString(),
                            processed: false
                        });
                        results.firecrawl_seeds++;
                    }

                    console.log(`✅ NewsWeb: Created ${newsWebResult.interesting.length} seeds with full content`);
                } else {
                    console.log('📰 NewsWeb: No interesting announcements found');
                }
            } catch (error) {
                results.errors.push(`NewsWeb scrape error: ${error}`);
            }
        }

        // 3b. Finansavisen Pressemeldinger (still uses Firecrawl — 1 credit)
        if (!checkLimit()) {
            console.log('Scraping Finansavisen PR...');
            try {
                opsCount++; // Firecrawl scrape
                const scrapeResult = await scrapeUrl('https://www.finansavisen.no/siste/pressemeldinger');
                if (scrapeResult.success && scrapeResult.content) {
                    opsCount++; // Gemini call
                    const triggerResult = await detectTriggers(
                        scrapeResult.content,
                        'web_scrape',
                        'Finansavisen_PR'
                    );

                    if (!triggerResult.no_trigger_found) {
                        const companyName = triggerResult.company_mentioned.name;
                        if (companyName && companyName !== 'Unknown') {
                            const isDuplicate = await checkDuplicate(triggerResult.company_mentioned.org_number || companyName);
                            if (isDuplicate) {
                                results.duplicates_skipped++;
                            } else {
                                const validTriggers = [
                                    'LeadershipChange', 'Restructuring', 'MergersAcquisitions', 'StrategicReview',
                                    'OperationalCrisis', 'RegulatoryLegal', 'CostProgram', 'HiringSignal',
                                    'OwnershipGovernance', 'TransformationProgram'
                                ];
                                const detectedTrigger = triggerResult.triggers_found[0]?.category || 'LeadershipChange';
                                const finalTrigger = validTriggers.includes(detectedTrigger) ? detectedTrigger : 'LeadershipChange';

                                await createSeed({
                                    company_name: companyName,
                                    org_number: triggerResult.company_mentioned.org_number || '',
                                    source_type: 'newsweb',
                                    source_url: 'https://www.finansavisen.no/siste/pressemeldinger',
                                    trigger_detected: finalTrigger,
                                    excerpt: (triggerResult.triggers_found[0]?.excerpt || '').slice(0, 500),
                                    collected_at: new Date().toISOString(),
                                    processed: false
                                });
                                results.firecrawl_seeds++;
                            }
                        }
                    }
                }
            } catch (error) {
                results.errors.push(`Finansavisen PR scrape error: ${error}`);
            }
        }

        // 4. FINN Jobb (CxO listings on Østlandet)
        // ⚠️ TEMPORARILY DISABLED (Feb 9 2026)
        // Reason: FINN generates weak signals (E0: 0.3, W0: 0.3, R0: 0.5) with C=0.525 baseline
        // Job postings are not crisis/interim signals - most qualify below threshold (C < 0.60)
        // Plan: Repurpose FINN as corroboration source to validate leads from other sources
        // To re-enable: uncomment this block and add back finn_seeds to totalSeeds calculation
        /*
        if (!checkLimit()) {
            console.log('Fetching FINN job listings...');
            try {
                const finnJobs = await fetchFinnJobs();
                opsCount += 12; // 6 scrapes + 6 Gemini parses

                for (const job of finnJobs) {
                    try {
                        const isDuplicate = await checkDuplicate(job.company_name);
                        if (isDuplicate) {
                            results.duplicates_skipped++;
                            continue;
                        }

                        const urgencyText = job.urgency_signals.length > 0
                            ? ` Hastesignaler: ${job.urgency_signals.join(', ')}.`
                            : '';

                        await createSeed({
                            company_name: job.company_name,
                            org_number: '',
                            source_type: 'finn',
                            source_url: job.url || `https://www.finn.no/job/search?q=${encodeURIComponent(job.search_query)}`,
                            trigger_detected: 'HiringSignal',
                            excerpt: `Søker ${job.role}.${urgencyText}`.slice(0, 500),
                            collected_at: new Date().toISOString(),
                            processed: false
                        });
                        results.finn_seeds++;
                    } catch (error) {
                        results.errors.push(`FINN seed error: ${error}`);
                    }
                }
            } catch (error) {
                results.errors.push(`FINN job scraping failed: ${error}`);
            }
        }
        */

        const totalSeeds = results.bronnysund_seeds + results.brreg_updates_seeds
            + results.brreg_kunngjoringer_seeds + results.rss_seeds + results.firecrawl_seeds;
            // Note: finn_seeds excluded (FINN disabled as of Feb 9 2026)
        const duration = Date.now() - startTime;
        return NextResponse.json({
            success: true,
            ...results,
            ops_count: opsCount,
            limit_reached: opsCount >= limit,
            firecrawl: getFirecrawlStats(),
            message: `Collected ${totalSeeds} seeds. Operations: ${opsCount}/${limit}`,
            duration: `${duration}ms`
        });

    } catch (error) {
        console.error('Seed collection failed:', error);
        return NextResponse.json(
            { success: false, error: String(error) },
            { status: 500 }
        );
    }
}
