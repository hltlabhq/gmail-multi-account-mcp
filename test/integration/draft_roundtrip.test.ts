// Fix 1 round-trip test (reviewer requirement).
//
// The bug: create_draft / update_draft used to return message.id /
// message.threadId from the drafts.create response. Gmail can hand out
// IDs from create/update that aren't yet resolvable via threads.get in
// the same session. A real session calling create_draft and then
// get_thread with the returned thread_id got a 404. The unit suite was
// green because no test exercised the cross-tool round trip.
//
// This test runs the actual cross-tool round trip end-to-end:
//
//   * Real MCP Streamable HTTP transport at /mcp (workers pool,
//     miniflare, workerd-bundled D1 + KV — the same runtime the deploy
//     runs in).
//   * Real OAuth flow (team key → /oauth/authorize → /oauth/token →
//     bearer issued by @cloudflare/workers-oauth-provider).
//   * Real chokepoint on each tool call.
//   * cloudflare:test's `fetchMock` (an undici MockAgent) intercepts
//     all outbound HTTP from the Worker — Google's /token endpoint, the
//     Gmail API, etc. — so we can simulate the production bug
//     deterministically:
//
//        POST   /users/me/drafts            → "stale" message IDs
//        GET    /users/me/drafts/<draftId>  → canonical IDs
//        GET    /users/me/threads/CANONICAL → resolves to a real thread
//        GET    /users/me/threads/STALE     → 404
//
// Without the fix, create_draft would return STALE_THREAD; the
// follow-up get_thread call would receive 404 from Gmail and the round
// trip fails. With the fix, create_draft refetches via drafts.get,
// returns CANONICAL_THREAD, and get_thread resolves cleanly.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SELF, env, fetchMock } from "cloudflare:test";
import { createTeammate } from "../../src/db/teammates.js";
import { issueKeyForTeammate } from "../../src/db/team_keys_repo.js";
import { createInbox } from "../../src/db/inboxes.js";

const STALE_MSG = "msg-stale-from-create";
const STALE_THREAD = "thread-stale-from-create";
const CANONICAL_MSG = "msg-canonical-from-get";
const CANONICAL_THREAD = "thread-canonical-from-get";

interface ProvisionedTeammate {
  teammate_id: string;
  team_key: string;
}

async function seed(displayName: string): Promise<ProvisionedTeammate> {
  const t = await createTeammate(env.DB, { displayName });
  const k = await issueKeyForTeammate(env.DB, env.HMAC_PEPPER, t.id);
  return { teammate_id: t.id, team_key: k.plaintext };
}

async function obtainBearer(teamKey: string): Promise<string> {
  const reg = await SELF.fetch("https://example.test/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "draft-roundtrip-test",
      redirect_uris: ["https://client.test/cb"],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );

  const pageUrl = new URL("https://example.test/oauth/authorize");
  pageUrl.searchParams.set("response_type", "code");
  pageUrl.searchParams.set("client_id", client_id);
  pageUrl.searchParams.set("redirect_uri", "https://client.test/cb");
  pageUrl.searchParams.set("scope", "mcp");
  pageUrl.searchParams.set("state", "test-state");
  pageUrl.searchParams.set("code_challenge", challenge);
  pageUrl.searchParams.set("code_challenge_method", "S256");
  const page = await SELF.fetch(pageUrl.toString());
  const ar = /name="ar"\s+value="([^"]+)"/.exec(await page.text())?.[1];

  const verify = await SELF.fetch("https://example.test/oauth/authorize/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ team_key: teamKey, ar: ar! }).toString(),
    redirect: "manual",
  });
  const code = new URL(verify.headers.get("location") ?? "").searchParams.get("code");

  const tok = await SELF.fetch("https://example.test/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id,
      redirect_uri: "https://client.test/cb",
      code_verifier: verifier,
    }).toString(),
  });
  const body = (await tok.json()) as { access_token: string };
  return body.access_token;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let rpcId = 2000;

