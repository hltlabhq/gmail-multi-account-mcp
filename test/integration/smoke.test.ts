// Smoke test for the Workers-runtime pool. Confirms the worker boots under
// miniflare with our wrangler.toml bindings (D1 + KV + GmailMcpAgent DO)
// before the real isolation suite is written on top of it.

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

describe("workers-runtime smoke", () => {
  it("GET /healthz returns ok", async () => {
    const res = await SELF.fetch("https://example.test/healthz");
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("ok");
  });
});
