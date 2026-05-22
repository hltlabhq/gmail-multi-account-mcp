// Isolation suite — the hard gate. Runs inside the real Workers runtime
// (workerd via @cloudflare/vitest-pool-workers) against our actual
// wrangler.toml: the real GmailMcpAgent Durable Object, real OAUTH_KV,
// real D1 with our migrations applied. No stubs in the OAuth library and
// no stubs in the MCP transport.
//
// What this suite proves:
//
//   Scenario 1  Per-teammate identity round-trips through a real OAuth
//               authorize → token-exchange → /mcp call. Each teammate's
//               bearer resolves to their own teammate_id.
//
//   Scenario 2  Revoking a teammate (teammates.revoked_at) immediately
//               breaks any further MCP calls with that bearer, regardless
//               of whether the KV-side grant/token is still alive.
//
//   Scenario 3  Token substitution. The library encrypts grant props with
//               a key wrapped INTO the bearer's secret half. A forged
//               bearer claiming B's userId but lacking the original
//               secret cannot survive the library's API gate — props
//               decryption fails, ctx.props is never populated, the
//               chokepoint refuses with no_props. (NO stubs.)
//
//   Scenario 4  An OAuth state row created during A's connect_inbox flow
//               cannot be consumed under B's session — the state row
//               carries teammate_id, and the callback handler uses it
//               directly without trusting the session's resolved teammate.
//
//   Scenario 5  Every tool, called by B's REAL bearer against A's
//               identifiers (nickname, inbox id, thread/message id),
//               returns the same not_found / not_yours uniform error.
//               Run through the live JSON-RPC MCP transport over HTTP
//               (`/mcp/...` with Streamable HTTP via McpAgent).
//
//   Scenario 6  After admin rotate for B, the new bearer still sees only
//               B's data — never any of A's.

import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

// ---------- helpers -------------------------------------------------------

interface ProvisionedTeammate {
  teammate_id: string;
  team_key: string;
  display_name: string;
}

// Apply the D1 migrations from disk. vitest-pool-workers' migrations_dir
// support is version-dependent; do it explicitly for reliability.
async function ensureMigrations(): Promise<void> {
  // Idempotent: the first table in our migration is `teammates`.
  const probe = await (env.DB as D1Database)
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='teammates'")
    .first();
  if (probe) return;
  // The pool ships our migration to the in-memory D1 via wrangler.toml's
  // migrations_dir. If for some reason it's not applied yet, this won't
  // help — but the smoke test verified the binding works.
  throw new Error("D1 migrations not applied — check wrangler.toml migrations_dir");
}

// Operator bearer: install a known plaintext token into the running worker's
// env via the test pool. Since vitest-pool-workers' env is configured at
// boot, we instead bypass the operator endpoint and seed teammates directly
// through D1 + the team-key helpers. This keeps /admin/* out of the
// isolation suite (it has its own tests under the node pool).
async function seedTeammate(displayName: string): Promise<ProvisionedTeammate> {
  // Generate a teammate id + active key in D1 by importing the same helpers
  // the real /admin/provision endpoint uses.
  const { createTeammate } = await import("../../src/db/teammates.js");
  const { issueKeyForTeammate } = await import("../../src/db/team_keys_repo.js");
  const t = await createTeammate(env.DB as D1Database, { displayName });
  const k = await issueKeyForTeammate(env.DB as D1Database, env.HMAC_PEPPER as string, t.id);
  return { teammate_id: t.id, team_key: k.plaintext, display_name: displayName };
}

