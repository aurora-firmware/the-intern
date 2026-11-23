import type { Browser, BrowserContext } from "playwright-core";

/**
 * Runs `use` in a browser context of its own and closes it afterwards. A context starts with no cache, so what it
 * measures is a cold open, and an earlier attempt leaves nothing behind that makes a later one faster or heavier.
 */
export async function withColdContext<T>(browser: Browser, use: (context: BrowserContext) => Promise<T>): Promise<T> {
    const context = await browser.newContext();
    try {
        return await use(context);
    } finally {
        await context.close();
    }
}
