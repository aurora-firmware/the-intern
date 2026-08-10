/**
 * pi-agent-compat.test.ts — Compatibility verification for @earendil-works/pi-coding-agent.
 *
 * Enforces that:
 * - The declared dependency version is pinned exactly (no semver range prefix).
 * - The installed package version matches the supported version exactly.
 * - The fire-and-forget PI_EVENTS in bob.ts matches the installed package's
 *   typed event surface (ExtensionAPI.on() overloads), excluding the events
 *   with their own dedicated handlers (tool_call, resources_discover).
 *
 * Tests here fail with a descriptive error when the installed pi-agent package
 * drifts from the tested API surface, giving operators a clear incompatibility
 * signal during `npm test`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// The only pi-agent package version that has been tested with this bob extension.
const SUPPORTED_PI_AGENT_VERSION = "0.75.3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a path relative to the pi-extension package root. */
function extensionsPath(...segments: string[]): string {
  return path.resolve(import.meta.dirname, ...segments);
}

/** Resolve a path relative to the installed pi-coding-agent package. */
function piAgentPath(...segments: string[]): string {
  return extensionsPath("node_modules", "@earendil-works", "pi-coding-agent", ...segments);
}

/**
 * Read the event names from the installed ExtensionAPI.on() overloads in
 * dist/core/extensions/types.d.ts.  This is the authoritative typed event
 * surface of the installed package.
 */
