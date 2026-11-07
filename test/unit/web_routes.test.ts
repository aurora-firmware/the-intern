import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRoute, routeHash } from "../../web/ui/model/routes.ts";

describe("parseRoute", () => {
    it("answers the board for an empty hash", () => {
        assert.deepEqual(parseRoute(""), { page: "board" });
    });

    it("answers the board for a bare hash and for #/", () => {
        assert.deepEqual(parseRoute("#"), { page: "board" });
        assert.deepEqual(parseRoute("#/"), { page: "board" });
    });

    it("answers the job route with its short number", () => {
        assert.deepEqual(parseRoute("#/jobs/W-3"), { page: "job", number: "W-3" });
    });

    it("answers each other page's route", () => {
        assert.deepEqual(parseRoute("#/desk"), { page: "desk" });
        assert.deepEqual(parseRoute("#/roles"), { page: "roles" });
        assert.deepEqual(parseRoute("#/workspaces"), { page: "workspaces" });
        assert.deepEqual(parseRoute("#/status"), { page: "status" });
    });

    it("answers unknown for any other hash", () => {
        for (const hash of ["#/nope", "#/jobs", "#/jobs/", "#/jobs/W-3/x", "#/desk/x", "#desk", "#/Desk", "x"]) {
            assert.deepEqual(parseRoute(hash), { page: "unknown" }, hash);
        }
    });
});

describe("routeHash", () => {
    it("gives the same page again for every address", () => {
        for (const hash of ["#/", "#/jobs/W-3", "#/desk", "#/roles", "#/workspaces", "#/status"]) {
            assert.deepEqual(parseRoute(routeHash(parseRoute(hash))), parseRoute(hash), hash);
        }
    });

    it("writes the address of each page", () => {
        assert.equal(routeHash({ page: "board" }), "#/");
        assert.equal(routeHash({ page: "job", number: "W-3" }), "#/jobs/W-3");
        assert.equal(routeHash({ page: "desk" }), "#/desk");
        assert.equal(routeHash({ page: "unknown" }), "#/");
    });
});
