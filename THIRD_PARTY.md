# Third-party code and licenses

This repository is licensed under the MIT License (see [LICENSE](LICENSE)).
The license covers only the first-party code authored for this project.
Third-party dependencies and patches retain their own licenses, summarized
below.

## Runtime dependencies

Declared in [package.json](package.json) under `dependencies`. Each carries
its own license; see the corresponding `node_modules/<pkg>/LICENSE` after
`npm install`.

- `@modelcontextprotocol/sdk` — MIT (Anthropic, PBC).
- `@cloudflare/workers-oauth-provider` — Apache 2.0 (Cloudflare, Inc.).
- `@cfworker/json-schema` — MIT.

## Build / test dependencies

Declared under `devDependencies`. Same — see each package's `LICENSE` file.
Notable: `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`,
`@cloudflare/workers-types`, `typescript`, `patch-package`, `@types/node`.

## Patches

The `patches/` directory contains a patch applied via `patch-package` against
a dependency at install time:

- [`patches/ajv+8.20.0.patch`](patches/ajv+8.20.0.patch) — modifies `ajv`
  8.20.0 to remove `require('./refs/data.json')`-style dynamic JSON requires
  that workerd refuses under its CJS-via-ESM shim. The patch is small,
  mechanical, and inlines the JSON. `ajv` itself is MIT-licensed (©
  Evgeny Poberezkin); the patch does not relicense it.

## Attribution

Where a dependency's license requires attribution beyond inclusion of its
license text (notably Apache 2.0's NOTICE-file convention), refer to the
license text shipped with that package under `node_modules/<pkg>/`. We do
not vendor third-party source in this repository, so no consolidated NOTICE
file is maintained here.
