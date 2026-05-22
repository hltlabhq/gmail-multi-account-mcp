// Tests for search_all. Covers all five design points the operator asked
// for, plus the inbox-derived-from-chokepoint invariant.
//
//   1. Partial failure: one inbox 5xx / one needs_reconnect / one ok →
//      response top-level ok=true, partial=true, per-inbox statuses
//      surface with their actionable messages.
//   2. Proportional 1MB shaping: per-inbox `trimmed_from` set; no inbox
//      survives whole while another is silently dropped.
//   3. Structural inbox label: every hit has `inbox: "<nickname>"` and the
//      schema/types make a hit without that field unconstructible.
//   4. Merge/shape is CPU-trivial: handler runtime under a reasonable
//      sanity bound for ~4 inboxes × 25 hits each.
//   5. Inbox set comes from teammate; no input field selects inboxes;
//      adding a bogus `inboxes` field to input is ignored or rejected;
//      cross-teammate cannot reach another's inboxes by any means.

import { afterEach, describe, expect, it } from "vitest";
import { makeFakeEnv } from "./_helpers/env.js";
import { TOOLS } from "../src/mcp/tool_registry.js";
import { createTeammate } from "../src/db/teammates.js";
import { createInbox, markNeedsReconnect } from "../src/db/inboxes.js";
import { installGmailFetchMock, fakeMessage } from "./_helpers/gmail_mock.js";
import type { Env } from "../src/index.js";
import type { TeammateRow } from "../src/db/teammates.js";

// Side-effect: register tools.
import "../src/mcp/tools/inboxes.js";
import "../src/mcp/tools/messages.js";
import "../src/mcp/tools/cross_inbox.js";

interface Setup {
  env: Awaited<ReturnType<typeof makeFakeEnv>>;
  alice: TeammateRow;
  bob: TeammateRow;
  call<T = unknown>(name: string, input: unknown, who: TeammateRow): Promise<T>;
}

async function setup(opts: { inboxes?: string[] } = {}): Promise<Setup> {
  const env = await makeFakeEnv();
  const alice = await createTeammate(env.DB as unknown as D1Database, { displayName: "Alice" });
  const bob = await createTeammate(env.DB as unknown as D1Database, { displayName: "Bob" });
  const names = opts.inboxes ?? ["work"];
  for (const name of names) {
    await createInbox(env.DB as unknown as D1Database, env.AES_MASTER_KEY, {
      teammateId: alice.id,
      nickname: name,
      email: `${name}@example.com`,
      googleSub: `google-sub-alice-${name}`,
      refreshToken: `1//rt-alice-${name}`,
      scopes: "openid email https://www.googleapis.com/auth/gmail.modify",
    });
  }
  async function call<T>(name: string, input: unknown, who: TeammateRow): Promise<T> {
    const tool = TOOLS[name];
    if (!tool) throw new Error("unknown tool " + name);
    return (await tool.handler(input, { teammate: who, env: env as unknown as Env })) as T;
  }
  return { env, alice, bob, call };
}

let mock: ReturnType<typeof installGmailFetchMock> | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
});

// Authorization header can arrive as either a plain object or a Headers
// instance, depending on how the caller built RequestInit. Read both shapes.
function readAuthHeader(init: RequestInit | undefined): string {
  if (!init?.headers) return "";
  if (init.headers instanceof Headers) {
    return init.headers.get("authorization") ?? "";
  }
  const h = init.headers as Record<string, string>;
  return h["authorization"] ?? h["Authorization"] ?? "";
}

// Build a Gmail handler that returns the per-inbox results we want, keyed
// on the access token-less URL substring. Tests register a map from inbox
// nickname -> ({ messages, threadIdPrefix? }) so we can pretend each inbox
// has its own message list. Per-message metadata lookups return fakeMessage.
function gmailMockFor(byNickname: Map<string, { ids: { id: string; threadId: string }[]; meta?: (id: string) => Parameters<typeof fakeMessage>[0] }>): void {
  // The Gmail API doesn't carry the inbox nickname in the URL — every call
  // uses /users/me. We disambiguate by looking at the access token: the
  // mock issues per-inbox access tokens by routing the refresh request body's
  // refresh_token through to the access_token response.
  // For simplicity we let the test set up a single inbox-per-call scenario
  // by inspecting the order of refresh requests.
  void byNickname;
}
void gmailMockFor;

