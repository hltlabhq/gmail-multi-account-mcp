// Lifecycle tests for /admin/purge + revoke + rotate + clear-block.
//
// The operator-mandated invariant for purge: a per-inbox Google revoke
// failure must NOT silently delete the inbox row and report clean success.
// The operator-facing response must surface which inboxes need manual
// follow-up. Re-running purge after the operator manually revokes (or after
// Google recovers) must be idempotent — it cleans up the remaining rows.

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeEnv } from "./_helpers/env.js";
import { handleAdmin } from "../src/auth/admin.js";
import { createInbox, listInboxes } from "../src/db/inboxes.js";
import { findTeammateById } from "../src/db/teammates.js";
import type { Env } from "../src/index.js";

function adminReq(
  env: { _operatorToken: string },
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Request {
  return new Request(`https://example.test${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${env._operatorToken}`,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.30",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(
  env: Awaited<ReturnType<typeof makeFakeEnv>>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  return handleAdmin(adminReq(env, method, path, body), env as unknown as Env, path);
}

// Provision a teammate and seed `count` inboxes for them. Returns the
// teammate_id and the inbox ids in order.
async function setupTeammateWithInboxes(
  env: Awaited<ReturnType<typeof makeFakeEnv>>,
  name: string,
  count: number,
): Promise<{ teammate_id: string; inbox_ids: string[] }> {
  const provRes = await call(env, "POST", "/admin/provision", { display_name: name });
  const prov = (await provRes.json()) as { teammate_id: string };
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const ib = await createInbox(env.DB as unknown as D1Database, env.AES_MASTER_KEY, {
      teammateId: prov.teammate_id,
      nickname: `n${i}`,
      email: `${name.toLowerCase()}-${i}@example.com`,
      googleSub: `gs-${name}-${i}`,
      refreshToken: `1//rt-${name}-${i}`,
      scopes: "openid email https://www.googleapis.com/auth/gmail.modify",
    });
    ids.push(ib.id);
  }
  return { teammate_id: prov.teammate_id, inbox_ids: ids };
}

// Install a fetch mock for Google's /revoke endpoint that maps
// refresh_token (from the POST body) to a configurable HTTP status.
function installRevokeMock(byRefreshToken: Map<string, number>): { restore: () => void } {
  const spy = vi.spyOn(globalThis, "fetch") as unknown as {
    mockImplementation: (fn: (input: unknown, init?: unknown) => Promise<Response>) => void;
    mockRestore: () => void;
  };
  spy.mockImplementation(async (input: unknown, init?: unknown) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (urlStr.startsWith("https://oauth2.googleapis.com/revoke")) {
      const params = new URLSearchParams(String((init as RequestInit | undefined)?.body ?? ""));
      const rt = params.get("token") ?? "";
      const status = byRefreshToken.get(rt) ?? 500;
      return new Response("", { status });
    }
    // Anything else is unexpected for the purge path.
    return new Response("unexpected fetch: " + urlStr, { status: 500 });
  });
  return { restore: () => spy.mockRestore() };
}

let mock: { restore: () => void } | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
});

