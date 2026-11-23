import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger } from "../../src/daemon/logger.ts";

const FIXED_TIME = Date.UTC(2026, 9, 31, 12, 30, 45, 123);
const FIXED_STAMP = "2026-10-31T12:30:45.123Z";

function makeLogger(isVerbose?: boolean) {
    const chunks: string[] = [];
    const logger = createLogger({
        verbose: isVerbose,
        stream: { write: (chunk) => chunks.push(chunk) },
        now: () => FIXED_TIME,
    });
    return { logger, chunks };
}

describe("createLogger", () => {
    it("writes one INFO line with timestamp, message and fields ending in a newline", () => {
        const { logger, chunks } = makeLogger();
        logger.info("ready", { workers: 32 });
        assert.deepEqual(chunks, [`${FIXED_STAMP} INFO ready workers=32\n`]);
    });

    it("writes fields in the order given", () => {
        const { logger, chunks } = makeLogger();
        logger.info("ready", { b: 1, a: true, c: "x" });
        assert.deepEqual(chunks, [`${FIXED_STAMP} INFO ready b=1 a=true c=x\n`]);
    });

    it("writes nothing for debug while verbose output is off", () => {
        const { logger, chunks } = makeLogger(false);
        logger.debug("detail");
        assert.deepEqual(chunks, []);
    });

    it("writes nothing for debug when verbose is not given", () => {
        const { logger, chunks } = makeLogger();
        logger.debug("detail");
        assert.deepEqual(chunks, []);
    });

    it("writes DEBUG lines while verbose output is on", () => {
        const { logger, chunks } = makeLogger(true);
        logger.debug("detail", { n: 1 });
        assert.deepEqual(chunks, [`${FIXED_STAMP} DEBUG detail n=1\n`]);
    });

    it("writes ERROR lines when verbose output is off", () => {
        const { logger, chunks } = makeLogger(false);
        logger.error("boom");
        assert.deepEqual(chunks, [`${FIXED_STAMP} ERROR boom\n`]);
    });

    it("writes ERROR lines when verbose output is on", () => {
        const { logger, chunks } = makeLogger(true);
        logger.error("boom");
        assert.deepEqual(chunks, [`${FIXED_STAMP} ERROR boom\n`]);
    });

    it("escapes newlines in the message so the event is one line", () => {
        const { logger, chunks } = makeLogger();
        logger.info("first\nsecond");
        assert.deepEqual(chunks, [`${FIXED_STAMP} INFO first\\nsecond\n`]);
    });

    it("JSON-quotes field values containing a space, quote, equals sign or newline", () => {
        const { logger, chunks } = makeLogger();
        logger.info("m", { a: "x y", b: 'say "hi"', c: "k=v", d: "l1\nl2" });
        assert.deepEqual(chunks, [`${FIXED_STAMP} INFO m a="x y" b="say \\"hi\\"" c="k=v" d="l1\\nl2"\n`]);
    });

    it("writes each event as exactly one line", () => {
        const { logger, chunks } = makeLogger();
        logger.error("a\nb", { v: "c\nd" });
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0]?.split("\n").length, 2);
    });

    it("writes to process.stderr using Date.now by default", () => {
        const originalWrite = process.stderr.write;
        const captured: string[] = [];
        process.stderr.write = ((chunk: string) => {
            captured.push(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            createLogger().info("default");
        } finally {
            process.stderr.write = originalWrite;
        }
        assert.match(captured[0] ?? "", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO default\n$/);
    });
});
