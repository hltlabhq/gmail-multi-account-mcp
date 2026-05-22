// Tests for the single-inbox MCP tools (search_one, list_messages,
// get_thread, list_drafts, create_draft, update_draft, send_message,
// list_labels, create_label, update_label, delete_label, label_message,
// unlabel_message, label_thread, unlabel_thread).
//
// Emphasis is on contract-level guarantees rather than exhaustive Gmail
// API coverage:
//
//   * Every result names the inbox it came from.
//   * Drafts and updates never send mail.
//   * send_message always names the sending inbox in the response.
//   * needs_reconnect: tools refuse before any Gmail call; refresh that
//     returns invalid_grant flips the flag and surfaces a uniform "reconnect"
//     message.
//   * Per-teammate isolation: Bob can't reach Alice's inbox by any nickname
//     OR thread/message id.
//   * Body shaping: a thread larger than the per-message cap is truncated.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeFakeEnv } from "./_helpers/env.js";
import { TOOLS } from "../src/mcp/tool_registry.js";
import { createTeammate } from "../src/db/teammates.js";
import { createInbox, findInboxByNickname, markNeedsReconnect } from "../src/db/inboxes.js";
import { installGmailFetchMock, fakeMessage } from "./_helpers/gmail_mock.js";
import type { Env } from "../src/index.js";
import type { TeammateRow } from "../src/db/teammates.js";

// Side-effect registers all tools.
import "../src/mcp/tools/whoami.js";
import "../src/mcp/tools/inboxes.js";
import "../src/mcp/tools/messages.js";
import "../src/mcp/tools/drafts.js";
import "../src/mcp/tools/send.js";
import "../src/mcp/tools/labels.js";

beforeAll(() => {
  // Boot-time forbidden-key check has already run via the side-effect
  // imports above. If any tool tried to take an identity-shaped input,
  // module load would have thrown. This is a tripwire reassertion.
  for (const tool of Object.values(TOOLS)) {
    const shape =
      (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    for (const forbidden of [
      "teammate_id",
      "teammateId",
      "user_id",
      "userId",
      "team_key",
    ]) {
      expect(forbidden in shape).toBe(false);
    }
  }
});

interface Setup {
  env: Awaited<ReturnType<typeof makeFakeEnv>>;
  alice: TeammateRow;
  bob: TeammateRow;
  ibAliceWork: string; // id
  call<T = unknown>(name: string, input: unknown, who: TeammateRow): Promise<T>;
}

async function setup(): Promise<Setup> {
  const env = await makeFakeEnv();
  const alice = await createTeammate(env.DB as unknown as D1Database, { displayName: "Alice" });
  const bob = await createTeammate(env.DB as unknown as D1Database, { displayName: "Bob" });
  // Seed an Alice/work inbox directly via createInbox (skip the OAuth dance;
  // that path is covered in test/inboxes.test.ts).
  const { id: ibAliceWork } = await createInbox(
    env.DB as unknown as D1Database,
    env.AES_MASTER_KEY,
    {
      teammateId: alice.id,
      nickname: "work",
      email: "alice@example.com",
      googleSub: "google-sub-alice-work",
      refreshToken: "1//rt-alice-work",
      scopes: "openid email https://www.googleapis.com/auth/gmail.modify",
    },
  );
  async function call<T>(name: string, input: unknown, who: TeammateRow): Promise<T> {
    const tool = TOOLS[name];
    if (!tool) throw new Error("unknown tool " + name);
    return (await tool.handler(input, { teammate: who, env: env as unknown as Env })) as T;
  }
  return { env, alice, bob, ibAliceWork, call };
}

let mock: ReturnType<typeof installGmailFetchMock> | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
});

