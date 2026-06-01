import fs from 'fs';
import path from 'path';

// Define the scoring weights interface
export interface ScoreWeights {
    E0: number;
    W0: number;
    R0: number;
}

export type ScoringConfig = Record<string, ScoreWeights>;

// ============================================
// SOURCE BASE SCORES
// ============================================
// Differentiated per source type based on signal quality.
// Brreg sources kept at RSS baseline (used for verification, not as stronger signal).
const DEFAULT_SCORES: ScoringConfig = {
    // Brreg: verification-only, same baseline as RSS
    bronnysund: { E0: 0.50, W0: 0.40, R0: 0.30 },
    brreg_status_update: { E0: 0.50, W0: 0.40, R0: 0.30 },
    brreg_role_change: { E0: 0.50, W0: 0.40, R0: 0.30 },
    brreg_kunngjoringer: { E0: 0.50, W0: 0.40, R0: 0.30 },

    // Stock exchange announcements (high reliability, regulated disclosure)
    newsweb: { E0: 0.75, W0: 0.65, R0: 0.15 },

    // Company press rooms / IR pages (first-party, but may be PR-spun)
    mynewsdesk: { E0: 0.65, W0: 0.55, R0: 0.20 },

    // News RSS feeds (journalistic sources, varying depth)
    dn_rss: { E0: 0.50, W0: 0.40, R0: 0.30 },
    e24: { E0: 0.50, W0: 0.40, R0: 0.30 },
    finansavisen: { E0: 0.50, W0: 0.40, R0: 0.30 },
    ntb: { E0: 0.50, W0: 0.40, R0: 0.30 },
    rett24_rss: { E0: 0.50, W0: 0.40, R0: 0.30 },
    digi_rss: { E0: 0.50, W0: 0.40, R0: 0.30 },

    // FINN job listings (weak interim signal, hiring ≠ crisis)
    finn: { E0: 0.40, W0: 0.60, R0: 0.25 },

    // LinkedIn (assisted input, lower reliability)
    linkedin_exec_move: { E0: 0.35, W0: 0.45, R0: 0.35 },
    linkedin_company_signal: { E0: 0.30, W0: 0.25, R0: 0.40 },

    // Fallback for unknown sources
    default: { E0: 0.40, W0: 0.35, R0: 0.35 },
};

// ============================================
// TRIGGER MODIFIERS
// ============================================
// Applied on top of source base scores. Higher-urgency triggers get bigger E/W boosts.
// Capped at 1.0. R is NOT affected by trigger modifiers.
export interface TriggerModifier {
    E_boost: number;
    W_boost: number;
}

export const TRIGGER_MODIFIERS: Record<string, TriggerModifier> = {
    LeadershipChange:          { E_boost: 0.20, W_boost: 0.30 },  // CEO departure = most actionable
    OperationalCrisis:         { E_boost: 0.15, W_boost: 0.25 },  // Production halt, contract loss
    MergersAcquisitions:       { E_boost: 0.10, W_boost: 0.20 },  // Carve-out, PE entry
    RegulatoryLegal:           { E_boost: 0.10, W_boost: 0.15 },  // Sanctions, compliance failures
    OwnershipGovernance:       { E_boost: 0.10, W_boost: 0.15 },  // Board/ownership changes
    RestructuringInsolvency:   { E_boost: 0.05, W_boost: 0.15 },  // Konkurs, rekonstruksjon
    Restructuring:             { E_boost: 0.05, W_boost: 0.15 },  // Alias for RestructuringInsolvency
    CostProgram:               { E_boost: 0.05, W_boost: 0.10 },  // Nedbemanning, effektivisering
    TransformationProgram:     { E_boost: 0.05, W_boost: 0.10 },  // ERP, org change
    StrategicReview:           { E_boost: 0.05, W_boost: 0.10 },  // Strategic alternatives
    HiringSignal:              { E_boost: 0.00, W_boost: 0.10 },  // CxO vacancy on Finn.no
};

// LinkedIn LeadershipChange uses reduced modifier (new-hire announcement is weaker than departure)
export const LINKEDIN_LEADERSHIP_MODIFIER: TriggerModifier = { E_boost: 0.10, W_boost: 0.15 };

/**
 * Get trigger modifier for a given trigger type and source.
 * Returns {E_boost: 0, W_boost: 0} for unknown triggers.
 */
export function getTriggerModifier(trigger: string, sourceType?: string): TriggerModifier {
    // LinkedIn LeadershipChange uses reduced modifier
    if (trigger === 'LeadershipChange' && sourceType?.startsWith('linkedin')) {
        return LINKEDIN_LEADERSHIP_MODIFIER;
    }
    return TRIGGER_MODIFIERS[trigger] || { E_boost: 0, W_boost: 0 };
}

/**
 * Compute start scores: source base + trigger modifier, capped at 1.0.
 * R is not affected by trigger modifiers.
 */
export function computeStartScores(
    sourceWeights: ScoreWeights,
    trigger: string,
    sourceType?: string,
): { E: number; W: number; R: number } {
    const modifier = getTriggerModifier(trigger, sourceType);
    return {
        E: Math.min(1.0, sourceWeights.E0 + modifier.E_boost),
        W: Math.min(1.0, sourceWeights.W0 + modifier.W_boost),
        R: sourceWeights.R0,  // Trigger modifiers do not affect R
    };
}

const STATE_FILE_PATH = path.join(process.cwd(), 'src/config/scoring-state.json');

/**
 * Get current scoring weights.
 * Reads from scoring-state.json if it exists, otherwise returns defaults.
 */
export function getScoringWeights(): ScoringConfig {
    if (fs.existsSync(STATE_FILE_PATH)) {
        try {
            const raw = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
            return JSON.parse(raw) as ScoringConfig;
        } catch (error) {
            console.error('Failed to read scoring-state.json, using defaults', error);
        }
    }
    return JSON.parse(JSON.stringify(DEFAULT_SCORES)); // Return deep copy
}

/**
 * Update scoring weights and persist to disk.
 */
export function updateScoringWeights(newWeights: ScoringConfig): void {
    try {
        // Ensure directory exists
        const dir = path.dirname(STATE_FILE_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(newWeights, null, 2));
        console.log('Scoring weights updated and saved to scoring-state.json');
    } catch (error) {
        console.error('Failed to save scoring weights:', error);
        throw error;
    }
}

/**
 * Reset weights to defaults (useful for rollback)
 */
export function resetScoringWeights(): void {
    updateScoringWeights(DEFAULT_SCORES);
}
