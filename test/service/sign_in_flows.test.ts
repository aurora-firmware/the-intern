import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    type AccountClock,
    type AccountStatusView,
    createAccountStatusHub,
} from "../../src/accounts/account_status.ts";
import type { AccountAuth, ProviderEndpoints } from "../../src/accounts/providers.ts";
import { createSecretsStore, type SecretsStore } from "../../src/accounts/secrets_store.ts";
import { type AccountsLayer, createAccountsLayer } from "../../src/accounts/sign_in.ts";
import { type FakeOAuthProvider, startFakeOAuthProvider } from "../support/fake_oauth_provider.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const OWNER = "mail";
const NAME = "work";
const KEY = `${OWNER}/${NAME}`;
const SCOPES = ["offline_access"];
const START = new Date("2026-11-19T10:00:00Z");
const SECOND_MS = 1000;
const WAIT_LIMIT_MS = scaled(10_000);
const STEP_MS = 5;

const microsoftAuth: AccountAuth = {
    key: KEY,
    kind: "microsoft",
    login: "bob@contoso.test",
    clientId: "client-1",
    tenant: "contoso",
};

type ManualClock = AccountClock & { advance(ms: number): void };

/** A clock that moves only when the test advances it; a wait settles when the time reaches it or its signal aborts. */
function manualClock(): ManualClock {
    let current = START.getTime();
    const waits = new Set<{ until: number; settle: () => void }>();
    return {
        now: () => new Date(current),
        wait(until, signal) {
            return new Promise<void>((resolve) => {
                const entry = { until: until.getTime(), settle: () => {} };
                entry.settle = () => {
                    waits.delete(entry);
                    resolve();
                };
                waits.add(entry);
                signal.addEventListener("abort", entry.settle, { once: true });
                if (signal.aborted) entry.settle();
            });
        },
        advance(ms) {
            current += ms;
            for (const entry of [...waits]) if (entry.until <= current) entry.settle();
        },
    };
}

async function until(condition: () => boolean, what: string, onTick: () => void = () => {}): Promise<void> {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        onTick();
        await new Promise((resolve) => setTimeout(resolve, STEP_MS));
    }
}

/** A provider that answers a device code request and then refuses the sign-in. */
async function startRefusingProvider(): Promise<{ endpoints: ProviderEndpoints; stop(): Promise<void> }> {
    const server = http.createServer((request, response) => {
        request.resume();
        const isDeviceCode = (request.url ?? "").endsWith("/devicecode");
        response.writeHead(isDeviceCode ? 200 : 400, { "content-type": "application/json" });
        response.end(
            JSON.stringify(
                isDeviceCode
                    ? {
                          device_code: "d1",
                          user_code: "U1",
                          verification_uri: "https://example.test/devicelogin",
                          expires_in: 900,
                          interval: 1,
                      }
                    : { error: "access_denied", error_description: "The team member refused the sign-in." },
            ),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        endpoints: { microsoftBase: base, googleAuthorize: `${base}/auth`, googleToken: `${base}/token` },
        stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

describe("Signing in with a device code or a loopback answer", () => {
    let hermetic: HermeticEnv;
    let secrets: SecretsStore;
    let fake: FakeOAuthProvider;
    let clock: ManualClock;
    let layer: AccountsLayer;
    let failures: AccountStatusView[];

    function layerFor(endpoints: ProviderEndpoints): AccountsLayer {
        const status = createAccountStatusHub({ clock });
        status.start(OWNER, NAME, { checkIntervalSeconds: 60, needsSignIn: true, retry: () => {} });
        status.onChange((view) => {
            if (view.lastError) failures.push(view);
        });
        return createAccountsLayer({ secrets, status, endpoints, clock });
    }

    beforeEach(async () => {
        hermetic = await createHermeticEnv();
        const secretsDir = join(hermetic.root, "secrets");
        await mkdir(secretsDir, { mode: 0o700 });
        secrets = createSecretsStore({ secretsDir });
        fake = await startFakeOAuthProvider({ accessTokenSeconds: 3600 });
        clock = manualClock();
        failures = [];
        layer = layerFor(fake.endpoints);
    });

    afterEach(async () => {
        await fake.stop();
        await hermetic.dispose();
    });

    describe("with Microsoft", () => {
        it("returns the code and the address at once, then stores the tokens and calls onSignedIn when the code is entered", async () => {
            let signedIn = 0;
            const start = await layer.startSignIn(microsoftAuth, SCOPES, () => {
                signedIn += 1;
            });
            assert.equal(start.kind, "device_code");
            if (start.kind !== "device_code") return;
            assert.equal(start.address, `${fake.endpoints.microsoftBase}/devicelogin`);
            assert.equal(signedIn, 0);
            assert.equal((await secrets.read(KEY))?.refreshToken, undefined);

            fake.enterCode(start.code);
            await until(
                () => signedIn > 0,
                "onSignedIn",
                () => clock.advance(SECOND_MS),
            );

            const stored = await secrets.read(KEY);
            assert.ok(stored?.refreshToken, "the refresh token is stored");
            assert.ok(stored.accessToken && fake.isValidAccessToken(stored.accessToken), "the access token is valid");
            const signedAt = (stored.accessTokenExpiresAt ?? 0) - 3600 * SECOND_MS;
            assert.ok(signedAt >= START.getTime() && signedAt <= clock.now().getTime(), "the lifetime is the clock's");
            assert.equal(signedIn, 1);
        });

        it("writes nothing and leaves the account needing sign-in when the code expires", async () => {
            let signedIn = 0;
            await layer.startSignIn(microsoftAuth, SCOPES, () => {
                signedIn += 1;
            });
            await until(
                () => failures.length > 0,
                "the failure",
                () => clock.advance(901 * SECOND_MS),
            );
            assert.equal(failures[0]?.status, "needs_sign_in");
            assert.equal(await secrets.read(KEY), undefined);
            assert.equal(signedIn, 0);
        });

        it("writes nothing and leaves the account needing sign-in when the provider refuses the sign-in", async () => {
            const refusing = await startRefusingProvider();
            try {
                const own = layerFor(refusing.endpoints);
                let signedIn = 0;
                await own.startSignIn(microsoftAuth, SCOPES, () => {
                    signedIn += 1;
                });
                await until(
                    () => failures.length > 0,
                    "the failure",
                    () => clock.advance(SECOND_MS),
                );
                assert.equal(failures[0]?.status, "needs_sign_in");
                assert.match(failures[0]?.lastError?.message ?? "", /refused the sign-in/);
                assert.equal(await secrets.read(KEY), undefined);
                assert.equal(signedIn, 0);
            } finally {
                await refusing.stop();
            }
        });

        it("ends the first sign-in of an account when a second starts", async () => {
            const signedIn: string[] = [];
            const first = await layer.startSignIn(microsoftAuth, SCOPES, () => {
                signedIn.push("first");
            });
            const second = await layer.startSignIn(microsoftAuth, SCOPES, () => {
                signedIn.push("second");
            });
            assert.ok(first.kind === "device_code" && second.kind === "device_code");
            if (first.kind !== "device_code" || second.kind !== "device_code") return;

            fake.enterCode(first.code);
            fake.enterCode(second.code);
            await until(
                () => signedIn.length > 0,
                "onSignedIn",
                () => clock.advance(SECOND_MS),
            );

            assert.deepEqual(signedIn, ["second"]);
            const polled = fake.requests().filter((r) => r.body.grant_type?.endsWith("device_code"));
            assert.equal(new Set(polled.map((r) => r.body.device_code)).size, 1, "only one device code is polled");
        });
    });
});