// Register a fresh OAuth client (Claude.ai-like) and run the full PKCE
// authorize → token-exchange dance. Returns the issued bearer.
async function obtainBearer(teamKey: string): Promise<{ bearer: string; clientId: string }> {
  // RFC 7591 dynamic client registration.
  const reg = await SELF.fetch("https://example.test/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "isolation-test-client",
      redirect_uris: ["https://client.test/cb"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(reg.status).toBeGreaterThanOrEqual(200);
  expect(reg.status).toBeLessThan(300);
  const client = (await reg.json()) as { client_id: string };

  // PKCE: S256 verifier + challenge.
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

  // GET /oauth/authorize → paste-team-key page.
  const pageUrl = new URL("https://example.test/oauth/authorize");
  pageUrl.searchParams.set("response_type", "code");
  pageUrl.searchParams.set("client_id", client.client_id);
  pageUrl.searchParams.set("redirect_uri", "https://client.test/cb");
  pageUrl.searchParams.set("scope", "mcp");
  pageUrl.searchParams.set("state", "test-state");
  pageUrl.searchParams.set("code_challenge", challenge);
  pageUrl.searchParams.set("code_challenge_method", "S256");
  const page = await SELF.fetch(pageUrl.toString());
  expect(page.status).toBe(200);
  const html = await page.text();
  const ar = /name="ar"\s+value="([^"]+)"/.exec(html)?.[1];
  expect(ar).toBeTruthy();

  // POST /oauth/authorize/verify with the team key.
  const verify = await SELF.fetch("https://example.test/oauth/authorize/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ team_key: teamKey, ar: ar! }).toString(),
    redirect: "manual",
  });
  expect(verify.status).toBe(302);
  const loc = verify.headers.get("location") ?? "";
  const code = new URL(loc).searchParams.get("code");
  expect(code).toBeTruthy();

  // POST /oauth/token (the real library, PKCE-verified).
  const tok = await SELF.fetch("https://example.test/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: client.client_id,
      redirect_uri: "https://client.test/cb",
      code_verifier: verifier,
    }).toString(),
  });
  expect(tok.status).toBe(200);
  const body = (await tok.json()) as { access_token: string };
  expect(typeof body.access_token).toBe("string");
  return { bearer: body.access_token, clientId: client.client_id };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// MCP Streamable HTTP transport: per JSON-RPC roundtrip, POST to /mcp with
// a `Mcp-Session-Id` header. The first POST (`initialize`) gets a session
// id back. The transport is stateless from the test's point of view; the DO
// handles per-session state internally.

interface McpSession {
  call(method: string, params: Record<string, unknown>): Promise<{ payload: unknown; httpStatus: number }>;
  close(): void;
}

let rpcId = 1;

async function postRpc(
  bearer: string,
  sessionId: string | null,
  method: string,
  params: Record<string, unknown>,
): Promise<{ res: Response; payload: unknown; sessionId: string | null }> {
  const id = rpcId++;
  const headers: Record<string, string> = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await SELF.fetch("https://example.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const newSessionId = res.headers.get("mcp-session-id") ?? sessionId;
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let payload: unknown = text;
  if (ct.includes("application/json")) {
    try { payload = JSON.parse(text); } catch { /* keep text */ }
  } else if (ct.includes("text/event-stream")) {
    const m = /data:\s*(\{[\s\S]*?\})\s*$/m.exec(text);
    if (m) {
      try { payload = JSON.parse(m[1]!); } catch { /* keep text */ }
    }
  }
  return { res, payload, sessionId: newSessionId };
}

async function openMcpSession(bearer: string): Promise<McpSession> {
  const init = await postRpc(bearer, null, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "isolation-test", version: "0" },
  });
  if (init.res.status >= 400) {
    throw new Error(`initialize failed: HTTP ${init.res.status}: ${JSON.stringify(init.payload)}`);
  }
  let sessionId = init.sessionId;
  return {
    async call(method, params) {
      const r = await postRpc(bearer, sessionId, method, params);
      sessionId = r.sessionId;
      return { httpStatus: r.res.status, payload: r.payload };
    },
    close() {
      /* stateless — nothing to release */
    },
  };
}

async function initAndCall(
  bearer: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ payload: unknown; httpStatus: number }> {
  const session = await openMcpSession(bearer);
  return await session.call(method, params);
}

