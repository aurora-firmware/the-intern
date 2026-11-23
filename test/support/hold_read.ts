import type { Page, Request, Route } from "playwright-core";
import { scaled } from "./time_scale.ts";

const SETTLE_TIMEOUT_MS = scaled(30_000);
const SETTLE_POLL_MS = 20;

type Held = { isRead: Promise<void>; release: () => void };

/**
 * Holds the response of the next call a page makes to `operation`: the service is asked at once, so the answer is
 * the data as of that moment, and the page gets it only after `release`. Later calls pass through. With `refusal`,
 * the page gets that refusal (status 400) when released instead of the answer.
 */
export async function holdNextRead(page: Page, port: number, operation: string, refusal?: string): Promise<Held> {
    let markRead: () => void = () => undefined;
    let release: () => void = () => undefined;
    const isRead = new Promise<void>((resolve, reject) => {
        markRead = resolve;
        setTimeout(() => reject(new Error(`the page made no call to ${operation}`)), SETTLE_TIMEOUT_MS).unref();
    });
    const isReleased = new Promise<void>((resolve) => {
        release = resolve;
    });
    let isHeld = false;
    await page.route(`**/operations/${operation}`, async (route) => {
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

/**
 * Counts the page's calls to the service that have started and not finished. A read makes several calls one after the
 * other, so `settled` waits until none is under way, and then for two animation frames, which is when the page has
 * shown what the last read gave it; it checks again that no new call started meanwhile. `heldCalls` is the number of
 * calls the test holds on purpose, which are not waited for.
 */
export function trackOperations(page: Page): { settled: (heldCalls?: number) => Promise<void> } {
    const underWay = new Set<Request>();
    const isOperation = (url: string) => url.includes("/operations/");
    page.on("request", (request) => {
        if (isOperation(request.url())) underWay.add(request);
    });
    const finish = (request: Request) => underWay.delete(request);
    page.on("requestfinished", finish);
    page.on("requestfailed", finish);
    const settled = async (heldCalls = 0): Promise<void> => {
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        for (;;) {
            while (underWay.size > heldCalls) {
                if (Date.now() > deadline) throw new Error("the page's calls to the service did not finish");
                await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
            }
            await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            if (underWay.size <= heldCalls) return;
        }
    };
    return { settled };
}

/**
 * Answers every call the page makes to the service from now on with a refusal (status 400), until the returned
 * function lifts it. Calls already held are not touched.
 */
export async function refuseOperations(page: Page, refusal: string): Promise<() => Promise<void>> {
    const handler = (route: Route) =>
        route.fulfill({ status: 400, json: { error: { code: "invalid_input", message: refusal } } });
    await page.route("**/operations/*", handler);
    return () => page.unroute("**/operations/*", handler);
}
