import FirecrawlApp from '@mendable/firecrawl-js';

const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

// ============================================
// CREDIT BUDGET - prevents runaway scraping
// ============================================
const FIRECRAWL_BUDGET_PER_RUN = 100; // Max credits per pipeline run
let creditsUsed = 0;
let budgetResetTime = 0;

/**
 * Reset the credit counter (call at start of each pipeline run)
 */
export function resetFirecrawlBudget() {
    creditsUsed = 0;
    budgetResetTime = Date.now();
    console.log(`🔄 Firecrawl budget reset: 0/${FIRECRAWL_BUDGET_PER_RUN}`);
}

/**
 * Check remaining Firecrawl credits for this run
 */
export function getFirecrawlBudgetRemaining(): number {
    return Math.max(0, FIRECRAWL_BUDGET_PER_RUN - creditsUsed);
}

/**
 * Get current credit usage stats
 */
export function getFirecrawlStats() {
    return {
        credits_used: creditsUsed,
        budget: FIRECRAWL_BUDGET_PER_RUN,
        remaining: getFirecrawlBudgetRemaining(),
        budget_reset_at: new Date(budgetResetTime).toISOString(),
    };
}

export interface ScrapeResult {
    success: boolean;
    content?: string;
    metadata?: any;
    error?: string;
}

/**
 * Scrape a specific URL (e.g. Finn.no or company press room)
 * Respects per-run credit budget to prevent runaway costs.
 */
export async function scrapeUrl(url: string): Promise<ScrapeResult> {
    // Auto-reset if budget was set more than 10 minutes ago (stale state in serverless)
    if (budgetResetTime > 0 && Date.now() - budgetResetTime > 10 * 60 * 1000) {
        resetFirecrawlBudget();
    }

    // Check budget before scraping
    if (creditsUsed >= FIRECRAWL_BUDGET_PER_RUN) {
        console.warn(`🛑 Firecrawl budget exhausted (${creditsUsed}/${FIRECRAWL_BUDGET_PER_RUN}). Skipping: ${url}`);
        return {
            success: false,
            error: `Firecrawl budget exhausted (${creditsUsed}/${FIRECRAWL_BUDGET_PER_RUN} credits used)`,
        };
    }

    creditsUsed++;
    console.log(`🔥 Firecrawl credit ${creditsUsed}/${FIRECRAWL_BUDGET_PER_RUN}: ${url.slice(0, 80)}...`);

    try {
        const scrapeResponse = await app.scrape(url, {
            formats: ['markdown'],
        });

        if (!scrapeResponse || !scrapeResponse.markdown) {
            return {
                success: false,
                error: 'Scrape returned empty content',
            };
        }

        return {
            success: true,
            content: scrapeResponse.markdown,
            metadata: scrapeResponse.metadata,
        };
    } catch (error) {
        console.error('Firecrawl scrape error:', error);
        return {
            success: false,
            error: String(error),
        };
    }
}

/**
 * Crawl a company's press or news section
 */
export async function crawlPressRoom(baseUrl: string): Promise<ScrapeResult[]> {
    try {
        // Simple crawl to find recent news items
        const crawlResponse = await app.crawl(baseUrl, {
            limit: 5,
            scrapeOptions: {
                formats: ['markdown'],
            },
        });

        if (!crawlResponse) {
            throw new Error('Crawl failed: No response');
        }

        return [];
    } catch (error) {
        console.error('Firecrawl crawl error:', error);
        return [];
    }
}
