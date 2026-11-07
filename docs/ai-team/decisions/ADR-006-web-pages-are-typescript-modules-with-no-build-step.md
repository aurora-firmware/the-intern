---
id: ADR-006
title: Web pages are TypeScript modules with no build step
status: accepted
created: '2026-11-06'
---

# ADR-006: Web pages are TypeScript modules with no build step

## Context

S-006 adds the first pages of the web interface, and later specs add more. The network listener serves them as files
from the package (S-003 REQ-008). The pages must load everything from the service (S-006 REQ-017), work on current
Chrome and Firefox on desktop, with Edge good to have (REQ-021), and stay readable and keyboard-usable (REQ-020).

The product owner would like the look of The Round Table and pages written in TypeScript. The Round Table is built with
Next.js, Tailwind and shadcn with Radix. The product owner asked for its style and colours, not necessarily its stack.
S-006 REQ-016 fixes the colours, fonts and layout as a contract, so the look doesn't depend on any of those libraries.

`bob` has no compile step: Node 24 runs the `.ts` sources directly (`docs/development/tech_stack.md`, Development
environment). A browser doesn't run TypeScript, and the client library the pages must use is itself `.ts`
(`src/client/client.ts`, `src/client/browser_transport.ts`). The release form is still open
(`docs/development/release_form.md`). The coding guidelines add a dependency only when it removes real code.

Probes made for this decision, on Node 24.22.0, against a test server over plain HTTP with a non-loopback name:

