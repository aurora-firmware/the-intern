---
id: ADR-006
title: Web pages are TypeScript modules with no build step
status: accepted
created: '2026-11-06'
---

# ADR-006: Web pages are TypeScript modules with no build step

## Context

S-006 adds the web interface's pages, served as files from the package (S-003 REQ-008). They load everything from the
service, run on current Chrome and Firefox (Edge good to have), and stay readable and keyboard-usable (S-006 REQ-017,
REQ-020, REQ-021). The product owner wants The Round Table's look and TypeScript; S-006 REQ-016 fixes the look without
any library. `bob` has no compile step, and the client library the pages use is `.ts`.

Probes on Node 24.22.0, recorded 2026-11-06, found that `.ts` modules with types stripped at serve time, importing the
client library and Preact through an import map, run in Chrome, Firefox and Edge, and stripping cost about 35 ms over a
whole test run in two browsers. Node's own `stripTypeScriptTypes` prints an `ExperimentalWarning`. Preact's own `h()`
declarations leave most props unchecked, and a stricter declaration reached through `paths` checks them.

## Decision

The pages are TypeScript ES modules in `web/ui/`. The listener strips their types as it serves them, and there is no
build step, bundler or generated output.

1. **TypeScript with erasable syntax only,** one module per file, importing each other by relative `.ts` paths.
2. **The listener strips types when it serves a `.ts` file.** `src/listeners/static_files.ts` answers it as
   `text/javascript` through `amaro`'s strip-only `transformSync`, `amaro` being pinned as a production dependency to
   the version Node 24 bundles. It loads `amaro` at the first `.ts` request and caches the result by path, modification
   time and size. Strip mode keeps every line in place, so stack traces match the source.
3. **Preact renders the pages.** `preact` is a pinned production dependency. Pages call `h()` with no JSX, with props as
   an object literal or `null`, so `tsc` checks every prop: `web/tsconfig.json` maps `preact` through `paths` to
   `web/types/preact.d.ts`, which declares a stricter `h` and is neither served nor shipped. Routing is a small hash
   router of our own.
4. **A fixed table serves what lies outside `web/ui/`.** `static_files.ts` maps exactly four addresses:

   | Address | File |
   |---|---|
   | `/ui/client/client.ts` | `src/client/client.ts` |
   | `/ui/client/browser_transport.ts` | `src/client/browser_transport.ts` |
   | `/ui/vendor/preact.mjs` | `import.meta.resolve("preact")` |
   | `/ui/vendor/hooks.mjs` | `import.meta.resolve("preact/hooks")` |

   Every other address resolves inside `web/ui/`. `web/ui/index.html` holds the import map; a worker has none, so worker
   code imports by relative path only. The web type-check names `web/ui` and `src` in `rootDirs`.
5. **Our own CSS, on the brand's tokens.** Plain CSS in `web/ui/style/` with S-006 REQ-016's values, native `<dialog>`
   and `<select>`, and Lucide's icons copied as path data with their licence, so no UI package is added.
6. **Two more type-check configurations.** `web/tsconfig.json` checks the pages with the DOM library and
   `web/tsconfig.worker.json` the worker with `webworker`. `npm run typecheck` runs both, and Biome includes `web/**`.
7. **The package carries the source.** A release ships `web/ui/`, the two client modules as `.ts`, and `preact` and
   `amaro`. Release forms A and B in `docs/development/release_form.md` serve these as text; choosing form C, which
   has no file tree, amends this decision.

## Consequences

- The working tree runs as is, an edit shows on reload, and the tests exercise the shipped files.
- Two production dependencies and no build tool are added, and the pi packages don't move.
- `h()` reads less easily than JSX, `preact.d.ts` must follow Preact, and a prop passed in a variable or spread escapes
  the check.
- A page makes about 40 module requests on first load, held to S-006 REQ-019's 3 seconds by the browser tests. Files
  under `/ui/` carry `no-cache` and a content-hash `ETag`, so an upgrade shows at the next load.
- `amaro` adds about 4 MB and must follow Node's version.
- No library that needs a compile step or ships only CommonJS, React included, can be used without amending this.

## Alternatives Considered

- **Next.js, as in The Round Table:** rejected because a static export uses little of it and brings a toolchain and a
  build step; S-006 REQ-016 gives the style without it.
- **React or Preact with Tailwind, compiled by esbuild or Vite:** rejected because every run and test would need a
  build that can go stale, and native controls cover what Radix adds.
- **Node's own `stripTypeScriptTypes`:** rejected because its warning breaks S-002 REQ-004's one line per event.
- **Plain JavaScript with JSDoc types:** rejected because the product owner prefers TypeScript, and the client library
  is `.ts`.
- **Plain DOM code:** rejected because keyed DOM updates for six live pages are more code than Preact.
- **Preact copied into `web/ui/vendor/`:** rejected because its version would live outside the lockfile.
- **Preact's declarations, a typed wrapper module or type arguments at each call:** rejected because each leaves props
  unchecked or skippable, while one `paths` entry covers every import.