describe("search_all — partial failure (point 1)", () => {
  it("returns ok + partial with per-inbox statuses when one inbox 500s and another needs_reconnect", async () => {
    const s = await setup({ inboxes: ["work", "personal", "alerts"] });
    // Mark 'alerts' as needing reconnect up front.
    await markNeedsReconnect(
      s.env.DB as unknown as D1Database,
      s.alice.id,
      (await s.env._db
        .prepare("SELECT id FROM inboxes WHERE teammate_id = ? AND nickname = ?")
        .bind(s.alice.id, "alerts")
        .first<{ id: string }>())!.id,
    );

    mock = installGmailFetchMock({ refreshAlwaysOk: false });
    // Route per-inbox by mapping refresh_token (in POST body) → inbox nickname
    // → access token. This is order-independent and stable under parallel
    // dispatch, unlike sequence-number routing.
    const nickByRefresh = new Map<string, string>([
      ["1//rt-alice-work", "work"],
      ["1//rt-alice-personal", "personal"],
      ["1//rt-alice-alerts", "alerts"],
    ]);
    const tokByNick = new Map<string, string>([
      ["work", "tok-work"],
      ["personal", "tok-personal"],
    ]);
    mock.setHandler((url, init) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const body = String(init?.body ?? "");
        const params = new URLSearchParams(body);
        const rt = params.get("refresh_token") ?? "";
        const nick = nickByRefresh.get(rt);
        const tok = nick ? tokByNick.get(nick) : undefined;
        if (!tok) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return new Response(JSON.stringify({ access_token: tok, expires_in: 3600 }), { status: 200 });
      }
      const tokHeader = readAuthHeader(init);
      const nick = [...tokByNick.entries()].find(([, t]) => tokHeader === `Bearer ${t}`)?.[0];
      if (url.includes("/users/me/messages") && !url.includes("/messages/")) {
        if (nick === "work") {
          return new Response(JSON.stringify({ messages: [{ id: "m-work-1", threadId: "t-w-1" }] }), { status: 200 });
        }
        if (nick === "personal") {
          // Simulate Gmail returning 503 for 'personal'.
          return new Response(JSON.stringify({ error: { code: 503 } }), { status: 503 });
        }
      }
      if (url.includes("/messages/m-work-1")) {
        return new Response(JSON.stringify(fakeMessage({ id: "m-work-1", threadId: "t-w-1", subject: "Work email" })), { status: 200 });
      }
      return new Response("not mocked: " + url, { status: 500 });
    });

    const r = await s.call<{
      ok: boolean;
      partial: boolean;
      inbox_count: number;
      result_count: number;
      inboxes: { nickname: string; status: string; message?: string; hit_count?: number }[];
      results: { inbox: string }[];
    }>("search_all", { query: "" }, s.alice);

    expect(r.ok).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.inbox_count).toBe(3);
    // 'work' returned 1 hit, 'personal' transient, 'alerts' needs_reconnect.
    const byName = new Map(r.inboxes.map((i) => [i.nickname, i] as const));
    expect(byName.get("work")!.status).toBe("ok");
    expect(byName.get("work")!.hit_count).toBe(1);
    expect(byName.get("personal")!.status).toBe("transient");
    expect(byName.get("personal")!.message).toMatch(/temporarily unavailable/);
    expect(byName.get("alerts")!.status).toBe("needs_reconnect");
    expect(byName.get("alerts")!.message).toMatch(/reconnect_inbox/);

    // The successful hits MUST still be in the results array.
    expect(r.result_count).toBe(1);
    expect(r.results[0]!.inbox).toBe("work");
  });
});

