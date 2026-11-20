/**
 * The mail account status on the instance feed and in `daemon.status` (S-002 REQ-012, REQ-014; S-009 REQ-005): the
 * accounts layer's hub comes into the daemon from outside, each change of a mail account is one `mail_account_status`
 * delta in the feed's sequence, and the status operation lists the accounts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type AccountClock, type AccountStatusHub, createAccountStatusHub } from "../../src/accounts/account_status.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { InstanceDelta } from "../../src/feed/instance_feed.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_TIMEOUT_MS = scaled(10_000);
const POLL_INTERVAL_MS = 10;
const TEAM_MEMBER: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const NOW = new Date("2026-11-19T10:00:00.000Z");
const START = { checkIntervalSeconds: 60, needsSignIn: false, retry: () => {} };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

const fixedClock: AccountClock = { now: () => NOW, wait: () => new Promise(() => {}) };

type Fixture = {
    context: ServiceContext;
    daemon: RunningDaemon;
    status(): Promise<{ mailAccounts: unknown }>;
};

async function startDaemon(accountStatus: AccountStatusHub | undefined): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: createLogger({ verbose: false, stream: { write: () => true } }),
        components: [{ name: "capture", start: async (ctx) => void (captured = ctx) }],
        ...(accountStatus && { accountStatus }),
    });
    daemons.push(daemon);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (daemon.phase() !== "ready" || !captured) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the daemon to be ready");
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return {
        context: captured,
        daemon,
        status: async () => (await daemon.catalogue.invoke("daemon.status", {}, TEAM_MEMBER)) as { mailAccounts: unknown },
    };
}

async function nextDelta(subscription: ReturnType<ServiceContext["instanceFeed"]["subscribe"]>): Promise<InstanceDelta> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for the next delta")), WAIT_TIMEOUT_MS);
    });
    try {
        const result = await Promise.race([subscription.next(), timeout]);
        assert.ok("delta" in result, "the subscription stays open");
        return result.delta;
    } finally {
        clearTimeout(timer);
    }
}

describe("mail account status on the instance feed", () => {
    it("publishes one mail_account_status delta per change, with the error and last check, in the feed's sequence", async () => {
        const hub = createAccountStatusHub({ clock: fixedClock });
        const { context } = await startDaemon(hub);
        const subscription = context.instanceFeed.subscribe();
        hub.start("mail", "work", START);
        hub.report("mail", "work", { kind: "needs_sign_in", message: "token expired" });
        const first = await nextDelta(subscription);
        const second = await nextDelta(subscription);
        assert.deepEqual(first, { seq: 1, type: "mail_account_status", name: "work", status: "connecting" });
        assert.deepEqual(second, {
            seq: 2,
            type: "mail_account_status",
            name: "work",
            status: "needs_sign_in",
            lastError: { message: "token expired", at: NOW.toISOString() },
            lastCheck: NOW.toISOString(),
        });
        subscription.close();
    });

    it("publishes nothing for an account of another owner", async () => {
        const hub = createAccountStatusHub({ clock: fixedClock });
        const { context } = await startDaemon(hub);
        const subscription = context.instanceFeed.subscribe();
        hub.start("other", "x", START);
        hub.start("mail", "work", START);
        const delta = await nextDelta(subscription);
        assert.equal(delta.type === "mail_account_status" && delta.name, "work");
        subscription.close();
    });

    it("follows a new subscriber's snapshot only with later deltas, never replaying earlier changes", async () => {
        const hub = createAccountStatusHub({ clock: fixedClock });
        const { context } = await startDaemon(hub);
        hub.start("mail", "work", START);
        const subscription = context.instanceFeed.subscribe();
        hub.report("mail", "work", { kind: "ready" });
        const delta = await nextDelta(subscription);
        assert.deepEqual(delta, {
            seq: 1,
            type: "mail_account_status",
            name: "work",
            status: "ready",
            lastCheck: NOW.toISOString(),
        });
        subscription.close();
    });

    it("publishes no mail_account_status delta when the daemon runs without a hub", async () => {
        const { context } = await startDaemon(undefined);
        const subscription = context.instanceFeed.subscribe();
        createAccountStatusHub({ clock: fixedClock }).start("mail", "work", START);
        context.fileChanges.publish({ path: "/x", kind: "role" });
        const delta = await nextDelta(subscription);
        assert.equal(delta.type, "files_changed");
        subscription.close();
    });
});

describe("daemon.status mailAccounts", () => {
    it("lists each mail account with its status, last error with its time, and last check", async () => {
        const hub = createAccountStatusHub({ clock: fixedClock });
        hub.start("mail", "work", START);
        hub.report("mail", "work", { kind: "needs_sign_in", message: "token expired" });
        hub.start("mail", "home", START);
        hub.start("other", "x", START);
        const { status } = await startDaemon(hub);
        const { mailAccounts } = await status();
        assert.deepEqual(mailAccounts, [
            {
                name: "work",
                status: "needs_sign_in",
                lastError: { message: "token expired", at: NOW.toISOString() },
                lastCheck: NOW.toISOString(),
            },
            { name: "home", status: "connecting" },
        ]);
    });

    it("reports an empty list without a hub", async () => {
        const { status } = await startDaemon(undefined);
        assert.deepEqual((await status()).mailAccounts, []);
    });
});
