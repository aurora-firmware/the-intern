/**
 * The client library without a daemon (S-003 REQ-009): the default socket is the daemon's, resolved from the runtime
 * directory, and a call that no daemon answers fails with `UnreachableError` naming where it went (AC-009.2).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultSocketPath } from "../../src/client/node_transport.ts";

const HOME = "/home/team";

describe("defaultSocketPath", () => {
    it("is bob.sock in the runtime directory under XDG_RUNTIME_DIR", () => {
        const path = defaultSocketPath({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, homeDir: HOME });
        assert.equal(path, "/run/user/1000/the-intern/bob.sock");
    });

    it("falls back to the runtime directory inside the state directory when XDG_RUNTIME_DIR is unset", () => {
        const path = defaultSocketPath({ env: { XDG_STATE_HOME: "/xdg/state" }, homeDir: HOME });
        assert.equal(path, "/xdg/state/the-intern/run/bob.sock");
    });

    it("uses a runtime directory given as an option, as the daemon's flag does", () => {
        const path = defaultSocketPath({
            env: { XDG_RUNTIME_DIR: "/run/user/1000" },
            homeDir: HOME,
            runtimeDir: "/srv/bob/run",
        });
        assert.equal(path, "/srv/bob/run/bob.sock");
    });
});