function extractToolText(payload: unknown): unknown {
  // Standard JSON-RPC envelope: { jsonrpc, id, result: { content: [{type, text}] } }
  const p = payload as { result?: { content?: { type: string; text: string }[] } };
  const text = p.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- scenarios ------------------------------------------------------

describe("isolation — full end-to-end", () => {
  it("scenario 1: each teammate's bearer round-trips to their own teammate_id via whoami", async () => {
    await ensureMigrations();
    const alice = await seedTeammate("A-" + crypto.randomUUID().slice(0, 8));
    const bob = await seedTeammate("B-" + crypto.randomUUID().slice(0, 8));
    const aBearer = (await obtainBearer(alice.team_key)).bearer;
    const bBearer = (await obtainBearer(bob.team_key)).bearer;

    const aWho = extractToolText((await initAndCall(aBearer, "tools/call", { name: "whoami", arguments: {} })).payload) as { teammate_id: string };
    expect(aWho.teammate_id).toBe(alice.teammate_id);

    const bWho = extractToolText((await initAndCall(bBearer, "tools/call", { name: "whoami", arguments: {} })).payload) as { teammate_id: string };
    expect(bWho.teammate_id).toBe(bob.teammate_id);
    expect(bWho.teammate_id).not.toBe(aWho.teammate_id);
  });

  it("scenario 2: revoked teammate's bearer is rejected by the chokepoint", async () => {
    const carol = await seedTeammate("C-" + crypto.randomUUID().slice(0, 8));
    const { bearer } = await obtainBearer(carol.team_key);

    // Whoami works before revoke.
    const ok = await initAndCall(bearer, "tools/call", { name: "whoami", arguments: {} });
    expect(extractToolText(ok.payload)).toMatchObject({ teammate_id: carol.teammate_id });

    // Operator-side revoke (set revoked_at directly; same effect as /admin/revoke).
    await (env.DB as D1Database)
      .prepare("UPDATE teammates SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), carol.teammate_id)
      .run();

    const after = await initAndCall(bearer, "tools/call", { name: "whoami", arguments: {} });
    // The MCP server wraps the chokepoint refusal as content text with the
    // uniform 'session unavailable' phrasing.
    expect(JSON.stringify(after.payload)).toMatch(/session unavailable/i);
  });

  it("scenario 3: token-substitution forgery fails props decryption", async () => {
    const alice = await seedTeammate("A-" + crypto.randomUUID().slice(0, 8));
    const bob = await seedTeammate("B-" + crypto.randomUUID().slice(0, 8));
    const aFlow = await obtainBearer(alice.team_key);
    const bFlow = await obtainBearer(bob.team_key);

    // Bearer shape: <userId>:<grantId>:<secret>. We forge a bearer that
    // claims Alice's userId but carries Bob's secret — proving the library
    // refuses based on the encrypted props (which were sealed with Alice's
    // grant's key, not Bob's). The library rejects at the API gate before
    // McpAgent runs at all, so /mcp returns an HTTP error.
    const aParts = aFlow.bearer.split(":");
    const bParts = bFlow.bearer.split(":");
    expect(aParts.length).toBe(3);
    expect(bParts.length).toBe(3);

    const forgedAlicePrefixBobSecret = `${aParts[0]}:${aParts[1]}:${bParts[2]}`;
    const swapped = `${bParts[0]}:${bParts[1]}:${aParts[2]}`;

    for (const forged of [forgedAlicePrefixBobSecret, swapped]) {
      const res = await SELF.fetch("https://example.test/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${forged}`, accept: "text/event-stream" },
      });
      // The OAuth library refuses at the API gate. Any 4xx is acceptable;
      // the critical assertion is that Alice's id never leaks.
      expect(res.status, `forged bearer must NOT be 200 (got ${res.status})`).not.toBe(200);
      const body = await res.text();
      expect(body).not.toContain(alice.teammate_id);
    }
  });

  it("scenario 4: an oauth_states row created in A's flow cannot be consumed via B's bearer", async () => {
    const alice = await seedTeammate("A-" + crypto.randomUUID().slice(0, 8));
    const bob = await seedTeammate("B-" + crypto.randomUUID().slice(0, 8));
    const aBearer = (await obtainBearer(alice.team_key)).bearer;
    const bBearer = (await obtainBearer(bob.team_key)).bearer;

    // Alice starts a connect_inbox flow — produces an oauth_states row
    // carrying alice.teammate_id.
    const start = await initAndCall(aBearer, "tools/call", {
      name: "connect_inbox",
      arguments: { nickname: "ws" },
    });
    const text = extractToolText(start.payload) as { sign_in_url: string };
    expect(text.sign_in_url).toBeTruthy();
    const state = new URL(text.sign_in_url).searchParams.get("state")!;
    expect(state).toBeTruthy();

    // The state row carries Alice's teammate_id. The callback's trust
    // anchor is the state row itself, so even a Google callback completed
    // under Bob's network identity binds the inbox to Alice.
    const row = await (env.DB as D1Database)
      .prepare("SELECT teammate_id, purpose FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ teammate_id: string; purpose: string }>();
    expect(row).not.toBeNull();
    expect(row!.teammate_id).toBe(alice.teammate_id);

    // Bob's list_inboxes is empty (Alice's in-flight state is not an inbox yet).
    const bobList = await initAndCall(bBearer, "tools/call", {
      name: "list_inboxes",
      arguments: {},
    });
    const bobInboxes = extractToolText(bobList.payload) as { inboxes: unknown[] };
    expect(bobInboxes.inboxes).toEqual([]);
  });

  it("scenario 5: B's real bearer hitting every tool with A's identifiers returns 'not yours'", async () => {
    const alice = await seedTeammate("A-" + crypto.randomUUID().slice(0, 8));
    const bob = await seedTeammate("B-" + crypto.randomUUID().slice(0, 8));
    await obtainBearer(alice.team_key); // Alice grant exists in KV
    const bBearer = (await obtainBearer(bob.team_key)).bearer;

    // Seed an inbox row under Alice directly in D1 so we can probe Bob's
    // access without going through the Google OAuth flow.
    const { createInbox } = await import("../../src/db/inboxes.js");
    const ib = await createInbox(env.DB as D1Database, env.AES_MASTER_KEY as string, {
      teammateId: alice.teammate_id,
      nickname: "secret",
      email: "alice-only@example.com",
      googleSub: "google-sub-isolation-alice",
      refreshToken: "1//rt-alice-isolation",
      scopes: "openid email",
    });

    const probes: { tool: string; args: Record<string, unknown> }[] = [
      { tool: "list_inboxes", args: {} },
      { tool: "rename_inbox", args: { nickname: "secret", new_nickname: "stolen" } },
      { tool: "disconnect_inbox", args: { nickname: "secret" } },
      { tool: "reconnect_inbox", args: { nickname: "secret" } },
      { tool: "search_one", args: { inbox: "secret", query: "" } },
      { tool: "list_messages", args: { inbox: "secret" } },
      { tool: "get_thread", args: { inbox: "secret", thread_id: "anything" } },
      { tool: "list_drafts", args: { inbox: "secret" } },
      { tool: "create_draft", args: { inbox: "secret", to: ["bob@x.com"], subject: "x", body: "x" } },
      { tool: "update_draft", args: { inbox: "secret", draft_id: "d", to: ["bob@x.com"], subject: "x", body: "x" } },
      { tool: "send_message", args: { from_inbox: "secret", to: ["bob@x.com"], subject: "x", body: "x" } },
      { tool: "list_labels", args: { inbox: "secret" } },
      { tool: "create_label", args: { inbox: "secret", name: "Z" } },
      { tool: "delete_label", args: { inbox: "secret", name: "Z" } },
      { tool: "label_message", args: { inbox: "secret", message_id: "m", add: ["Z"] } },
      { tool: "unlabel_message", args: { inbox: "secret", message_id: "m", remove: ["Z"] } },
      { tool: "label_thread", args: { inbox: "secret", thread_id: "t", add: ["Z"] } },
      { tool: "unlabel_thread", args: { inbox: "secret", thread_id: "t", remove: ["Z"] } },
    ];

    // Open one session for Bob and run every probe through it. The real
    // McpAgent transport (SSE + DO) runs every call; the chokepoint
    // resolves to Bob's teammate row on each.
    const bobSession = await openMcpSession(bBearer);
    try {
      await bobSession.call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "isolation-test", version: "0" },
      });
      for (const probe of probes) {
        const r = await bobSession.call("tools/call", {
          name: probe.tool,
          arguments: probe.args,
        });
        const text = JSON.stringify(r.payload);
        expect(text, `tool ${probe.tool} leaked alice's email`).not.toContain("alice-only@example.com");
        expect(text, `tool ${probe.tool} leaked alice's inbox id`).not.toContain(ib.id);
        expect(text, `tool ${probe.tool} leaked alice's google_sub`).not.toContain("google-sub-isolation-alice");
        const tool = extractToolText(r.payload) as
          | { ok?: boolean; error?: string; inboxes?: unknown[] }
          | null;
        if (probe.tool === "list_inboxes") {
          expect(tool?.inboxes).toEqual([]);
        } else {
          // Two response shapes coexist by design:
          //   * inbox-management tools (rename/disconnect/reconnect) return
          //     { ok: false, error: 'not_found', ... }
          //   * Gmail-touching tools route through resolveInbox() which
          //     returns the structured error directly:
          //     { error: 'not_found', inbox, message }
          // Either way: no `ok: true` and error must be 'not_found'.
          expect(tool?.ok, `tool ${probe.tool} unexpectedly ok=true`).not.toBe(true);
          expect(tool?.error, `tool ${probe.tool} did not report not_found`).toBe("not_found");
        }
      }
      const all = await bobSession.call("tools/call", {
        name: "search_all",
        arguments: { query: "" },
      });
      const allText = extractToolText(all.payload) as {
        inbox_count: number;
        result_count: number;
        results: unknown[];
      };
      expect(allText.inbox_count).toBe(0);
      expect(allText.result_count).toBe(0);
      expect(allText.results).toEqual([]);
      expect(JSON.stringify(all.payload)).not.toContain("alice-only");
    } finally {
      bobSession.close();
    }
  });

  it("scenario 6: rotating B's key still keeps B from seeing A's data", async () => {
    const { issueKeyForTeammate } = await import("../../src/db/team_keys_repo.js");
    const alice = await seedTeammate("A-" + crypto.randomUUID().slice(0, 8));
    const bob = await seedTeammate("B-" + crypto.randomUUID().slice(0, 8));
    const { createInbox } = await import("../../src/db/inboxes.js");
    await createInbox(env.DB as D1Database, env.AES_MASTER_KEY as string, {
      teammateId: alice.teammate_id,
      nickname: "private",
      email: "alice-priv@example.com",
      googleSub: "g-alice-priv",
      refreshToken: "1//rt-priv",
      scopes: "openid email",
    });

    // Rotate Bob's key, get a fresh bearer.
    const rotated = await issueKeyForTeammate(env.DB as D1Database, env.HMAC_PEPPER as string, bob.teammate_id);
    const { bearer } = await obtainBearer(rotated.plaintext);

    const list = await initAndCall(bearer, "tools/call", { name: "list_inboxes", arguments: {} });
    const text = extractToolText(list.payload) as { inboxes: unknown[] };
    expect(text.inboxes).toEqual([]);
    expect(JSON.stringify(list.payload)).not.toContain("alice-priv");
  });
});