- A page and a module worker made of `.ts` files with their types stripped at serve time, importing the real client
  library and Preact 11.1.1 through an import map, ran in Chrome 156 and 157, Firefox 159 (Playwright's build) and
  Edge 157. The last three ran in the CI image `node:24.22.0-bookworm`.
- Stripping took 34.6 ms in total over every `.ts` request of a run in two browsers, the first load of the stripper
  included.
- `node:module` `stripTypeScriptTypes` works on Node 24.22.0 but prints an `ExperimentalWarning` to standard error.
- `tsc` with `rootDirs` type-checks a page's `./client/client.ts` import against `src/client/`, and reports a missing
  prop on a Preact `h()` call.
- Preact's own `h()` declarations leave most props unchecked, measured on Preact 11.1.1 and `tsc` 7.0.2. `h<P>` infers
  `P` from the props argument as well, so `h(Greeting, { name: "x", extra: 1 })` passes. So do `h(Greeting, null)` with
  a required prop, `h("a", { href: 1 })` and `h("div", { nonsense: 1 })`. A `paths` entry onto a stricter declaration
  rejected all of these, and left clean a set of valid calls: `key`, `ref`, event handlers, children, `Fragment`,
  generic and union-typed components, `svg`, `dialog`, `select` and `aria-*` and `data-*` attributes.
- In a copy of the lockfile, adding `preact`, `amaro`, `playwright-core` and `axe-core` changes no pi package. The four
  stay on 1.4.0. `preact` 10, which VitePress's search brings in, moves to a nested folder.

Sources: S-003 REQ-008, REQ-009, REQ-013, AC-008.1; S-006 REQ-005, REQ-016, REQ-017, REQ-019, REQ-020, REQ-021 and Open
Questions; S-002 REQ-004; ADR-001 decision 2; ADR-005; `docs/development/tech_stack.md`;
`docs/development/release_form.md`, section 2.

## Decision

The pages are TypeScript ES modules in `web/ui/`. The browser loads them as they are, and the listener strips their
types as it serves them. There is no build step, no bundler and no generated output anywhere.

1. **TypeScript with erasable syntax only**, as for the rest of the code. One module per file. The modules import each
   other with relative `.ts` paths, which work on disk and as URLs.
2. **The listener strips types when it serves a `.ts` file.** `src/listeners/static_files.ts` answers a `.ts` file
   with `text/javascript`, through `amaro`'s `transformSync(code, { mode: "strip-only" })`. `amaro` is the stripper Node
   24 itself uses, pinned as a production dependency to the version Node 24.22.0 bundles, 1.1.11. The listener loads it
   with a dynamic `import()` at the first `.ts` request, and keeps the result in memory by path, modification time and
   size. Strip mode keeps every line in place, so a browser's stack traces match the source.
3. **Preact renders the pages.** `preact` is a production dependency, pinned exactly. Pages call its `h()` with no JSX
   and no template strings, and write props as an object literal or `null`, so `tsc` checks every prop. Routing is a
   small hash router of our own, because S-006 Interfaces fixes the addresses.

   Preact's own declarations don't give that check, so `web/tsconfig.json` maps `preact` through `paths` to
   `web/types/preact.d.ts`. That file re-exports Preact's declarations and declares a stricter `h`:

   - An element's props come from `JSX.IntrinsicElements`, and `data-*` attributes are allowed.
   - A component's props come from the component alone, never from the call (`NoInfer`).
   - `null` is accepted for an element, and for a component with no required prop.

   The file exists only for `tsc`. Pages still import `h` from `preact`, the import map still gives them Preact's code,
   and nothing under `web/types/` is served or shipped.
4. **A fixed table serves what lies outside `web/ui/`.** `static_files.ts` maps exactly four addresses:

   | Address | File |
   |---|---|
   | `/ui/client/client.ts` | `src/client/client.ts` |
   | `/ui/client/browser_transport.ts` | `src/client/browser_transport.ts` |
   | `/ui/vendor/preact.mjs` | `import.meta.resolve("preact")` |
   | `/ui/vendor/hooks.mjs` | `import.meta.resolve("preact/hooks")` |

   Every other address resolves under `web/ui/`, with the existing check that keeps a file inside that folder.
   `web/ui/index.html` holds an import map for `preact` and `preact/hooks`. A worker gets no import map, so worker code
   imports only by relative path. Client library modules stay in `src/client/`, because the `bob` commands import them
   too. The web type-check configuration names `web/ui` and `src` in `rootDirs`, so `./client/client.ts` type-checks as
   it resolves in the browser.
5. **Our own CSS, on the brand's tokens.** `web/ui/style/` holds plain CSS with custom properties named as The Round
   Table names its tokens, with S-006 REQ-016's values. Confirmations use the native `<dialog>`, and lists of choices
   the native `<select>`, which bring focus handling and keyboard use with them. Lucide's icons (ISC licence) are copied
   as path data into one module, with the licence next to it, so no icon package is added.
6. **Two more type-check configurations.** `web/tsconfig.json` checks the pages with the DOM library, and
   `web/tsconfig.worker.json` checks the worker with the `webworker` library. `npm run typecheck` runs them with the
   root configuration, and Biome's `files.includes` adds `web/**`.
7. **The package carries the source.** A release ships `web/ui/`, `src/client/client.ts`,
   `src/client/browser_transport.ts`, and `preact` and `amaro` among the production dependencies. Nothing is generated.
   Release forms A and B in `docs/development/release_form.md` serve these files as they are, because the listener reads
   them as text. Node's refusal to run `.ts` under `node_modules` doesn't apply to a file read as text. Form A compiles
   the rest of `src/` for Node, and must still ship those two client modules as `.ts`. Form C has no file tree to read
   from, so choosing it needs this decision amended.

## Consequences

### Positive

- `node src/cli/bob.ts serve` runs the pages from the working tree, and an edit shows on reload.
- The tests exercise the files a release ships, so no output can be out of date.
- Pages get TypeScript checking with no new tool, and the client library runs in a browser unchanged.
- The pages add 2 production dependencies and no build tools, and neither touches the pinned pi packages. For
  comparison, The Round Table's lockfile holds 531 packages and this project's 331.

### Negative

- `h()` calls read less easily than JSX in a page with deep markup.
- `web/types/preact.d.ts` is one more file to check when Preact moves. `tsc` applies its excess-property check only to
  an object literal, so an undeclared prop passed in a variable or a spread still passes.
- With no bundle, a page makes one request per module when it first opens, an estimated 40. Later loads use conditional
  requests, and S-006 targets a team's network. The browser tests hold it to REQ-019's 3 seconds.
- We write our own component CSS, and the accessible behaviour of anything beyond native controls. S-006's pages need
  none: REQ-020 is met with native elements.
- `amaro` adds about 4 MB to the production dependencies, and its version must follow Node's when Node moves.
- Pages can use no library that needs a compile step or ships only CommonJS, React included. Adopting one amends this
  decision and brings a build step with it.

### Neutral

- Files under `/ui/` carry `cache-control: no-cache` and a content hash as `ETag`, so an upgraded daemon's files replace
  the old ones at the next load.
- The statement "no build step" in `docs/development/tech_stack.md` and the coding guidelines stays true for pages too.

## Alternatives Considered

### Alternative A: Next.js, as in The Round Table

**Description:** Build the pages with Next.js, Tailwind and shadcn with Radix, and serve a static export.
**Rejected because:** S-006 asks for static files from the package, with addresses after `#`. A static export uses only
a fraction of Next.js, and brings its toolchain and a build step into a project with none. The product owner asked for
the style, which REQ-016 fixes without it.

### Alternative B: React or Preact with Tailwind, compiled by esbuild or Vite

**Description:** Keep JSX and utility classes, compile at `prepack`, and git-ignore the output in `web/ui/`.
**Rejected because:** Every development run and every browser test then needs a build first, and CI and the release gain
a step that can go stale. React ships no ES modules, so it can't avoid this. Radix adds behaviour that native `<dialog>`
and `<select>` give these pages, and Tailwind's value is its build-time class generation.

### Alternative C: Node's own `stripTypeScriptTypes`

**Description:** Strip with `node:module`, which adds no dependency.
**Rejected because:** It prints an `ExperimentalWarning` to standard error at the first call, and S-002 REQ-004 fixes
one plain line per event there. Node offers no way to turn off one warning from inside a running process, and the API is
marked as one that may change.

### Alternative D: Plain JavaScript with JSDoc types

**Description:** Write `.js` with type comments and check it with `tsc --checkJs`.
**Rejected because:** The product owner prefers TypeScript, it's the language of the rest of the code, and the client
library still has to be served from `.ts`.

### Alternative E: Plain DOM code with no rendering library

**Description:** Build and update the pages by hand.
**Rejected because:** Six pages of forms and live lists kept current by a feed need a keyed update of the DOM. Writing
that ourselves is more code than Preact's two modules, about 7 KB gzipped, so the dependency removes real code.

### Alternative F: Copy Preact into `web/ui/vendor/`

**Description:** Commit Preact's files and serve them under `web/ui/`.
**Rejected because:** The version would then live outside the lockfile, which is where every other dependency is pinned.

### Alternative G: Keep Preact's declarations and check only missing props

**Description:** Drop "every prop" from decision 3, and hold T-206 AC-2 to a required prop left out as `{}`.
**Rejected because:** A misspelt attribute or a renamed prop would then pass `npm run typecheck`, and most `h()` calls
would have no prop checking. "`tsc` checks every prop" is the reason decision 3 gives for `h()`, and the check costs one
`paths` entry and one declaration file.

### Alternative H: A typed wrapper module in `web/ui/`

**Description:** Pages import `h` from a module of our own that casts Preact's `h` to a stricter type.
**Rejected because:** It adds a module the browser loads for no behaviour, and a page importing `h` from `preact` skips
the check unless a lint rule forbids it. The `paths` entry covers every import of `preact`.

### Alternative I: Type arguments at each call

**Description:** Pages write `h<GreetingProps>(Greeting, { ... })`.
**Rejected because:** Nothing makes a page write the argument, and `h<GreetingProps>(Greeting, null)` still passes.

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-11-06 | Decision 3 states how `tsc` checks every prop: `paths` to `web/types/preact.d.ts`, with a stricter `h`, and props as an object literal or `null`. Context records the probe. Consequences and Alternatives G, H and I added. | T-206 found that Preact's own `h()` declarations don't check undeclared props, `null` for required props, or element attributes, so decision 3's statement was untrue. |
| 2026-11-07 | Context states S-006 v0.4's browsers: Chrome and Firefox required, Edge good to have. The decision and the dated probes stay. | S-006 v0.4 REQ-021 changed the sentence's source. Nothing in this decision depends on Edge. |
