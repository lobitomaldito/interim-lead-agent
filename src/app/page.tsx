import { getCaseFiles, CaseFile } from '@/lib/airtable';

export const dynamic = 'force-dynamic';

export default async function Home() {
    const leads = await getCaseFiles();

    // Phase 6: Filter for high-quality leads only (2+ stars AND quality_score >= 60)
    const qualifiedLeads = leads
        .filter(l => l.status === 'qualified')
        .filter(l => (l.quality_score || 0) >= 60)  // AI quality threshold
        .filter(l => (l.stars || 0) >= 2)           // Minimum 2 stars
        .sort((a, b) => (b.stars || 0) - (a.stars || 0));

    return (
        <div className="min-h-screen pb-20 px-4 md:px-12 pt-16 bg-[#F8FAFC]">
            <div className="max-w-7xl mx-auto">
                {/* Enterprise Header */}
                <header className="mb-16 border-b border-slate-200 pb-12 flex flex-col md:flex-row md:items-center justify-between gap-10">
                    <div className="space-y-4">
                        <div className="inline-flex items-center gap-2.5 px-3 py-1 rounded-md bg-indigo-50 text-indigo-700 text-[11px] font-bold uppercase tracking-widest border border-indigo-100/50">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-600"></span>
                            </span>
                            Live System Intelligence
                        </div>
                        <h1 className="text-5xl font-light text-slate-900 tracking-tight leading-tight">
                            Markeds<span className="font-bold text-indigo-600">innsikt</span>
                        </h1>
                        <p className="text-slate-500 text-xl max-w-2xl font-normal leading-relaxed">
                            Strategiske markedssignaler og lederskifter identifisert av AI-basert overvåking.
                        </p>
                    </div>

                    <div className="flex items-center gap-0 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                        <div className="px-8 py-4 text-center border-r border-slate-100">
                            <div className="text-3xl font-bold text-slate-900 tabular-nums">{qualifiedLeads.length}</div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Signaler</div>
                        </div>
                        <div className="px-8 py-4 text-center bg-slate-50/50">
                            <div className="text-3xl font-bold text-indigo-600 tabular-nums">
                                {qualifiedLeads.filter(l => (l.stars || 0) >= 3).length}
                            </div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Høy Prioritet</div>
                        </div>
                    </div>
                </header>

                {/* Leads Grid */}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-10">
                    {qualifiedLeads.map((lead, index) => (
                        <LeadCard key={lead.id} lead={lead} index={index} />
                    ))}
                </div>

                {/* Empty State */}
                {qualifiedLeads.length === 0 && (
                    <div className="text-center py-40 bg-white rounded-2xl border border-slate-200 shadow-sm">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-xl bg-slate-50 border border-slate-100 mb-8">
                            <svg className="w-8 h-8 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
                            </svg>
                        </div>
                        <h3 className="text-2xl font-light text-slate-900 mb-3">Analyserer kilder...</h3>
                        <p className="text-slate-400 max-w-sm mx-auto font-normal text-lg">
                            Ingen kvalifiserte kilder funnet i denne syklusen.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

function SourceBadge({ type }: { type: string }) {
    const config: Record<string, { icon: string; color: string; label: string }> = {
        newsweb: { icon: '📰', color: 'bg-indigo-100 text-indigo-700', label: 'NewsWeb' },
        brreg_status_update: { icon: '📋', color: 'bg-emerald-100 text-emerald-700', label: 'Brreg' },
        brreg_role_change: { icon: '👤', color: 'bg-teal-100 text-teal-700', label: 'Rolle' },
        bronnysund: { icon: '⚖️', color: 'bg-rose-100 text-rose-700', label: 'Brreg' },
        brreg_kunngjoringer: { icon: '📄', color: 'bg-slate-100 text-slate-700', label: 'Kunngjøring' },
        finn: { icon: '💼', color: 'bg-amber-100 text-amber-700', label: 'FINN' },
        dn_rss: { icon: '📡', color: 'bg-blue-100 text-blue-700', label: 'DN' },
        e24_rss: { icon: '📡', color: 'bg-blue-100 text-blue-700', label: 'E24' },
        finansavisen_rss: { icon: '📡', color: 'bg-blue-100 text-blue-700', label: 'Finansavisen' },
        linkedin_exec: { icon: '🔗', color: 'bg-indigo-100 text-indigo-700', label: 'LinkedIn' },
        linkedin_signal: { icon: '🔗', color: 'bg-indigo-100 text-indigo-700', label: 'LinkedIn' },
    };

    const { icon, color, label } = config[type] || { icon: '📌', color: 'bg-slate-100 text-slate-700', label: 'Kilde' };

    return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 ${color} rounded-md text-[10px] font-bold uppercase tracking-wider`}>
            <span>{icon}</span>
            <span>{label}</span>
        </span>
    );
}

function BrregEnrichmentDisplay({ lead }: { lead: CaseFile }) {
    const eventType = lead.source_type === 'brreg_status_update' ? 'Statusendring' : 'Rolleendring';
    const eventDate = lead.created_at
        ? new Date(lead.created_at).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'Nylig';

    return (
        <div className="flex items-center gap-6 p-4 bg-slate-50 rounded-lg border border-slate-100 mb-4">
            <div className="flex flex-col gap-1">
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest leading-none">Hendelse</span>
                <span className="text-xs font-bold text-slate-900 uppercase">{eventType}</span>
            </div>
            <div className="w-px h-8 bg-slate-200"></div>
            <div className="flex flex-col gap-1">
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest leading-none">Registrert</span>
                <span className="text-xs font-bold text-slate-700 uppercase">{eventDate}</span>
            </div>
            <div className="ml-auto">
                <span className="px-2 py-1 bg-white border border-slate-200 text-slate-400 rounded text-[9px] font-bold uppercase tracking-widest">Offentlig register</span>
            </div>
        </div>
    );
}

function LeadCard({ lead, index }: { lead: CaseFile; index: number }) {
    return (
        <div
            className="enterprise-card group p-10 flex flex-col h-full animate-enter rounded-sm border-l-4 border-l-transparent hover:border-l-indigo-600 transition-all duration-300"
            style={{ animationDelay: `${index * 80}ms` }}
        >
            {/* Header: Identity & Rating */}
            <div className="flex justify-between items-start mb-8 gap-6">
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <h2 className="text-3xl font-bold text-slate-900 tracking-tight leading-none uppercase">
                            {lead.company_name}
                        </h2>
                        {lead.is_ostlandet && (
                            <span className="px-1.5 py-0.5 rounded-sm bg-slate-50 text-slate-400 text-[9px] font-bold uppercase tracking-[0.2em] border border-slate-100">
                                Region • Øst
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-indigo-600 uppercase tracking-widest px-2 py-0.5 bg-indigo-50/50 rounded-sm">
                            {lead.suggested_role || 'Interim Leder'}
                        </span>
                    </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                    <div className="flex gap-1">
                        {[...Array(3)].map((_, i) => (
                            <div
                                key={i}
                                className={`w-3 h-3 rounded-full transition-all duration-500 ${i < (lead.stars || 0) ? 'bg-indigo-600 shadow-[0_0_8px_rgba(99,102,241,0.4)]' : 'bg-slate-100'}`}
                                style={{ transitionDelay: `${i * 40}ms` }}
                            />
                        ))}
                    </div>
                    <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Rating</span>
                </div>
            </div>

            {/* Score Grid: E, W, V, R, AI-Score (Phase 6) */}
            <div className="grid grid-cols-5 gap-8 mb-10 border-t border-b border-slate-50 py-6">
                <ScoreMini label="Bevis" value={lead.E} color="indigo" />
                <ScoreMini label="Behov" value={lead.W} color="indigo" />
                <ScoreMini label="Verifisert" value={lead.V === 1 ? 1 : 0} color="indigo" />
                <ScoreMini label="Kvalitet" value={1 - (lead.R || 0)} color="indigo" />
                <ScoreMini label="AI-Score" value={(lead.quality_score || 0) / 100} color="indigo" />
            </div>

            {/* AI Analysis Section */}
            <div className="flex-grow flex flex-col mb-10">
                <div className="space-y-8">
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Situasjonsanalyse</span>
                            <div className="h-px flex-grow bg-slate-100"></div>
                        </div>
                        <div className="space-y-3">
                            <h3 className="text-lg font-bold text-slate-900 uppercase tracking-tight">
                                {translateTrigger(lead.trigger_hypothesis || 'LeadershipChange')}
                            </h3>
                            {/* Phase 6: Use structured situasjonsanalyse field */}
                            {lead.situasjonsanalyse && (
                                <p className="text-slate-700 text-base font-normal leading-relaxed">
                                    {lead.situasjonsanalyse}
                                </p>
                            )}
                            {!lead.situasjonsanalyse && lead.case_summary && (
                                <p className="text-slate-500 text-base font-normal leading-relaxed">
                                    {lead.case_summary}
                                </p>
                            )}
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Kildegrunnlag</span>
                            <div className="h-px flex-grow bg-slate-100"></div>
                        </div>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <SourceBadge type={lead.source_type || ''} />
                                <span className="text-slate-500 font-medium text-xs uppercase tracking-wider">
                                    {formatSourceType(lead.source_type)}
                                </span>
                            </div>
                            {lead.source_url && (
                                <a
                                    href={lead.source_url}
                                    target="_blank"
                                    className="text-slate-400 hover:text-indigo-600 text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 group/link transition-colors"
                                >
                                    Dokumentasjon
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                </a>
                            )}
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Strategisk begrunnelse</span>
                            <div className="h-px flex-grow bg-slate-100"></div>
                        </div>

                        {/* Show structured data for Brreg sources */}
                        {(lead.source_type === 'brreg_status_update' || lead.source_type === 'brreg_role_change') && (
                            <BrregEnrichmentDisplay lead={lead} />
                        )}

                        <blockquote className="border-l-2 border-indigo-600 pl-4 py-1">
                            <p className="text-slate-800 text-lg leading-relaxed font-light italic">
                                "{lead.strategisk_begrunnelse || lead.why_now_text || 'Analyse under utførelse. Systemet venter på mer kontekst.'}"
                            </p>
                        </blockquote>
                    </div>
                </div>
            </div>

            {/* Footer: Actions & Data Context */}
            <div className="mt-auto pt-8 border-t border-slate-100">
                <div className="flex flex-col gap-8">
                    <div className="flex items-center justify-between">
                        <div className="flex flex-wrap gap-3">
                            <ActionButton icon="kilde" label="Full rapport" href={lead.source_url} />
                            <ActionButton icon="proff" label="Proff-data" href={`https://www.proff.no/bransjesøk?q=${lead.org_number}`} />
                            <ActionButton icon="linkedin" label="Beslutningstakere" href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(lead.company_name)}`} />
                        </div>

                        <div className="flex items-center gap-3 px-3 py-1.5 bg-slate-50 rounded-lg border border-slate-100">
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Feedback</span>
                            <div className="flex items-center gap-2">
                                <FeedbackBtn leadId={lead.id!} grade="Relevant" current={lead.feedback_grade} color="indigo" />
                                <FeedbackBtn leadId={lead.id!} grade="Delvis" current={lead.feedback_grade} color="slate" />
                                <FeedbackBtn leadId={lead.id!} grade="Ikke" current={lead.feedback_grade} color="rose" />
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="text-[9px] font-bold text-slate-300 uppercase tracking-[0.3em] leading-none">
                            SYS-REF: {lead.id?.slice(-8).toUpperCase()} • PROCESSED {lead.created_at ? formatRelativeTime(lead.created_at).toUpperCase() : 'RECENTLY'}
                        </div>
                        <div className="flex items-center gap-2.5">
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest text-right">
                                Engine status: <span className="text-emerald-500">Nominal</span>
                            </span>
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 opacity-50"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function ScoreMini({ label, value, color, labelAlt }: { label: string; value: number; color: string; labelAlt?: string }) {
    const pct = Math.round(value * 100);
    const colors: Record<string, string> = {
        indigo: "bg-indigo-600",
        slate: "bg-slate-400",
        rose: "bg-rose-500"
    };

    return (
        <div className="space-y-3">
            <div className="flex justify-between items-end">
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-[0.2em]">{labelAlt || label}</span>
                <span className="text-[10px] font-bold text-slate-900 tabular-nums tracking-tighter">{pct}%</span>
            </div>
            <div className="h-1 w-full bg-slate-50 rounded-full overflow-hidden">
                <div
                    className={`h-full ${colors[color] || colors.indigo} rounded-full transition-all duration-1000 ease-out`}
                    style={{ width: `${pct}%` }}
                ></div>
            </div>
        </div>
    );
}

function ActionButton({ icon, label, href }: { icon: string; label: string; href?: string }) {
    if (!href) return null;
    return (
        <a
            href={href}
            target="_blank"
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-white border border-slate-200 text-slate-500 text-[11px] font-bold uppercase tracking-widest transition-all hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-100 shadow-sm btn-action"
        >
            <span className="text-xs">
                {icon === 'kilde' && '📄'}
                {icon === 'proff' && '📊'}
                {icon === 'linkedin' && '👥'}
            </span>
            {label}
        </a>
    );
}

function FeedbackBtn({ leadId, grade, current, color }: { leadId: string; grade: 'Relevant' | 'Delvis' | 'Ikke'; current?: string; color: string }) {
    const active = current === grade;
    const colors: Record<string, string> = {
        indigo: active ? "bg-indigo-600 text-white border-indigo-600 shadow-indigo-200" : "text-slate-400 hover:text-indigo-600 hover:bg-white",
        slate: active ? "bg-slate-500 text-white border-slate-500 shadow-slate-200" : "text-slate-400 hover:text-slate-600 hover:bg-white",
        rose: active ? "bg-rose-500 text-white border-rose-500 shadow-rose-200" : "text-slate-400 hover:text-rose-600 hover:bg-white",
    };

    return (
        <form action={`/api/feedback?id=${leadId}&grade=${grade}`} method="POST">
            <button
                className={`px-3 py-1.5 rounded-md text-[9px] font-bold uppercase tracking-widest border border-transparent transition-all ${colors[color]} ${active ? 'shadow-md translate-y-[-1px]' : 'opacity-80'}`}
            >
                {grade}
            </button>
        </form>
    );
}

// Helpers
function formatRelativeTime(date: string): string {
    const now = new Date();
    const then = new Date(date);
    const hours = Math.floor((now.getTime() - then.getTime()) / 3600000);

    if (hours < 1) return 'for <1t siden';
    if (hours < 24) return `for ${hours}t siden`;
    if (hours < 48) return 'i går';
    return then.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });
}

function translateTrigger(trigger: string): string {
    const mapping: Record<string, string> = {
        LeadershipChange: 'Lederskifte',
        Restructuring: 'Omstrukturering',
        MergersAcquisitions: 'Oppkjøp & Fusjoner',
        StrategicReview: 'Strategisk Gjennomgang',
        OperationalCrisis: 'Operasjonell Krise',
        RegulatoryLegal: 'Regulatoriske Endringer',
        CostProgram: 'Kostnadsprogram',
        HiringSignal: 'Rekrutteringssignal',
        OwnershipGovernance: 'Eierstyring',
        TransformationProgram: 'Transformasjon',
    };
    return mapping[trigger] || trigger;
}

function formatSourceType(source: string | undefined): string {
    if (!source) return 'Ukjent kilde';
    const mapping: Record<string, string> = {
        dn_rss: 'Dagens Næringsliv',
        e24_rss: 'E24',
        finansavisen_rss: 'Finansavisen',
        newsweb: 'NewsWeb (Oslo Børs)',
        brreg_update: 'Brønnøysundregistrene',
        brreg_status_update: 'Brønnøysund Statusoppdatering',
        finn: 'FINN.no',
        linkedin_exec: 'LinkedIn (Move)',
        linkedin_signal: 'LinkedIn (Signal)',
    };
    return mapping[source] || source;
}
