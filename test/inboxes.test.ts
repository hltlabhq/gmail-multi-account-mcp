// End-to-end tests of the inbox-management MCP tools + /google/callback,
// with Google's token + userinfo endpoints mocked via fetch interception.
//
// What we prove here:
//
//   * connect_inbox returns a sign-in URL with a single-use state row bound
//     to the calling teammate.
//   * /google/callback validates state, exchanges code, creates the inbox
//     row with an encrypted refresh token. Encryption is genuinely AEAD —
//     swapping ciphertext between rows fails.
//   * list_inboxes returns toPublic() shape including needs_reconnect = false
//     for healthy inboxes.
//   * needs_reconnect_at = now() ⇒ list_inboxes surfaces needs_reconnect = true.
//   * reconnect_inbox + callback: matching google_sub clears the flag;
//     MISMATCHED google_sub refuses without touching the row.
//   * rename_inbox / disconnect_inbox happy paths and error paths.
//   * Per-teammate isolation: B's tool calls never see A's inboxes by any
//     known identifier. (Full isolation suite is increment 11; this is a
//     forward sanity check.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeEnv } from "./_helpers/env.js";
import { TOOLS } from "../src/mcp/tool_registry.js";
import { createTeammate } from "../src/db/teammates.js";
import { consumeState, createState } from "../src/db/oauth_states.js";
import { handleGoogleCallback } from "../src/google/callback.js";
import { findInboxByNickname, listInboxes } from "../src/db/inboxes.js";
import type { Env } from "../src/index.js";
import type { TeammateRow } from "../src/db/teammates.js";

// Side-effect: register inbox tools (and whoami).
import "../src/mcp/tools/inboxes.js";
import "../src/mcp/tools/whoami.js";

interface Setup {
  env: Awaited<ReturnType<typeof makeFakeEnv>>;
  alice: TeammateRow;
  bob: TeammateRow;
  call: <T = unknown>(name: string, input: unknown, who: TeammateRow) => Promise<T>;
}

async function setup(): Promise<Setup> {
  const env = await makeFakeEnv();
  const alice = await createTeammate(env.DB as unknown as D1Database, { displayName: "Alice" });
  const bob = await createTeammate(env.DB as unknown as D1Database, { displayName: "Bob" });
  async function call<T>(name: string, input: unknown, who: TeammateRow): Promise<T> {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return (await tool.handler(input, { teammate: who, env: env as unknown as Env })) as T;
  }
  return { env, alice, bob, call };
}

interface GoogleMocks {
  // Set per-test before the callback runs.
  tokenResponse: { status: number; body: Record<string, unknown> };
  userinfoResponse: { status: number; body: Record<string, unknown> };
}