function readInstalledEventSurface(): string[] {
  const typesPath = piAgentPath("dist", "core", "extensions", "types.d.ts");
  const content = fs.readFileSync(typesPath, "utf8");
  // Match lines of the form:  on(event: "some_event_name", handler: ...): void;
  const linePattern = /^\s+on\(event:\s+"([a-z_]+)"/gm;
  const events: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(content)) !== null) {
    events.push(match[1]!);
  }
  if (events.length === 0) {
    throw new Error(
      `No on() overloads found in ${typesPath}. ` +
        "The types.d.ts format may have changed — update the parser."
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// AC-1: declared dependency version is exact (no caret/tilde/range).
// ---------------------------------------------------------------------------

describe("AC-1: declared dependency version is pinned exactly", () => {
  it("declares @earendil-works/pi-coding-agent at exact version 0.75.3 with no caret, tilde, or range prefix", () => {
    const pkgPath = extensionsPath("package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const declared =
      pkg.devDependencies?.["@earendil-works/pi-coding-agent"] ??
      pkg.dependencies?.["@earendil-works/pi-coding-agent"];

    expect(
      declared,
      "@earendil-works/pi-coding-agent must be listed in devDependencies or dependencies"
    ).toBeDefined();

    expect(
      declared,
      `Declared version "${declared}" must be the exact version string "${SUPPORTED_PI_AGENT_VERSION}" ` +
        "with no caret (^), tilde (~), or other semver range prefix. " +
        `Update package.json to read: "@earendil-works/pi-coding-agent": "${SUPPORTED_PI_AGENT_VERSION}"`
    ).toBe(SUPPORTED_PI_AGENT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// AC-2: installed package version is exactly the supported version.
// ---------------------------------------------------------------------------

describe("AC-2: installed pi-agent package version matches supported version", () => {
  it(`fails with a clear error when the installed @earendil-works/pi-coding-agent version is not ${SUPPORTED_PI_AGENT_VERSION}`, () => {
    const installedPkgPath = piAgentPath("package.json");
    const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, "utf8")) as {
      version: string;
    };
    const installedVersion = installedPkg.version;

    expect(
      installedVersion,
      `INCOMPATIBLE pi-agent version detected.\n` +
        `  Installed:  ${installedVersion}\n` +
        `  Supported:  ${SUPPORTED_PI_AGENT_VERSION}\n` +
        `\n` +
        `The bob extension has only been tested against @earendil-works/pi-coding-agent@${SUPPORTED_PI_AGENT_VERSION}. ` +
        `Installing a different version is unsupported until the compatibility test and documentation are updated. ` +
        `To restore compatibility, run: npm install @earendil-works/pi-coding-agent@${SUPPORTED_PI_AGENT_VERSION}`
    ).toBe(SUPPORTED_PI_AGENT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// AC-4: README files document the supported version and incompatibility signal.
// ---------------------------------------------------------------------------

describe("AC-4: README files document supported pi-agent version and incompatibility signal", () => {
  it("root README.md mentions the supported pi-agent version and that other versions are unsupported", () => {
    const rootReadme = fs.readFileSync(
      extensionsPath("..", "..", "README.md"),
      "utf8"
    );
    expect(
      rootReadme,
      `Root README.md must mention the supported pi-agent version "${SUPPORTED_PI_AGENT_VERSION}"`
    ).toContain(SUPPORTED_PI_AGENT_VERSION);
    expect(
      rootReadme,
      "Root README.md must state that other installed versions are unsupported"
    ).toMatch(/unsupported/i);
  });

  it("pi-extension README.md mentions the supported pi-agent version and incompatibility signal", () => {
    const extReadme = fs.readFileSync(extensionsPath("README.md"), "utf8");
    expect(
      extReadme,
      `pi-extension/README.md must mention the supported pi-agent version "${SUPPORTED_PI_AGENT_VERSION}"`
    ).toContain(SUPPORTED_PI_AGENT_VERSION);
    expect(
      extReadme,
      "pi-extension/README.md must describe the incompatibility signal (npm test failing)"
    ).toMatch(/npm test|incompatib/i);
  });
});

// ---------------------------------------------------------------------------
// AC-3 (T-160 AC-5): PI_EVENTS in bob.ts matches the installed package's typed
//        event surface, excluding the events with dedicated handlers
//        (tool_call, resources_discover).
// ---------------------------------------------------------------------------

// Events registered with their own dedicated handler instead of the generic
// fire-and-forget PI_EVENTS loop: tool_call (blocking authz hook) and
// resources_discover (skill-path answer, ADR-014). PI_EVENTS must cover every
// other event the installed package exposes, and must fail this check if
// either dedicated-handler event is also present in PI_EVENTS.
const DEDICATED_HANDLER_EVENTS = new Set(["tool_call", "resources_discover"]);

describe("AC-3: bob PI_EVENTS matches installed pi-agent typed event surface (excluding dedicated-handler events)", () => {
  it("exports PI_EVENTS from bob.ts that covers every event in the installed package's on() overloads except tool_call and resources_discover", async () => {
    // Import the exported PI_EVENTS list from the bob extension.
    const bobModule = await import("./bob.js");
    const piEvents: readonly string[] = bobModule.PI_EVENTS;

    expect(
      piEvents,
      "bob.ts must export PI_EVENTS as a named export (readonly string array)"
    ).toBeDefined();

    // Read the full event surface from the installed package types.
    const installedEvents = readInstalledEventSurface();

    // The package surface minus the dedicated-handler events is what
    // PI_EVENTS must cover.
    const expectedEvents = installedEvents.filter((e) => !DEDICATED_HANDLER_EVENTS.has(e));

    // Sort both for a stable comparison.
    const piEventsSorted = [...piEvents].sort();
    const expectedSorted = [...expectedEvents].sort();

    const missing = expectedSorted.filter((e) => !piEventsSorted.includes(e));
    const extra = piEventsSorted.filter((e) => !expectedSorted.includes(e));

    expect(
      missing,
      `PI_EVENTS in bob.ts is missing events that the installed package exposes: [${missing.join(", ")}]. ` +
        "Update PI_EVENTS to include all events from the installed package except tool_call and resources_discover."
    ).toEqual([]);

    expect(
      extra,
      `PI_EVENTS in bob.ts contains events not found in the installed package's on() overloads: [${extra.join(", ")}]. ` +
        "Remove obsolete events from PI_EVENTS or check if the package API has changed."
    ).toEqual([]);
  });
});