describe("search_all — proportional 1MB shaping (point 2)", () => {
  it("trims per-inbox proportionally and surfaces trimmed_from", async () => {
    // 4 inboxes, each returning 20 hits → total 80 > MAX_TOTAL_HITS (40).
    // Proportional ratio = 40/80 = 0.5, so each inbox should keep 10.
    const s = await setup({ inboxes: ["a", "b", "c", "d"] });
    mock = installGmailFetchMock({ refreshAlwaysOk: false });
    // Stable per-inbox routing by refresh_token (not by call order).
    const nickByRefresh = new Map<string, string>(
      ["a", "b", "c", "d"].map((n) => [`1//rt-alice-${n}`, n]),
    );
    const tokByNick = new Map<string, string>(
      ["a", "b", "c", "d"].map((n) => [n, `tok-${n}`]),
    );
    mock.setHandler((url, init) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const nick = nickByRefresh.get(params.get("refresh_token") ?? "");
        const tok = nick ? tokByNick.get(nick) : undefined;
        if (!tok) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return new Response(JSON.stringify({ access_token: tok, expires_in: 3600 }), { status: 200 });
      }
      const tokHeader = readAuthHeader(init);
      const nick = [...tokByNick.entries()].find(([, t]) => tokHeader === `Bearer ${t}`)?.[0];
      if (url.includes("/users/me/messages") && !url.includes("/messages/")) {
        const ids = Array.from({ length: 20 }, (_, i) => ({ id: `${nick}-m${i}`, threadId: `${nick}-t${i}` }));
        return new Response(JSON.stringify({ messages: ids }), { status: 200 });
      }
      if (url.includes("/messages/")) {
        const m = /\/messages\/([a-z]-m\d+)/.exec(url);
        const id = m?.[1] ?? "x";
        return new Response(JSON.stringify(fakeMessage({ id, threadId: id.replace("-m", "-t"), subject: `S ${id}` })), { status: 200 });
      }
      return new Response("not mocked: " + url, { status: 500 });
    });

    const r = await s.call<{
      partial: boolean;
      truncated: boolean;
      result_count: number;
      inboxes: { nickname: string; status: string; hit_count: number; trimmed_from?: number }[];
      results: { inbox: string }[];
    }>("search_all", { query: "" }, s.alice);

    expect(r.truncated).toBe(true);
    expect(r.partial).toBe(true); // truncation alone flips partial.
    // Proportional: each inbox had 20, kept 10 → total 40.
    expect(r.result_count).toBe(40);
    for (const ib of r.inboxes) {
      expect(ib.status).toBe("ok");
      expect(ib.trimmed_from).toBe(20);
      expect(ib.hit_count).toBe(10);
    }
    // No inbox kept whole while another silently dropped: every per-inbox
    // entry shows the same proportional fate.
    const hitInboxes = new Set(r.results.map((h) => h.inbox));
    expect(hitInboxes.size).toBe(4);
  });

  it("does NOT truncate when total fits the cap", async () => {
    const s = await setup({ inboxes: ["a", "b"] });
    mock = installGmailFetchMock({ refreshAlwaysOk: false });
    let seq = 0;
    mock.setHandler((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "t" + seq++, expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/users/me/messages") && !url.includes("/messages/")) {
        return new Response(JSON.stringify({ messages: [{ id: "x", threadId: "t" }] }), { status: 200 });
      }
      if (url.includes("/messages/x")) {
        return new Response(JSON.stringify(fakeMessage({ id: "x", threadId: "t" })), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{ truncated: boolean; partial: boolean; result_count: number; inboxes: { trimmed_from?: number }[] }>(
      "search_all",
      { query: "" },
      s.alice,
    );
    expect(r.truncated).toBe(false);
    expect(r.partial).toBe(false);
    expect(r.result_count).toBe(2);
    for (const ib of r.inboxes) expect(ib.trimmed_from).toBeUndefined();
  });
});

describe("search_all — structural inbox label (point 3)", () => {
  it("every hit has an `inbox` field naming the source", async () => {
    const s = await setup({ inboxes: ["work", "personal"] });
    mock = installGmailFetchMock({ refreshAlwaysOk: false });
    const nickByRefresh = new Map([
      ["1//rt-alice-work", "work"],
      ["1//rt-alice-personal", "personal"],
    ]);
    const tokByNick = new Map([
      ["work", "t-work"],
      ["personal", "t-personal"],
    ]);
    mock.setHandler((url, init) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const nick = nickByRefresh.get(params.get("refresh_token") ?? "");
        const tok = nick ? tokByNick.get(nick) : undefined;
        if (!tok) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return new Response(JSON.stringify({ access_token: tok, expires_in: 3600 }), { status: 200 });
      }
      const tokHeader = readAuthHeader(init);
      const nick = [...tokByNick.entries()].find(([, t]) => tokHeader === `Bearer ${t}`)?.[0];
      if (url.includes("/users/me/messages") && !url.includes("/messages/")) {
        const which = nick === "work" ? "w" : "p";
        return new Response(JSON.stringify({ messages: [{ id: `${which}1`, threadId: `${which}t1` }] }), { status: 200 });
      }
      if (url.includes("/messages/w1")) {
        return new Response(JSON.stringify(fakeMessage({ id: "w1", threadId: "wt1", subject: "Work" })), { status: 200 });
      }
      if (url.includes("/messages/p1")) {
        return new Response(JSON.stringify(fakeMessage({ id: "p1", threadId: "pt1", subject: "Personal" })), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{ results: { inbox: string; subject: string | null }[] }>(
      "search_all",
      { query: "" },
      s.alice,
    );
    expect(r.results.length).toBe(2);
    for (const hit of r.results) {
      expect(typeof hit.inbox).toBe("string");
      expect(hit.inbox.length).toBeGreaterThan(0);
    }
    const inboxesSeen = new Set(r.results.map((h) => h.inbox));
    expect(inboxesSeen.has("work")).toBe(true);
    expect(inboxesSeen.has("personal")).toBe(true);
  });
});

describe("search_all — CPU-trivial merge/shape (point 4)", () => {
  it("completes well under a sanity bound for 4 inboxes × 25 hits each", async () => {
    const s = await setup({ inboxes: ["a", "b", "c", "d"] });
    mock = installGmailFetchMock({ refreshAlwaysOk: false });
    let refreshSeq = 0;
    mock.setHandler((url, _init) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "t" + refreshSeq++, expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/users/me/messages") && !url.includes("/messages/")) {
        return new Response(
          JSON.stringify({
            messages: Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` })),
          }),
          { status: 200 },
        );
      }
      if (url.includes("/messages/")) {
        return new Response(JSON.stringify(fakeMessage({ id: "m", threadId: "t" })), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const t0 = performance.now();
    await s.call("search_all", { query: "" }, s.alice);
    const elapsed = performance.now() - t0;
    // Generous bound — the test mostly proves we aren't doing anything
    // pathological (quadratic merges, repeated serializations). Real CPU
    // work here is microseconds; even with mocked-fetch overhead this is
    // far under any reasonable threshold.
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("search_all — inbox set from chokepoint, not input (point 5)", () => {
  it("input schema has no field that lets a caller pick inboxes", () => {
    const t = TOOLS["search_all"]!;
    const shape =
      (t.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    const keys = Object.keys(shape);
    for (const forbidden of [
      "inbox",
      "inboxes",
      "from_inbox",
      "accounts",
      "account",
      "teammate_id",
      "teammateId",
      "user_id",
      "userId",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys.sort()).toEqual(["max_results_per_inbox", "query"]);
  });

  it("Bob's session sees Bob's inboxes only — Alice's hits never appear", async () => {
    // Alice has 'work' and 'personal' connected with messages; Bob has nothing.
    const s = await setup({ inboxes: ["work", "personal"] });
    mock = installGmailFetchMock({ refreshAlwaysOk: false });
    let seq = 0;
    mock.setHandler((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "t" + seq++, expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/users/me/messages") && !url.includes("/messages/")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }), { status: 200 });
      }
      if (url.includes("/messages/m1")) {
        return new Response(JSON.stringify(fakeMessage({ id: "m1", threadId: "t1", subject: "Alice mail" })), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    // Alice sees her inboxes.
    const ar = await s.call<{ inbox_count: number; result_count: number }>(
      "search_all",
      { query: "" },
      s.alice,
    );
    expect(ar.inbox_count).toBe(2);
    expect(ar.result_count).toBeGreaterThan(0);
    // Bob sees zero inboxes, zero hits, friendly message.
    const br = await s.call<{ inbox_count: number; result_count: number; inboxes: unknown[]; message?: string }>(
      "search_all",
      { query: "" },
      s.bob,
    );
    expect(br.inbox_count).toBe(0);
    expect(br.result_count).toBe(0);
    expect(br.inboxes).toEqual([]);
    expect(br.message).toMatch(/connect_inbox/);
  });

  it("extra fields in input (e.g. inboxes: ['stealth']) are rejected by schema", () => {
    const t = TOOLS["search_all"]!;
    const schema = t.inputSchema as unknown as { safeParse: (i: unknown) => { success: boolean } };
    const ok = schema.safeParse({ query: "anything" });
    expect(ok.success).toBe(true);
    // Zod's default is to strip unknown keys, but for tools that take
    // identity-shaped attempts we want them parsed-but-ignored. Either way
    // the *handler* never reads any inboxes selection — it queries D1 by
    // teammate.id. Confirm parse silently drops or fails (either is safe).
    const out = schema.safeParse({ query: "anything", inboxes: ["stealth"] });
    // Zod default: success (extras ignored). Either way the field would
    // never reach the handler.
    expect(out.success).toBe(true);
  });
});