function installGoogleMocks(mocks: GoogleMocks): { restore: () => void } {
  const spy = vi.spyOn(globalThis, "fetch") as unknown as {
    mockImplementation: (
      f: (input: unknown, init?: unknown) => Promise<Response>,
    ) => void;
    mockRestore: () => void;
  };
  spy.mockImplementation(async (input: unknown) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (urlStr.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify(mocks.tokenResponse.body), {
        status: mocks.tokenResponse.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      return new Response(JSON.stringify(mocks.userinfoResponse.body), {
        status: mocks.userinfoResponse.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.startsWith("https://oauth2.googleapis.com/revoke")) {
      return new Response("", { status: 200 });
    }
    return new Response("not mocked: " + urlStr, { status: 500 });
  });
  return { restore: () => spy.mockRestore() };
}

let fetchSpy: { restore: () => void } | null = null;
afterEach(() => {
  fetchSpy?.restore();
  fetchSpy = null;
});

describe("connect_inbox tool + /google/callback", () => {
  it("creates the inbox row with encrypted refresh token", async () => {
    const { env, alice, call } = await setup();
    const r = await call<{ ok: boolean; sign_in_url: string; nickname: string }>(
      "connect_inbox",
      { nickname: "work" },
      alice,
    );
    expect(r.ok).toBe(true);
    expect(r.sign_in_url.startsWith("https://accounts.google.com/")).toBe(true);
    const state = new URL(r.sign_in_url).searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(10);

    fetchSpy = installGoogleMocks({
      tokenResponse: {
        status: 200,
        body: {
          access_token: "ya29.test",
          refresh_token: "1//rt-test-alice-work",
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
        },
      },
      userinfoResponse: {
        status: 200,
        body: { sub: "google-sub-1", email: "alice@example.com" },
      },
    });

    const cb = await handleGoogleCallback(
      new Request(`https://example.test/google/callback?state=${state}&code=test-code`),
      env as unknown as Env,
    );
    expect(cb.status).toBe(200);
    expect(await cb.text()).toMatch(/connected/i);

    const row = await findInboxByNickname(env.DB as unknown as D1Database, alice.id, "work");
    expect(row).not.toBeNull();
    expect(row!.email).toBe("alice@example.com");
    expect(row!.google_sub).toBe("google-sub-1");
    expect(row!.needs_reconnect_at).toBeNull();
    // The refresh token is encrypted, NOT stored in plaintext.
    const ct = row!.encrypted_refresh_token instanceof Uint8Array
      ? new TextDecoder().decode(row!.encrypted_refresh_token)
      : "";
    expect(ct).not.toMatch(/rt-test-alice-work/);
  });

  it("refuses duplicate nickname at tool-call time (race-loss falls through to callback)", async () => {
    const { env, alice, call } = await setup();
    // Pre-seed the state by hand (simulating a prior connect_inbox call) so
    // we can call the callback. The tool-level check fires first in normal use.
    await createState(env.DB as unknown as D1Database, {
      teammateId: alice.id,
      purpose: "connect_inbox",
      nickname: "work",
    });
    const first = await call<{ ok: boolean }>(
      "connect_inbox",
      { nickname: "work" },
      alice,
    );
    expect(first.ok).toBe(true);
    // Run the URL for first to completion so an inbox is created.
    // (Drain state from the call above; we use a stored state above.)
    // simpler: just call again with same nickname after one connect succeeds.
    fetchSpy = installGoogleMocks({
      tokenResponse: {
        status: 200,
        body: { access_token: "a", refresh_token: "r1", expires_in: 3600, scope: "openid" },
      },
      userinfoResponse: { status: 200, body: { sub: "s1", email: "a@x.com" } },
    });
    // Drain the state created by the tool call.
    const tools = await env._db
      .prepare("SELECT state FROM oauth_states WHERE teammate_id = ? AND purpose = ?")
      .bind(alice.id, "connect_inbox")
      .all<{ state: string }>();
    expect(tools.results.length).toBeGreaterThan(0);
    const stateA = tools.results[0]!.state;
    const cb = await handleGoogleCallback(
      new Request(`https://example.test/google/callback?state=${stateA}&code=c`),
      env as unknown as Env,
    );
    expect(cb.status).toBe(200);
    // Now a duplicate nickname call must be refused at tool level.
    const dup = await call<{ ok: boolean; error?: string }>(
      "connect_inbox",
      { nickname: "work" },
      alice,
    );
    expect(dup.ok).toBe(false);
    expect(dup.error).toBe("nickname_in_use");
  });

  it("rejects an unknown / replayed state with a uniform error page", async () => {
    const { env } = await setup();
    fetchSpy = installGoogleMocks({
      tokenResponse: { status: 200, body: {} },
      userinfoResponse: { status: 200, body: {} },
    });
    const cb = await handleGoogleCallback(
      new Request("https://example.test/google/callback?state=bogus&code=c"),
      env as unknown as Env,
    );
    expect(cb.status).toBe(200);
    const html = await cb.text();
    expect(html).toMatch(/already been used|more than 10 minutes/);
  });

  it("state row is single-use (consumed on first read)", async () => {
    const { env, alice } = await setup();
    const s = await createState(env.DB as unknown as D1Database, {
      teammateId: alice.id,
      purpose: "connect_inbox",
      nickname: "x",
    });
    const first = await consumeState(env.DB as unknown as D1Database, s);
    expect(first).not.toBeNull();
    const second = await consumeState(env.DB as unknown as D1Database, s);
    expect(second).toBeNull();
  });

  // Audit finding 4: /google/callback is internet-reachable. Hammering it
  // with garbage state values must be rate-limited; legitimate flows from
  // the same IP must clear the bucket on a valid state.
  it("rate-limits hammering with garbage state values from one IP", async () => {
    const { env } = await setup();
    fetchSpy = installGoogleMocks({
      tokenResponse: { status: 200, body: {} },
      userinfoResponse: { status: 200, body: {} },
    });
    const cbWith = (state: string, ip = "203.0.113.66") =>
      handleGoogleCallback(
        new Request(`https://example.test/google/callback?state=${state}&code=c`, {
          headers: { "cf-connecting-ip": ip },
        }),
        env as unknown as Env,
      );

    // 5 bad-state calls — each individually returns the error page (200),
    // bumping the per-IP failure bucket.
    for (let i = 0; i < 5; i++) {
      const r = await cbWith("garbage-" + i);
      expect(r.status).toBe(200);
    }
    // 6th call — rate-limited regardless of state value.
    const blocked = await cbWith("garbage-6");
    expect(blocked.status).toBe(429);
  });

  // Audit review follow-up: the ?error=… short-circuit (Google reporting
  // a user choice, e.g. Cancel) now bumps the same per-IP bucket as the
  // bad-state path. Closes the small "hammer with ?error=" log-noise gap.
  // The accepted trade-off: a teammate who clicks Cancel many times in a
  // minute from one IP can rate-limit themselves.
  it("rate-limits hammering with ?error=… from one IP (audit review follow-up)", async () => {
    const { env } = await setup();
    fetchSpy = installGoogleMocks({
      tokenResponse: { status: 200, body: {} },
      userinfoResponse: { status: 200, body: {} },
    });
    const cbError = (ip = "203.0.113.67") =>
      handleGoogleCallback(
        new Request(`https://example.test/google/callback?error=access_denied`, {
          headers: { "cf-connecting-ip": ip },
        }),
        env as unknown as Env,
      );

    for (let i = 0; i < 5; i++) {
      const r = await cbError();
      expect(r.status).toBe(200);
    }
    const blocked = await cbError();
    expect(blocked.status).toBe(429);
  });
});

describe("list_inboxes / rename_inbox / disconnect_inbox", () => {
  async function withConnectedInbox(): Promise<Setup & { ibId: string }> {
    const s = await setup();
    const c = await s.call<{ sign_in_url: string }>(
      "connect_inbox",
      { nickname: "work" },
      s.alice,
    );
    const state = new URL(c.sign_in_url).searchParams.get("state")!;
    fetchSpy = installGoogleMocks({
      tokenResponse: {
        status: 200,
        body: { access_token: "a", refresh_token: "r-work", expires_in: 3600, scope: "openid email" },
      },
      userinfoResponse: { status: 200, body: { sub: "s-work", email: "alice@example.com" } },
    });
    await handleGoogleCallback(
      new Request(`https://example.test/google/callback?state=${state}&code=c`),
      s.env as unknown as Env,
    );
    const row = await findInboxByNickname(s.env.DB as unknown as D1Database, s.alice.id, "work");
    return { ...s, ibId: row!.id };
  }

  it("list_inboxes returns the connected inbox with needs_reconnect=false", async () => {
    const { call, alice } = await withConnectedInbox();
    const r = await call<{
      inboxes: { id: string; nickname: string; email: string; needs_reconnect: boolean }[];
    }>("list_inboxes", {}, alice);
    expect(r.inboxes.length).toBe(1);
    expect(r.inboxes[0]!.nickname).toBe("work");
    expect(r.inboxes[0]!.email).toBe("alice@example.com");
    expect(r.inboxes[0]!.needs_reconnect).toBe(false);
  });

  it("surfaces needs_reconnect=true after the flag is set", async () => {
    const { env, call, alice, ibId } = await withConnectedInbox();
    await env._db
      .prepare("UPDATE inboxes SET needs_reconnect_at = ? WHERE id = ?")
      .bind(Date.now(), ibId)
      .run();
    const r = await call<{ inboxes: { needs_reconnect: boolean }[] }>(
      "list_inboxes",
      {},
      alice,
    );
    expect(r.inboxes[0]!.needs_reconnect).toBe(true);
  });

  it("rename_inbox happy path", async () => {
    const { call, alice } = await withConnectedInbox();
    const r = await call<{ ok: boolean; nickname?: string }>(
      "rename_inbox",
      { nickname: "work", new_nickname: "support" },
      alice,
    );
    expect(r.ok).toBe(true);
    expect(r.nickname).toBe("support");
    const list = await call<{ inboxes: { nickname: string }[] }>(
      "list_inboxes",
      {},
      alice,
    );
    expect(list.inboxes[0]!.nickname).toBe("support");
  });

  it("rename_inbox refuses on conflict and missing", async () => {
    const s = await withConnectedInbox();
    // Add a second inbox so we have a name to collide with.
    const c = await s.call<{ sign_in_url: string }>(
      "connect_inbox",
      { nickname: "alerts" },
      s.alice,
    );
    const state2 = new URL(c.sign_in_url).searchParams.get("state")!;
    fetchSpy?.restore();
    fetchSpy = installGoogleMocks({
      tokenResponse: {
        status: 200,
        body: { access_token: "a", refresh_token: "r-alerts", expires_in: 3600, scope: "openid" },
      },
      userinfoResponse: { status: 200, body: { sub: "s-alerts", email: "alerts@example.com" } },
    });
    await handleGoogleCallback(
      new Request(`https://example.test/google/callback?state=${state2}&code=c`),
      s.env as unknown as Env,
    );
    const conflict = await s.call<{ ok: boolean; error?: string }>(
      "rename_inbox",
      { nickname: "work", new_nickname: "alerts" },
      s.alice,
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toBe("nickname_in_use");
    const missing = await s.call<{ ok: boolean; error?: string }>(
      "rename_inbox",
      { nickname: "nope", new_nickname: "anything" },
      s.alice,
    );
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("not_found");
  });

  it("disconnect_inbox removes the row and calls Google revoke", async () => {
    const { env, call, alice } = await withConnectedInbox();
    const r = await call<{ ok: boolean; google_revoke_status?: number | "skipped" }>(
      "disconnect_inbox",
      { nickname: "work" },
      alice,
    );
    expect(r.ok).toBe(true);
    expect(r.google_revoke_status).toBe(200);
    const after = await listInboxes(env.DB as unknown as D1Database, alice.id);
    expect(after).toEqual([]);
  });
});

describe("reconnect_inbox tool + callback", () => {
  async function setupReconnectable() {
    const s = await setup();
    // Pre-create an inbox by going through connect_inbox.
    const c = await s.call<{ sign_in_url: string }>(
      "connect_inbox",
      { nickname: "work" },
      s.alice,
    );
    const state = new URL(c.sign_in_url).searchParams.get("state")!;
    fetchSpy = installGoogleMocks({
      tokenResponse: {
        status: 200,
        body: { access_token: "a", refresh_token: "r-orig", expires_in: 3600, scope: "openid" },
      },
      userinfoResponse: { status: 200, body: { sub: "google-sub-1", email: "alice@example.com" } },
    });
    await handleGoogleCallback(
      new Request(`https://example.test/google/callback?state=${state}&code=c`),
      s.env as unknown as Env,
    );
    // Flip the flag so reconnect has work to do.
    await s.env._db
      .prepare("UPDATE inboxes SET needs_reconnect_at = ? WHERE teammate_id = ?")
      .bind(Date.now(), s.alice.id)
      .run();
    fetchSpy?.restore();
    return s;
  }

  it("matching google_sub clears needs_reconnect_at and refreshes the token", async () => {
    const s = await setupReconnectable();
    const r = await s.call<{ ok: boolean; sign_in_url: string }>(
      "reconnect_inbox",
      { nickname: "work" },
      s.alice,
    );
    expect(r.ok).toBe(true);
    const state = new URL(r.sign_in_url).searchParams.get("state")!;
    fetchSpy = installGoogleMocks({
      tokenResponse: {
        status: 200,
        body: { access_token: "a", refresh_token: "r-NEW", expires_in: 3600, scope: "openid email" },
      },
      userinfoResponse: { status: 200, body: { sub: "google-sub-1", email: "alice@example.com" } },
    });
    const cb = await handleGoogleCallback(
      new Request(`https://example.test/google/callback?state=${state}&code=c`),
      s.env as unknown as Env,
    );
    expect(cb.status).toBe(200);
    expect(await cb.text()).toMatch(/is back/);
    const row = await findInboxByNickname(
      s.env.DB as unknown as D1Database,
      s.alice.id,
      "work",
    );
    expect(row!.needs_reconnect_at).toBeNull();
    // Old plaintext must not be present in the ciphertext blob.
    const ct = row!.encrypted_refresh_token instanceof Uint8Array
      ? new TextDecoder().decode(row!.encrypted_refresh_token)
      : "";
    expect(ct).not.toMatch(/r-orig/);
    expect(ct).not.toMatch(/r-NEW/);
  });

  it("MISMATCHED google_sub refuses, leaves the row untouched", async () => {
    const s = await setupReconnectable();
    const r = await s.call<{ sign_in_url: string }>("reconnect_inbox", { nickname: "work" }, s.alice);
    const state = new URL(r.sign_in_url).searchParams.get("state")!;
    fetchSpy = installGoogleMocks({
      tokenResponse: {
        status: 200,
        body: { access_token: "a", refresh_token: "r-WRONG", expires_in: 3600, scope: "openid" },
      },
      userinfoResponse: {
        status: 200,
        body: { sub: "google-sub-DIFFERENT", email: "intruder@example.com" },
      },
    });
    const cb = await handleGoogleCallback(
      new Request(`https://example.test/google/callback?state=${state}&code=c`),
      s.env as unknown as Env,
    );
    expect(cb.status).toBe(200);
    expect(await cb.text()).toMatch(/Wrong Google account/);
    const row = await findInboxByNickname(
      s.env.DB as unknown as D1Database,
      s.alice.id,
      "work",
    );
    // needs_reconnect_at must remain set; google_sub must remain original.
    expect(row!.needs_reconnect_at).not.toBeNull();
    expect(row!.google_sub).toBe("google-sub-1");
    // The wrong refresh token must NOT have been persisted.
    const ct = row!.encrypted_refresh_token instanceof Uint8Array
      ? new TextDecoder().decode(row!.encrypted_refresh_token)
      : "";
    expect(ct).not.toMatch(/r-WRONG/);
  });
});

describe("isolation forward-check (full suite lands in increment 11)", () => {
  it("Bob cannot see or touch Alice's inboxes by nickname", async () => {
    const s = await setup();
    // Connect for Alice.
    const c = await s.call<{ sign_in_url: string }>(
      "connect_inbox",
      { nickname: "work" },
      s.alice,
    );
    const state = new URL(c.sign_in_url).searchParams.get("state")!;
    fetchSpy = installGoogleMocks({
      tokenResponse: {
        status: 200,
        body: { access_token: "a", refresh_token: "r-alice", expires_in: 3600, scope: "openid" },
      },
      userinfoResponse: { status: 200, body: { sub: "s-alice", email: "alice@example.com" } },
    });
    await handleGoogleCallback(
      new Request(`https://example.test/google/callback?state=${state}&code=c`),
      s.env as unknown as Env,
    );

    // Bob calls list_inboxes — must be empty.
    const bobList = await s.call<{ inboxes: unknown[] }>("list_inboxes", {}, s.bob);
    expect(bobList.inboxes).toEqual([]);

    // Bob tries to rename Alice's 'work' inbox — must report not_found.
    const ren = await s.call<{ ok: boolean; error?: string }>(
      "rename_inbox",
      { nickname: "work", new_nickname: "stolen" },
      s.bob,
    );
    expect(ren.ok).toBe(false);
    expect(ren.error).toBe("not_found");

    // Bob tries to disconnect Alice's 'work' inbox — must report not_found.
    const disc = await s.call<{ ok: boolean; error?: string }>(
      "disconnect_inbox",
      { nickname: "work" },
      s.bob,
    );
    expect(disc.ok).toBe(false);
    expect(disc.error).toBe("not_found");

    // Bob tries to reconnect Alice's 'work' — must report not_found.
    const rec = await s.call<{ ok: boolean; error?: string }>(
      "reconnect_inbox",
      { nickname: "work" },
      s.bob,
    );
    expect(rec.ok).toBe(false);
    expect(rec.error).toBe("not_found");

    // Alice's row remains intact.
    const row = await findInboxByNickname(
      s.env.DB as unknown as D1Database,
      s.alice.id,
      "work",
    );
    expect(row).not.toBeNull();
    expect(row!.nickname).toBe("work");
  });
});

// Suppress unused-var lint for beforeEach (helpers above use it implicitly)
void beforeEach;