describe("search_one + list_messages", () => {
  it("returns hits labeled with the inbox nickname", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    mock.setHandler((url) => {
      if (url.includes("/users/me/messages") && !url.includes("/messages/")) {
        return new Response(
          JSON.stringify({
            messages: [
              { id: "m1", threadId: "t1" },
              { id: "m2", threadId: "t2" },
            ],
            resultSizeEstimate: 2,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/messages/m1")) {
        return new Response(JSON.stringify(fakeMessage({ id: "m1", threadId: "t1", subject: "Hello A" })), { status: 200 });
      }
      if (url.includes("/messages/m2")) {
        return new Response(JSON.stringify(fakeMessage({ id: "m2", threadId: "t2", subject: "Hello B" })), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{
      ok: boolean;
      inbox: string;
      results: { inbox: string; subject: string | null }[];
    }>("search_one", { inbox: "work", query: "anything" }, s.alice);
    expect(r.ok).toBe(true);
    expect(r.inbox).toBe("work");
    expect(r.results.length).toBe(2);
    for (const hit of r.results) {
      expect(hit.inbox).toBe("work");
    }
    expect(r.results[0]!.subject).toBe("Hello A");
  });

  it("list_messages is just search with empty query, still labels by inbox", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    mock.setHandler((url) => {
      if (url.includes("/users/me/messages") && !url.includes("/messages/")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }), { status: 200 });
      }
      if (url.includes("/messages/m1")) {
        return new Response(JSON.stringify(fakeMessage({ id: "m1", threadId: "t1" })), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{ inbox: string; results: { inbox: string }[] }>(
      "list_messages",
      { inbox: "work" },
      s.alice,
    );
    expect(r.inbox).toBe("work");
    expect(r.results[0]!.inbox).toBe("work");
  });

  it("refuses if inbox is in needs_reconnect state", async () => {
    const s = await setup();
    await markNeedsReconnect(s.env.DB as unknown as D1Database, s.alice.id, s.ibAliceWork);
    // No mock needed; the tool refuses before any Gmail call.
    const r = await s.call<{ error: string; inbox: string; message: string }>(
      "search_one",
      { inbox: "work", query: "" },
      s.alice,
    );
    expect(r.error).toBe("needs_reconnect");
    expect(r.inbox).toBe("work");
    expect(r.message).toMatch(/reconnect_inbox/);
  });
});

describe("get_thread shaping", () => {
  it("decodes bodies, truncates long bodies, caps the messages-per-thread", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    const longBody = "x".repeat(5000);
    mock.setHandler((url) => {
      if (url.includes("/threads/t1")) {
        // 30 messages — past the THREAD_MAX_MESSAGES cap (25).
        const messages = Array.from({ length: 30 }, (_, i) =>
          fakeMessage({
            id: `m${i}`,
            threadId: "t1",
            subject: `Msg ${i}`,
            bodyText: i === 0 ? longBody : "short",
          }),
        );
        return new Response(JSON.stringify({ id: "t1", messages }), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{
      ok: boolean;
      inbox: string;
      thread_id: string;
      message_count: number;
      thread_truncated: boolean;
      messages: { body: string; body_truncated: boolean }[];
    }>("get_thread", { inbox: "work", thread_id: "t1" }, s.alice);
    expect(r.ok).toBe(true);
    expect(r.inbox).toBe("work");
    expect(r.thread_id).toBe("t1");
    expect(r.thread_truncated).toBe(true);
    expect(r.message_count).toBe(25);
    expect(r.messages[0]!.body_truncated).toBe(true);
    expect(r.messages[0]!.body.length).toBeLessThanOrEqual(4096);
    expect(r.messages[1]!.body).toMatch(/short/);
  });
});

describe("drafts", () => {
  // Fix 1 (live-session bug): create_draft / update_draft used to return the
  // message.id and message.threadId from the drafts.create / drafts.update
  // response directly. Gmail's create/update response can carry IDs that
  // get_thread / messages.get can't resolve in the same session — drafts
  // have to be refetched via drafts.get for the canonical IDs.
  //
  // The mock below returns DIFFERENT IDs from POST/PUT vs GET so the test
  // proves the tool refetches: it must return the GET IDs ("canonical-…")
  // rather than the POST IDs ("stale-…"). The cross-tool round trip
  // (create_draft → get_thread) lives in the workers pool — see
  // test/integration/draft_roundtrip.test.ts.
  it("create_draft refetches via drafts.get and returns canonical IDs", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    mock.setHandler((url, init) => {
      if (url.endsWith("/users/me/drafts") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { message: { raw: string } };
        expect(typeof body.message.raw).toBe("string"); // base64url RFC 822
        // "Stale" IDs — like Gmail returns from create but get_thread won't accept.
        return new Response(
          JSON.stringify({ id: "draft-1", message: { id: "stale-m", threadId: "stale-t" } }),
          { status: 200 },
        );
      }
      if (url.includes("/users/me/drafts/draft-1") && (init?.method ?? "GET") === "GET") {
        // The refetch returns canonical IDs.
        return new Response(
          JSON.stringify({
            id: "draft-1",
            message: { id: "canonical-m", threadId: "canonical-t" },
          }),
          { status: 200 },
        );
      }
      return new Response("not mocked: " + url + " " + (init?.method ?? "GET"), { status: 500 });
    });
    const r = await s.call<{
      ok: boolean;
      inbox: string;
      draft_id: string;
      message_id: string | null;
      thread_id: string | null;
      message: string;
    }>("create_draft", {
      inbox: "work",
      to: ["alice@example.com"],
      subject: "Hi",
      body: "Body text",
    }, s.alice);
    expect(r.ok).toBe(true);
    expect(r.inbox).toBe("work");
    expect(r.draft_id).toBe("draft-1");
    // Canonical (refetched) IDs, NOT the stale ones from the create response.
    expect(r.message_id).toBe("canonical-m");
    expect(r.thread_id).toBe("canonical-t");
    expect(r.message).toMatch(/Nothing has been sent/);
  });

  it("update_draft refetches via drafts.get and returns canonical IDs", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    mock.setHandler((url, init) => {
      if (url.includes("/drafts/draft-1") && init?.method === "PUT") {
        return new Response(
          JSON.stringify({ id: "draft-1", message: { id: "stale-m", threadId: "stale-t" } }),
          { status: 200 },
        );
      }
      if (url.includes("/drafts/draft-1") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            id: "draft-1",
            message: { id: "canonical-m", threadId: "canonical-t" },
          }),
          { status: 200 },
        );
      }
      return new Response("not mocked: " + url + " " + (init?.method ?? "GET"), { status: 500 });
    });
    const r = await s.call<{
      ok: boolean;
      message_id: string | null;
      thread_id: string | null;
      message: string;
    }>(
      "update_draft",
      {
        inbox: "work",
        draft_id: "draft-1",
        to: ["bob@example.com"],
        subject: "Update",
        body: "new",
      },
      s.alice,
    );
    expect(r.ok).toBe(true);
    expect(r.message_id).toBe("canonical-m");
    expect(r.thread_id).toBe("canonical-t");
    expect(r.message).toMatch(/Nothing has been sent/);
  });

  it("delete_draft issues users.drafts.delete and reports success", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    let deleteCalled = false;
    mock.setHandler((url, init) => {
      if (url.includes("/users/me/drafts/draft-99") && init?.method === "DELETE") {
        deleteCalled = true;
        // Gmail returns 204 No Content for a successful drafts.delete.
        return new Response(null, { status: 204 });
      }
      return new Response("not mocked: " + url + " " + (init?.method ?? "GET"), { status: 500 });
    });
    const r = await s.call<{
      ok: boolean;
      inbox: string;
      draft_id: string;
      deleted: boolean;
      message: string;
    }>("delete_draft", { inbox: "work", draft_id: "draft-99" }, s.alice);
    expect(deleteCalled).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.inbox).toBe("work");
    expect(r.draft_id).toBe("draft-99");
    expect(r.deleted).toBe(true);
    expect(r.message).toMatch(/deleted from 'work'/);
  });

  it("delete_draft surfaces a structured error when Gmail rejects the call", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    mock.setHandler((url, init) => {
      if (url.includes("/users/me/drafts/no-such") && init?.method === "DELETE") {
        return new Response("not found", { status: 404 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{
      ok: boolean;
      error?: string;
      message?: string;
    }>("delete_draft", { inbox: "work", draft_id: "no-such" }, s.alice);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("gmail_error");
    // No raw 404 body leaks — Finding-2 audit invariant.
    expect(r.message).not.toMatch(/not found/);
  });

  it("delete_draft refuses when the inbox doesn't belong to the teammate", async () => {
    const s = await setup();
    const r = await s.call<{ error?: string }>(
      "delete_draft",
      { inbox: "nope", draft_id: "draft-1" },
      s.alice,
    );
    expect(r.error).toBe("not_found");
  });
});

describe("send_message", () => {
  it("always names the sending inbox in the response", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    mock.setHandler((url, init) => {
      if (url.endsWith("/users/me/messages/send") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "sent-1", threadId: "t-1" }), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{
      ok: boolean;
      sent_from_inbox: string;
      sent_from_email: string;
      message_id: string;
      message: string;
    }>("send_message", {
      from_inbox: "work",
      to: ["someone@example.com"],
      subject: "Hi",
      body: "Body",
    }, s.alice);
    expect(r.ok).toBe(true);
    expect(r.sent_from_inbox).toBe("work");
    expect(r.sent_from_email).toBe("alice@example.com");
    expect(r.message_id).toBe("sent-1");
    expect(r.message).toContain("work");
    expect(r.message).toContain("alice@example.com");
  });

  it("requires explicit from_inbox (no default; schema rejects missing field)", () => {
    const tool = TOOLS["send_message"]!;
    const result = (tool.inputSchema as unknown as {
      safeParse: (i: unknown) => { success: boolean };
    }).safeParse({
      to: ["x@example.com"],
      body: "no from_inbox here",
    });
    expect(result.success).toBe(false);
  });
});

describe("labels", () => {
  it("list_labels returns labels for the named inbox", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    mock.setHandler((url) => {
      if (url.endsWith("/users/me/labels")) {
        return new Response(JSON.stringify({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "L1", name: "Priority", type: "user" },
          ],
        }), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{ inbox: string; labels: { name: string }[] }>(
      "list_labels",
      { inbox: "work" },
      s.alice,
    );
    expect(r.inbox).toBe("work");
    expect(r.labels.map((l) => l.name)).toEqual(["INBOX", "Priority"]);
  });

  it("label_message refuses on unknown label name with structured error", async () => {
    const s = await setup();
    mock = installGmailFetchMock();
    mock.setHandler((url) => {
      if (url.endsWith("/users/me/labels")) {
        return new Response(JSON.stringify({ labels: [{ id: "L1", name: "Priority" }] }), { status: 200 });
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{ ok: boolean; error?: string; missing?: string[] }>(
      "label_message",
      { inbox: "work", message_id: "m1", add: ["Priority", "DoesNotExist"] },
      s.alice,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("label_not_found");
    expect(r.missing).toContain("DoesNotExist");
  });
});

describe("needs_reconnect on invalid_grant during refresh", () => {
  it("flips the flag when Google returns 400 invalid_grant on token refresh", async () => {
    const s = await setup();
    mock = installGmailFetchMock({ refreshAlwaysOk: false });
    mock.setHandler((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 500 });
    });
    const r = await s.call<{ error: string; message: string }>(
      "search_one",
      { inbox: "work", query: "anything" },
      s.alice,
    );
    expect(r.error).toBe("needs_reconnect");
    expect(r.message).toMatch(/reconnect_inbox/);
    const row = await findInboxByNickname(s.env.DB as unknown as D1Database, s.alice.id, "work");
    expect(row!.needs_reconnect_at).not.toBeNull();
  });
});

describe("per-teammate isolation forward-check", () => {
  it("Bob calling search_one on 'work' returns not_found (it's Alice's inbox)", async () => {
    const s = await setup();
    const r = await s.call<{ error?: string; inbox?: string; results?: unknown }>(
      "search_one",
      { inbox: "work", query: "" },
      s.bob,
    );
    expect(r.error).toBe("not_found");
    expect(r.results).toBeUndefined();
  });

  it("Bob cannot send_message via Alice's 'work' inbox", async () => {
    const s = await setup();
    const r = await s.call<{ error?: string }>(
      "send_message",
      {
        from_inbox: "work",
        to: ["recipient@example.com"],
        subject: "spoof",
        body: "Bob trying to send from Alice's inbox",
      },
      s.bob,
    );
    expect(r.error).toBe("not_found");
  });
});
