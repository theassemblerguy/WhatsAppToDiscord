# Testing And Release

> Owner: WA2DC maintainers
> Last reviewed: 2026-02-26
> Scope: Validation commands, CI expectations, and packaging constraints.

## Validation matrix

Preferred checks before handoff:

- `npm run lint` (Biome)
- `npm test`
- `WA2DC_SMOKE_TEST=1 node src/index.js` for startup-sensitive changes

CI executes the following on `ubuntu-latest`, `macos-latest`, and `windows-latest`:

- `npm test`
- `npm run bundle`
- bundled smoke boot from `out.js` (`WA2DC_SMOKE_TEST=1`)
- packaged binary build + smoke (`npm run build:bin:smoke`)

## Packaging model

Release pipeline builds packaged binaries from a pkg-safe CJS bundle:

- esbuild bundles `src/runner.js` to `out.js` (ESM) for Node smoke checks
- esbuild bundles `src/runner.js` to `out.cjs` (CJS) for pkg
- `pkg` produces platform binaries from `out.cjs` with `--no-bytecode`
- runtime may branch on `process.pkg` for packaged-vs-source behavior

## Packaging-safe dependency rules

When adding/changing dependencies, verify:

- esbuild can bundle the runtime entry successfully
- pkg can resolve/load any runtime assets
- dynamic fs/native addon behavior is explicitly handled when required

Generated artifacts (`out.js`, `out.cjs`, `build/`) should not be manually edited.