async function rpc(
  bearer: string,
  sessionId: string | null,
  method: string,
  params: Record<string, unknown>,
): Promise<{ payload: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await SELF.fetch("https://example.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
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
  return { payload, sessionId: newSessionId };
}

function extractToolText(payload: unknown): unknown {
  const p = payload as { result?: { content?: { type: string; text: string }[] } };
  const text = p.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch { return text; }
}

beforeAll(() => {
  fetchMock.activate();
  // Disallow net by default — every outbound call must match an
  // interceptor. Surfaces "we forgot to mock X" as a clear test failure
  // instead of a flaky live-net attempt.
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  // Fresh interceptor state per test.
});

afterEach(() => {
  // assertNoPendingInterceptors throws if any interceptor we set up wasn't
  // consumed — catches "fix removed an outbound call we depend on".
  fetchMock.assertNoPendingInterceptors();
});

describe("Fix 1: draft create → get_thread round trip (real /mcp transport, fetchMock-driven Gmail)", () => {
  it("create_draft returns canonical thread_id; get_thread resolves it with the returned id", async () => {
    const alice = await seed("A-draft-" + crypto.randomUUID().slice(0, 6));
    await createInbox(env.DB, env.AES_MASTER_KEY, {
      teammateId: alice.teammate_id,
      nickname: "work",
      email: "alice-roundtrip@example.com",
      googleSub: "google-sub-roundtrip",
      refreshToken: "1//rt-roundtrip",
      scopes: "openid email https://www.googleapis.com/auth/gmail.modify",
    });

    // Mock Google's outbound surface for this test.
    //
    // Two refresh calls expected (one per gmailFetch — create_draft refetches
    // via drafts.get, and get_thread is a separate gmailFetch). We persist
    // the token interceptor to cover both, since fetchMock interceptors are
    // single-use by default.
    fetchMock
      .get("https://oauth2.googleapis.com")
      .intercept({ path: "/token", method: "POST" })
      .reply(200, JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      })
      .persist();

    // drafts.create — returns stale IDs (the bug we're testing).
    fetchMock
      .get("https://gmail.googleapis.com")
      .intercept({ path: "/gmail/v1/users/me/drafts", method: "POST" })
      .reply(
        200,
        JSON.stringify({
          id: "draft-1",
          message: { id: STALE_MSG, threadId: STALE_THREAD },
        }),
        { headers: { "content-type": "application/json" } },
      );

    // drafts.get — returns canonical IDs. THIS is what the fix calls to get
    // IDs that threads.get will actually resolve.
    fetchMock
      .get("https://gmail.googleapis.com")
      .intercept({ path: (p: string) => /^\/gmail\/v1\/users\/me\/drafts\/draft-1(\?.*)?$/.test(p), method: "GET" })
      .reply(
        200,
        JSON.stringify({
          id: "draft-1",
          message: { id: CANONICAL_MSG, threadId: CANONICAL_THREAD },
        }),
        { headers: { "content-type": "application/json" } },
      );

    // threads.get — resolves ONLY the canonical thread; stale 404s. The
    // assertion is that get_thread receives CANONICAL_THREAD, hits the 200
    // branch, and returns a thread payload. If the fix is removed,
    // create_draft would return STALE_THREAD and the threads.get call
    // (which we'd then need to intercept) would 404.
    fetchMock
      .get("https://gmail.googleapis.com")
      .intercept({
        path: (p: string) =>
          new RegExp(
            "^/gmail/v1/users/me/threads/" + CANONICAL_THREAD + "(\\?.*)?$",
          ).test(p),
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          id: CANONICAL_THREAD,
          messages: [
            {
              id: CANONICAL_MSG,
              threadId: CANONICAL_THREAD,
              labelIds: ["DRAFT"],
              snippet: "rt body",
              internalDate: "1700000000000",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "From", value: "alice-roundtrip@example.com" },
                  { name: "Subject", value: "rt-test" },
                ],
                body: { size: 5, data: "cnQgYm9keQ" }, // "rt body" base64url
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    // Drive the actual cross-tool round trip through real /mcp.
    const bearer = await obtainBearer(alice.team_key);
    const init = await rpc(bearer, null, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "draft-roundtrip-test", version: "0" },
    });
    const sessionId = init.sessionId;

    const createRes = await rpc(bearer, sessionId, "tools/call", {
      name: "create_draft",
      arguments: {
        inbox: "work",
        to: ["x@example.com"],
        subject: "rt-test",
        body: "rt body",
      },
    });
    const created = extractToolText(createRes.payload) as {
      ok: boolean;
      draft_id: string;
      message_id: string | null;
      thread_id: string | null;
    };

    // The headline assertion: create_draft returned the canonical thread_id,
    // not the stale one. (Without the refetch fix, this would be STALE_THREAD.)
    expect(created.ok).toBe(true);
    expect(created.thread_id).toBe(CANONICAL_THREAD);
    expect(created.message_id).toBe(CANONICAL_MSG);
    expect(created.thread_id).not.toBe(STALE_THREAD);

    // THE round trip: feed the returned thread_id straight into get_thread.
    // If the fix is wrong (stale id), this hits the no-interceptor branch
    // for /threads/STALE and either 404s on the mock or fails on
    // disableNetConnect — either way, the test fails.
    const threadRes = await rpc(bearer, sessionId, "tools/call", {
      name: "get_thread",
      arguments: { inbox: "work", thread_id: created.thread_id },
    });
    const thread = extractToolText(threadRes.payload) as {
      ok: boolean;
      inbox: string;
      thread_id: string;
      message_count: number;
      messages: { subject: string | null }[];
    };
    expect(thread.ok).toBe(true);
    expect(thread.inbox).toBe("work");
    expect(thread.thread_id).toBe(CANONICAL_THREAD);
    expect(thread.message_count).toBe(1);
    expect(thread.messages[0]!.subject).toBe("rt-test");
  });
});
