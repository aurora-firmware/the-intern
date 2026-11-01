import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigValueError } from "../../src/config/config_file.ts";
import { networkSection } from "../../src/listeners/network_section.ts";

const failure = (run: () => unknown): ConfigValueError => {
    try {
        run();
    } catch (error) {
        assert.ok(error instanceof ConfigValueError, `expected ConfigValueError, got ${String(error)}`);
        return error;
    }
    throw new Error("expected ConfigValueError");
};

describe("networkSection", () => {
    it("is named network", () => {
        assert.equal(networkSection.name, "network");
    });

    it("defaults to undefined when the section is absent", () => {
        assert.equal(networkSection.defaults(), undefined);
    });

    it("loads a valid address and port unchanged", () => {
        assert.deepEqual(networkSection.parse({ address: "192.168.1.5", port: 8080 }), {
            address: "192.168.1.5",
            port: 8080,
        });
        assert.deepEqual(networkSection.parse({ address: "bob.example.org", port: 65535 }), {
            address: "bob.example.org",
            port: 65535,
        });
    });

    it("serializes to a table that parses back to the same value", () => {
        const value = networkSection.parse({ address: "::1", port: 1 });
        assert.deepEqual(networkSection.parse(networkSection.serialize(value)), value);
    });

    it("serializes an absent section to the same table as its default", () => {
        assert.deepEqual(networkSection.serialize(undefined), networkSection.serialize(networkSection.defaults()));
    });

    it("refuses a section without an address, naming address", () => {
        assert.equal(failure(() => networkSection.parse({ port: 8080 })).key, "address");
    });

    it("refuses a section without a port, naming port", () => {
        assert.equal(failure(() => networkSection.parse({ address: "localhost" })).key, "port");
    });

    it("refuses an empty address, naming address", () => {
        assert.equal(failure(() => networkSection.parse({ address: "", port: 8080 })).key, "address");
    });

    it("refuses an address that is not a string, naming address", () => {
        assert.equal(failure(() => networkSection.parse({ address: 5, port: 8080 })).key, "address");
    });

    for (const port of [0, 65536, -1, 80.5, "8080", Number.NaN]) {
        it(`refuses the port ${JSON.stringify(port)}, naming port`, () => {
            const error = failure(() => networkSection.parse({ address: "localhost", port }));
            assert.equal(error.key, "port");
            assert.notEqual(error.reason, "");
        });
    }

    it("refuses an unknown key, naming it", () => {
        assert.equal(failure(() => networkSection.parse({ address: "localhost", port: 80, tls: true })).key, "tls");
    });

    it("refuses a section that is not a table", () => {
        assert.equal(failure(() => networkSection.parse([1])).key, "network");
    });
});
