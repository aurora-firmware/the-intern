import type { Page } from "playwright-core";

type Held = { isRead: Promise<void>; release: () => void };

/**
 * Holds the response of the next call a page makes to `operation`: the service is asked at once, so the answer is
 * the data as of that moment, and the page gets it only after `release`. Later calls pass through. With `refusal`,
 * the page gets that refusal (status 400) when released instead of the answer.
 */
export function holdNextRead(page: Page, port: number, operation: string, refusal?: string): Held {
    let markRead: () => void = () => undefined;
    let release: () => void = () => undefined;
    const isRead = new Promise<void>((resolve) => {
        markRead = resolve;
    });
    const isReleased = new Promise<void>((resolve) => {
        release = resolve;
    });
    let isHeld = false;
    void page.route(`**/operations/${operation}`, async (route) => {
        if (isHeld) return route.fallback();
        isHeld = true;
        // `route.fetch()` can't resolve the test host, so the service is asked at its loopback address.
        const answer = await fetch(`http://127.0.0.1:${port}/operations/${operation}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: route.request().postData() ?? "{}",
        });
        const body = await answer.text();
        markRead();
        await isReleased;
        if (refusal !== undefined) {
            await route.fulfill({ status: 400, json: { error: { code: "invalid_input", message: refusal } } });
            return;
        }
        await route.fulfill({ status: answer.status, contentType: "application/json", body });
    });
    return { isRead, release };
}

/** Two animation frames: whatever the page does with a response it got has been shown by then. */
export const afterTwoFrames = (page: Page): Promise<unknown> =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