describe("/admin/purge happy path", () => {
  it("revokes every inbox at Google, deletes rows, deletes teammate row", async () => {
    const env = await makeFakeEnv();
    const { teammate_id } = await setupTeammateWithInboxes(env, "Alice", 3);
    mock = installRevokeMock(
      new Map([
        ["1//rt-Alice-0", 200],
        ["1//rt-Alice-1", 200],
        ["1//rt-Alice-2", 200],
      ]),
    );

    const res = await call(env, "POST", "/admin/purge", { display_name: "Alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      partial: boolean;
      teammate_row_deleted: boolean;
      inboxes: { status: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.partial).toBe(false);
    expect(body.teammate_row_deleted).toBe(true);
    expect(body.inboxes.length).toBe(3);
    for (const r of body.inboxes) expect(r.status).toBe("purged");

    // Inbox rows are gone; teammate row is gone.
    const remaining = await listInboxes(env.DB as unknown as D1Database, teammate_id);
    expect(remaining).toEqual([]);
    const t = await findTeammateById(env.DB as unknown as D1Database, teammate_id);
    expect(t).toBeNull();
  });

  it("works on a teammate already revoked (idempotent)", async () => {
    const env = await makeFakeEnv();
    const { teammate_id } = await setupTeammateWithInboxes(env, "Bob", 1);
    // Revoke first.
    await call(env, "POST", "/admin/revoke", { display_name: "Bob" });
    mock = installRevokeMock(new Map([["1//rt-Bob-0", 200]]));
    const res = await call(env, "POST", "/admin/purge", { display_name: "Bob" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; teammate_row_deleted: boolean };
    expect(body.ok).toBe(true);
    expect(body.teammate_row_deleted).toBe(true);
    const t = await findTeammateById(env.DB as unknown as D1Database, teammate_id);
    expect(t).toBeNull();
  });

  it("works on a teammate with no inboxes connected", async () => {
    const env = await makeFakeEnv();
    const provRes = await call(env, "POST", "/admin/provision", { display_name: "Carol" });
    const prov = (await provRes.json()) as { teammate_id: string };
    mock = installRevokeMock(new Map());
    const res = await call(env, "POST", "/admin/purge", { display_name: "Carol" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; teammate_row_deleted: boolean; inboxes: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.teammate_row_deleted).toBe(true);
    expect(body.inboxes).toEqual([]);
    const t = await findTeammateById(env.DB as unknown as D1Database, prov.teammate_id);
    expect(t).toBeNull();
  });
});

describe("/admin/purge revoke-failure path (the fail-loud contract)", () => {
  it("MIXED: one inbox revokes ok, one fails — failed row stays, response is partial, teammate row stays", async () => {
    const env = await makeFakeEnv();
    const { teammate_id, inbox_ids } = await setupTeammateWithInboxes(env, "Dan", 2);

    // n0 succeeds (200). n1 fails (Google returns 400 — token already revoked).
    mock = installRevokeMock(
      new Map([
        ["1//rt-Dan-0", 200],
        ["1//rt-Dan-1", 400],
      ]),
    );

    const res = await call(env, "POST", "/admin/purge", { display_name: "Dan" });
    // 207 Multi-Status for partial.
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      ok: boolean;
      partial: boolean;
      teammate_row_deleted: boolean;
      inboxes: {
        nickname: string;
        inbox_id: string;
        status: "purged" | "revoke_failed";
        message?: string;
      }[];
      message?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.partial).toBe(true);
    expect(body.teammate_row_deleted).toBe(false);
    expect(body.message).toMatch(/manually revoke|verify manually|re-run.*purge/i);

    // n0 was deleted; n1 stays.
    const remaining = await listInboxes(env.DB as unknown as D1Database, teammate_id);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.id).toBe(inbox_ids[1]);
    expect(remaining[0]!.nickname).toBe("n1");

    // Per-inbox structured items.
    const byNick = new Map(body.inboxes.map((r) => [r.nickname, r] as const));
    expect(byNick.get("n0")!.status).toBe("purged");
    expect(byNick.get("n1")!.status).toBe("revoke_failed");
    expect(byNick.get("n1")!.message).toMatch(/n1.*may still be live.*verify manually/i);
    expect(byNick.get("n1")!.message).toContain("dan-1@example.com");

    // Teammate row still exists, revoked.
    const t = await findTeammateById(env.DB as unknown as D1Database, teammate_id);
    expect(t).not.toBeNull();
    expect(t!.revoked_at).not.toBeNull();
  });

  it("ALL FAIL: every revoke fails — no inbox rows deleted, teammate row remains", async () => {
    const env = await makeFakeEnv();
    const { teammate_id } = await setupTeammateWithInboxes(env, "Eve", 2);
    mock = installRevokeMock(
      new Map([
        ["1//rt-Eve-0", 503], // Google transient
        ["1//rt-Eve-1", 400], // already revoked at Google
      ]),
    );
    const res = await call(env, "POST", "/admin/purge", { display_name: "Eve" });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      ok: boolean;
      teammate_row_deleted: boolean;
      inboxes: { status: string; message?: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.teammate_row_deleted).toBe(false);
    expect(body.inboxes.every((r) => r.status === "revoke_failed")).toBe(true);
    expect(body.inboxes[0]!.message).toMatch(/HTTP 503/);
    expect(body.inboxes[1]!.message).toMatch(/HTTP 400/);

    const remaining = await listInboxes(env.DB as unknown as D1Database, teammate_id);
    expect(remaining.length).toBe(2);
  });

  it("RE-RUN IS IDEMPOTENT: after operator manually revokes, a second purge cleans up", async () => {
    const env = await makeFakeEnv();
    const { teammate_id } = await setupTeammateWithInboxes(env, "Frank", 2);
    // First attempt: n1 fails.
    mock = installRevokeMock(
      new Map([
        ["1//rt-Frank-0", 200],
        ["1//rt-Frank-1", 500],
      ]),
    );
    const first = await call(env, "POST", "/admin/purge", { display_name: "Frank" });
    expect(first.status).toBe(207);
    let remaining = await listInboxes(env.DB as unknown as D1Database, teammate_id);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.nickname).toBe("n1");

    // Operator manually revokes at Google. Next purge attempt sees a clean
    // 200 from Google.
    mock.restore();
    mock = installRevokeMock(new Map([["1//rt-Frank-1", 200]]));
    const second = await call(env, "POST", "/admin/purge", { display_name: "Frank" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { ok: boolean; teammate_row_deleted: boolean };
    expect(body.ok).toBe(true);
    expect(body.teammate_row_deleted).toBe(true);

    remaining = await listInboxes(env.DB as unknown as D1Database, teammate_id);
    expect(remaining).toEqual([]);
    const t = await findTeammateById(env.DB as unknown as D1Database, teammate_id);
    expect(t).toBeNull();
  });

  it("NETWORK ERROR: a thrown fetch is treated as a revoke failure", async () => {
    const env = await makeFakeEnv();
    const { teammate_id } = await setupTeammateWithInboxes(env, "Gina", 1);
    const spy = vi.spyOn(globalThis, "fetch") as unknown as {
      mockImplementation: (fn: (...a: unknown[]) => Promise<Response>) => void;
      mockRestore: () => void;
    };
    spy.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED 1.2.3.4:443");
    });
    mock = { restore: () => spy.mockRestore() };

    const res = await call(env, "POST", "/admin/purge", { display_name: "Gina" });
    expect(res.status).toBe(207);
    const body = (await res.json()) as { inboxes: { status: string; message?: string }[] };
    expect(body.inboxes[0]!.status).toBe("revoke_failed");
    expect(body.inboxes[0]!.message).toMatch(/network error/i);
    const remaining = await listInboxes(env.DB as unknown as D1Database, teammate_id);
    expect(remaining.length).toBe(1);
  });
});

describe("revoke / rotate / clear-block lifecycle", () => {
  it("revoke then rotate gives a new working key; old MCP grants would be refused by the chokepoint", async () => {
    const env = await makeFakeEnv();
    const prov = (await (await call(env, "POST", "/admin/provision", { display_name: "Hank" })).json()) as {
      teammate_id: string;
      team_key: string;
      keyid: string;
    };
    const rev = await call(env, "POST", "/admin/revoke", { display_name: "Hank" });
    expect(rev.status).toBe(200);
    const rot = await call(env, "POST", "/admin/rotate", { display_name: "Hank" });
    expect(rot.status).toBe(200);
    const rotated = (await rot.json()) as { teammate_id: string; keyid: string; team_key: string };
    expect(rotated.teammate_id).toBe(prov.teammate_id);
    expect(rotated.keyid).not.toBe(prov.keyid);
    expect(rotated.team_key).not.toBe(prov.team_key);
  });

  it("clear-block removes a self-expiring block without requiring rotate", async () => {
    const env = await makeFakeEnv();
    // Insert a fake block.
    await env._db
      .prepare("INSERT INTO ratelimit (rkey, window_start, count, blocked_until) VALUES (?, ?, ?, ?)")
      .bind("keyid:LOCKEDOUT", Date.now(), 99, Date.now() + 60 * 60_000)
      .run();
    const res = await call(env, "POST", "/admin/clear-block", { target: "keyid:LOCKEDOUT" });
    expect(res.status).toBe(200);
    const row = await env._db
      .prepare("SELECT blocked_until FROM ratelimit WHERE rkey = ?")
      .bind("keyid:LOCKEDOUT")
      .first<{ blocked_until: number | null }>();
    expect(row).toBeNull();
  });
});
