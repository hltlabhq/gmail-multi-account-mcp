import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**"],
    globals: true,
    testTimeout: 10_000,
    server: {
      deps: {
        // Force Vite to transform anything that imports cloudflare:workers
        // so the alias below resolves at import time. workers-oauth-provider
        // reaches `cloudflare:workers` for a WorkerEntrypoint instanceof check.
        inline: ["@cloudflare/workers-oauth-provider", /workers-oauth-provider/],
      },
    },
  },
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
      // The OAuth provider library imports `cloudflare:workers` for an
      // instanceof check on WorkerEntrypoint. In Node tests we alias to a
      // tiny .js stub; production runs in the Workers runtime where the
      // real module is provided.
      "cloudflare:workers": new URL(
        "./test/_helpers/cloudflare_workers_stub.js",
        import.meta.url,
      ).pathname,
    },
  },
});
