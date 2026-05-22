// Exercises the paste-team-key authorize flow end-to-end through the real
// @cloudflare/workers-oauth-provider library, against our in-memory KV stub.
//
// Coverage:
//   * The authorize page renders with strict CSP / no-referrer / no-store.
//   * /oauth/authorize/verify:
//       - rejects malformed/unknown/wrong-secret/revoked keys with a uniform
//         user-facing message (200 + re-rendered page; no Set-Cookie).
//       - on a valid key, calls completeAuthorization with userId AND
//         props.teammateId BOTH set to the same teammate id, then 302s
//         back to the OAuth client's redirect_uri with `code` + `state`.
//       - rate-limits a brute-force burst.
//   * The grant stored in KV carries the teammate's id; the access-token
//     payload's encrypted props (which we cannot decrypt directly without
//     the secret half of the token) is bound to the same userId.

import { describe, expect, it } from "vitest";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { makeFakeEnv } from "./_helpers/env.js";
import type { FakeEnv } from "./_helpers/env.js";
import { handleAdmin } from "../src/auth/admin.js";
import { defaultHandler } from "../src/default_handler.js";
import type { Env } from "../src/index.js";

// Build a test-only OAuthProvider that doesn't pull in agents/mcp. We don't
// need the MCP api handlers for these tests; the OAuth flow ends at the
// redirect back to the client. (A full token-exchange + bearer-call test
// belongs in the isolation suite — increment 11 — and runs with the full
// worker.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubApiHandler: any = {
  async fetch() {
    return new Response("ok", { status: 200 });
  },
};
const worker = new OAuthProvider({
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiHandlers: { "/mcp": stubApiHandler, "/sse": stubApiHandler },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: defaultHandler as any,
});

