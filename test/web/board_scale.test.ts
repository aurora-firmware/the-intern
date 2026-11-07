import { afterEach, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { bestOf } from "../support/best_of.ts";
import { type BrowserName, launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { type FeedWatch, watchFeed } from "../support/feed_watch.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const BROWSERS: BrowserName[] = ["chrome", "msedge", "firefox"];
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 180_000;
const CHANGE_LIMIT_MS = 2000;
const PAGE_OPEN_LIMIT_MS = 3000;
const INTERACTION_LIMIT_MS = 500;
const JOB_COUNT = 500;
const ATTEMPTS = 3;
const BOARD_STATUS = "main .board-column[data-status='done']";
const JOB_STATUS = "main .job-field[data-field='status'] .job-value";

type Job = { id: string; number: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const watches: FeedWatch[] = [];

afterEach(async () => {
    for (const watch of watches.splice(0)) watch.close();
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startRig(jobCount: number): Promise<{ daemon: DaemonProcess; port: number; jobs: Job[] }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const jobs: Job[] = [];
    for (let index = 0; index < jobCount; index++) {
        jobs.push((await daemon.invoke("jobs.create", { text: `job ${index}` })) as Job);
    }
    return { daemon, port: await daemon.networkPort(), jobs };
}

/** The milliseconds from `startedAt` until the condition holds in the page, checked on every frame. */
async function msUntil(page: Page, startedAt: number, condition: string, arg?: unknown): Promise<number> {
    await page.waitForFunction(condition, arg, { timeout: WAIT_MS, polling: "raf" });
    return Date.now() - startedAt;
}

const cardCount = (count: number) => `document.querySelectorAll("main .board-card").length === ${count}`;

function expectWithin(t: TestContext, what: string, elapsedMs: number, limitMs: number): void {
    t.assert.ok(elapsedMs <= limitMs, `${what} took ${elapsedMs} ms, over the ${limitMs} ms limit`);
}

for (const name of BROWSERS) {
    describe(`timeliness and a full board in ${name}`, () => {
        it("shows a status change on the Board and the Job page within 2 seconds of the feed event", {
            timeout: TEST_TIMEOUT_MS,
        }, async (t) => {
            const { daemon, port, jobs } = await startRig(2);
            const job = jobs[0] as Job;
            const browser = await launchBrowser(t, name);
            if (browser === undefined) return;
            const context = await browser.newContext();
            const board = await context.newPage();
            await board.goto(pageUrl(port, "/ui/#/"));
            await board.waitForSelector(`main .board-card a[href='#/jobs/${job.number}']`, { timeout: WAIT_MS });
            const jobPage = await context.newPage();
            await jobPage.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));
            await jobPage.waitForSelector(JOB_STATUS, { timeout: WAIT_MS });
            const feed = await watchFeed(port);
            watches.push(feed);

            const event = feed.nextDelta((delta) => delta.type === "job_done" && delta.number === job.number);
            await daemon.invoke("jobs.cancel", { job: job.id, justification: "not needed" });
            const { readAt } = await event;

            const onBoard = await msUntil(
                board,
                readAt,
                `!!document.querySelector("${BOARD_STATUS} a[href='#/jobs/${job.number}']")`,
            );
            const onJobPage = await msUntil(
                jobPage,
                readAt,
                `document.querySelector("${JOB_STATUS}")?.textContent === "Done"`,
            );

            expectWithin(t, "The Board showing the change", onBoard, CHANGE_LIMIT_MS);
            expectWithin(t, "The Job page showing the change", onJobPage, CHANGE_LIMIT_MS);
        });

        it("opens a Board of 500 jobs within 3 seconds and a job from it, the click answering within 500 ms", {
            timeout: TEST_TIMEOUT_MS,
        }, async (t) => {
            const { port, jobs } = await startRig(JOB_COUNT);
            const job = jobs[JOB_COUNT - 1] as Job;
            const browser = await launchBrowser(t, name);
            if (browser === undefined) return;
            const context = await browser.newContext();
            let page = await context.newPage();

            const boardOpened = await bestOf(
                ATTEMPTS,
                async () => {
                    page = await context.newPage();
                    const openingStarted = Date.now();
                    await page.goto(pageUrl(port, "/ui/#/"));
                    return msUntil(page, openingStarted, cardCount(JOB_COUNT));
                },
                PAGE_OPEN_LIMIT_MS,
            );
            const jobShown = await bestOf(
                ATTEMPTS,
                async () => {
                    await page.waitForFunction(cardCount(JOB_COUNT), undefined, { timeout: WAIT_MS });
                    const clickStarted = Date.now();
                    await page.locator(`main .board-card a[href='#/jobs/${job.number}']`).click();
                    const elapsed = await msUntil(page, clickStarted, `!!document.querySelector("${JOB_STATUS}")`);
                    t.assert.equal(await page.locator("main .job-number").textContent(), job.number);
                    await page.goBack();
                    return elapsed;
                },
                INTERACTION_LIMIT_MS,
            );

            expectWithin(t, "Opening the Board", boardOpened, PAGE_OPEN_LIMIT_MS);
            expectWithin(t, "Opening the job page", jobShown, PAGE_OPEN_LIMIT_MS);
            expectWithin(t, "The click on a job", jobShown, INTERACTION_LIMIT_MS);
        });
    });
}
