// Workers-runtime vitest config — for the isolation suite (increment 11)
// and any future tests that need a real Cloudflare runtime (workerd) with
// real bindings (D1 with our schema, KV via miniflare, the GmailMcpAgent
// Durable Object).
//
// Migrations: vitest-pool-workers does NOT automatically apply D1 migrations
// from wrangler.toml's migrations_dir. We load them via readD1Migrations at
// config time and stash them in a binding (TEST_MIGRATIONS) so tests can
// apply them via cloudflare:test's applyD1Migrations.

import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      include: ["test/integration/**/*.test.ts"],
      testTimeout: 30_000,
      setupFiles: ["./test/integration/_setup.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            d1Databases: { DB: "test-d1" },
            kvNamespaces: ["OAUTH_KV"],
            // No Durable Object — the MCP transport is hand-rolled stateless
            // Streamable HTTP. See src/mcp/transport.ts.
            bindings: {
              GOOGLE_CLIENT_ID: "test-google-client-id",
              GOOGLE_CLIENT_SECRET: "test-google-client-secret",
              AES_MASTER_KEY: btoa(String.fromCharCode(...new Array(32).fill(0xcd))),
              HMAC_PEPPER: btoa(String.fromCharCode(...new Array(32).fill(0xab))),
              OPERATOR_TOKEN_HMAC: "",
              PUBLIC_BASE_URL: "https://example.test",
              // Migrations payload available to test setup via env.TEST_MIGRATIONS.
              TEST_MIGRATIONS: migrations,
            },
            modulesRules: [
              { type: "Data", include: ["**/*.json"], fallthrough: true },
              { type: "ESModule", include: ["**/*.js", "**/*.mjs"] },
            ],
          },
          wrangler: {
            configPath: "./wrangler.toml",
          },
        },
      },
    },
  };
});