function reqJSON(method: "GET" | "POST", path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function provisionAlice(env: FakeEnv): Promise<{ teammate_id: string; team_key: string }> {
  const res = await handleAdmin(
    new Request("https://example.test/admin/provision", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env._operatorToken}`,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.99",
      },
      body: JSON.stringify({ display_name: "Alice" }),
    }),
    env as unknown as Env,
    "/admin/provision",
  );
  return (await res.json()) as { teammate_id: string; team_key: string };
}

// Register a client via /oauth/register so we have a concrete clientId to
// authorize against. workers-oauth-provider implements RFC 7591.
async function registerClient(env: FakeEnv): Promise<{ client_id: string; redirect_uri: string }> {
  const redirect_uri = "https://claude.test/cb";
  const res = await worker.fetch(
    new Request("https://example.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude.test",
        redirect_uris: [redirect_uri],
        token_endpoint_auth_method: "none",
      }),
    }),
    env as unknown as Env,
    {} as ExecutionContext,
  );
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  const body = (await res.json()) as { client_id: string };
  return { client_id: body.client_id, redirect_uri };
}

function authorizeUrl(clientId: string, redirectUri: string, codeChallenge: string): string {
  const u = new URL("https://example.test/oauth/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", "client-state-xyz");
  u.searchParams.set("scope", "mcp");
  return u.toString();
}

describe("GET /oauth/authorize", () => {
  it("renders the paste-team-key page with strict headers", async () => {
    const env = await makeFakeEnv();
    const { client_id, redirect_uri } = await registerClient(env);
    const res = await worker.fetch(
      new Request(authorizeUrl(client_id, redirect_uri, "challenge-S256-placeholder")),
      env as unknown as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/script-src 'none'/);
    expect(csp).toMatch(/form-action 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/base-uri 'none'/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Audit finding 4: HSTS on browser-loaded OAuth pages.
    expect(res.headers.get("strict-transport-security") ?? "").toMatch(
      /max-age=\d{7,}/,
    );
    const html = await res.text();
    expect(html).toMatch(/<form\s+method="POST"\s+action="\/oauth\/authorize\/verify"/);
    expect(html).toMatch(/name="team_key"/);
    expect(html).toMatch(/name="ar"/); // hidden AuthRequest carrier
    expect(html).toMatch(/autocomplete="off"/);
    expect(html).not.toMatch(/<script\b/i); // no JS at all
  });
});

describe("POST /oauth/authorize/verify", () => {
  async function startFlow(env: FakeEnv) {
    const { client_id, redirect_uri } = await registerClient(env);
    const pageRes = await worker.fetch(
      new Request(authorizeUrl(client_id, redirect_uri, "S256-challenge-placeholder")),
      env as unknown as Env,
      {} as ExecutionContext,
    );
    const html = await pageRes.text();
    const ar = /name="ar"\s+value="([^"]+)"/.exec(html)?.[1];
    expect(ar).toBeTruthy();
    return { client_id, redirect_uri, ar: ar! };
  }

  function postVerify(env: FakeEnv, body: Record<string, string>, ip = "203.0.113.50"): Promise<Response> {
    return worker.fetch(
      new Request("https://example.test/oauth/authorize/verify", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": ip,
        },
        body: new URLSearchParams(body).toString(),
      }),
      env as unknown as Env,
      {} as ExecutionContext,
    );
  }

  it("rejects malformed team key with uniform re-rendered error page", async () => {
    const env = await makeFakeEnv();
    const flow = await startFlow(env);
    const res = await postVerify(env, { team_key: "not-a-key", ar: flow.ar });
    expect(res.status).toBe(200); // rendered error page, not a redirect
    const html = await res.text();
    expect(html).toMatch(/Sign-in failed/);
    expect(html).not.toMatch(/malformed|not_found|bad_secret|revoked/i);
  });

  it("rejects an unknown but well-formed team key with the same uniform error", async () => {
    const env = await makeFakeEnv();
    const flow = await startFlow(env);
    const fakeKey = "tk_AAAAAAAA_" + "B".repeat(32);
    const res = await postVerify(env, { team_key: fakeKey, ar: flow.ar });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Sign-in failed/);
    expect(html).not.toMatch(/tk_AAAAAAAA/);
  });

  it("rejects a revoked team key", async () => {
    const env = await makeFakeEnv();
    const alice = await provisionAlice(env);
    const flow = await startFlow(env);
    // Revoke the key directly.
    await env._db
      .prepare("UPDATE team_keys SET revoked_at = ? WHERE teammate_id = ?")
      .bind(Date.now(), alice.teammate_id)
      .run();
    const res = await postVerify(env, { team_key: alice.team_key, ar: flow.ar });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Sign-in failed/);
  });

  it("on success, redirects to client redirect_uri with code+state and binds teammate_id in the grant", async () => {
    const env = await makeFakeEnv();
    const alice = await provisionAlice(env);
    const flow = await startFlow(env);
    const res = await postVerify(env, { team_key: alice.team_key, ar: flow.ar });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    const u = new URL(loc);
    expect(u.origin + u.pathname).toBe(flow.redirect_uri);
    expect(u.searchParams.get("code")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe("client-state-xyz");

    // Inspect the grant in KV — userId must equal alice.teammate_id.
    const list = await env.OAUTH_KV.list({ prefix: "grant:" });
    expect(list.keys.length).toBe(1);
    const grantKey = list.keys[0]!.name;
    // The key format is grant:<userId>:<grantId>.
    const userId = grantKey.split(":")[1];
    expect(userId).toBe(alice.teammate_id);

    const grant = (await env.OAUTH_KV.get(grantKey, { type: "json" })) as {
      userId: string;
      encryptedProps: string;
      metadata: { display_name: string };
    };
    expect(grant.userId).toBe(alice.teammate_id);
    expect(grant.metadata.display_name).toBe("Alice");
    // Props are encrypted; we cannot read teammateId from KV without the
    // token secret. The chokepoint test in increment 11 will exercise the
    // round trip by going through /mcp with the issued bearer.
    expect(typeof grant.encryptedProps).toBe("string");
    expect(grant.encryptedProps.length).toBeGreaterThan(20);
  });

  it("rate-limits a brute-force burst from one IP", async () => {
    const env = await makeFakeEnv();
    const flow = await startFlow(env);
    // 5 bad attempts -> soft block.
    for (let i = 0; i < 5; i++) {
      const res = await postVerify(env, { team_key: "not-a-key", ar: flow.ar }, "203.0.113.77");
      expect(res.status).toBe(200);
    }
    // 6th attempt is rate-limited with 429, even if the key were valid.
    const blocked = await postVerify(env, { team_key: "not-a-key", ar: flow.ar }, "203.0.113.77");
    expect(blocked.status).toBe(429);
  });
});

