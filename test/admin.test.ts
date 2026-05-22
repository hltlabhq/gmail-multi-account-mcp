import { describe, expect, it } from "vitest";
import { makeFakeEnv } from "./_helpers/env.js";
import { handleAdmin } from "../src/auth/admin.js";
import { verifyTeamKey } from "../src/auth/team_keys.js";
import { lookupKey } from "../src/db/team_keys_repo.js";
import type { Env } from "../src/index.js";

function req(
  env: { _operatorToken: string },
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://example.test${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${env._operatorToken}`,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(env: Awaited<ReturnType<typeof makeFakeEnv>>, r: Request) {
  return handleAdmin(r, env as unknown as Env, new URL(r.url).pathname);
}

describe("/admin/* — auth & uniform errors", () => {
  it("rejects missing Authorization with uniform 401", async () => {
    const env = await makeFakeEnv();
    const r = new Request("https://example.test/admin/list", {
      method: "GET",
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });
    const res = await call(env, r);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects wrong operator token with uniform 401", async () => {
    const env = await makeFakeEnv();
    const r = new Request("https://example.test/admin/list", {
      method: "GET",
      headers: {
        authorization: "Bearer wrong-token-xxxxx",
        "cf-connecting-ip": "203.0.113.2",
      },
    });
    const res = await call(env, r);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rate-limits repeated bad auth from same IP", async () => {
    const env = await makeFakeEnv();
    // 5 failures within a minute -> soft block.
    for (let i = 0; i < 5; i++) {
      const r = new Request("https://example.test/admin/list", {
        method: "GET",
        headers: { authorization: "Bearer bad", "cf-connecting-ip": "203.0.113.3" },
      });
      const res = await call(env, r);
      expect(res.status).toBe(401);
    }
    // 6th attempt — should be rate-limited even if the auth is good.
    const r = new Request("https://example.test/admin/list", {
      method: "GET",
      headers: {
        authorization: `Bearer ${env._operatorToken}`,
        "cf-connecting-ip": "203.0.113.3",
      },
    });
    const res = await call(env, r);
    expect(res.status).toBe(429);
  });
});

describe("/admin/provision", () => {
  it("creates a teammate, issues a verifiable key", async () => {
    const env = await makeFakeEnv();
    const res = await call(env, req(env, "POST", "/admin/provision", { display_name: "Alice" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      teammate_id: string;
      keyid: string;
      team_key: string;
    };
    expect(body.teammate_id.startsWith("tm_")).toBe(true);
    expect(body.keyid.length).toBe(8);
    expect(body.team_key.startsWith("tk_")).toBe(true);

    // The minted key verifies against the DB.
    const verify = await verifyTeamKey(body.team_key, {
      pepperBase64: env.HMAC_PEPPER,
      lookup: (kid) => lookupKey(env.DB as D1Database, kid),
    });
    expect(verify.ok).toBe(true);
    if (verify.ok) expect(verify.teammateId).toBe(body.teammate_id);
  });

  it("rejects empty name", async () => {
    const env = await makeFakeEnv();
    const res = await call(env, req(env, "POST", "/admin/provision", { display_name: "" }));
    expect(res.status).toBe(400);
  });

  it("refuses duplicate active name with 409", async () => {
    const env = await makeFakeEnv();
    await call(env, req(env, "POST", "/admin/provision", { display_name: "Alice" }));
    const dup = await call(env, req(env, "POST", "/admin/provision", { display_name: "Alice" }));
    expect(dup.status).toBe(409);
  });
});

describe("/admin/rotate", () => {
  it("revokes the prior key and issues a new one", async () => {
    const env = await makeFakeEnv();
    const first = (await (await call(
      env,
      req(env, "POST", "/admin/provision", { display_name: "Bob" }),
    )).json()) as { team_key: string; keyid: string };

    const rotRes = await call(env, req(env, "POST", "/admin/rotate", { display_name: "Bob" }));
    expect(rotRes.status).toBe(200);
    const rotated = (await rotRes.json()) as { team_key: string; keyid: string };
    expect(rotated.keyid).not.toBe(first.keyid);

    // Old key no longer verifies.
    const stale = await verifyTeamKey(first.team_key, {
      pepperBase64: env.HMAC_PEPPER,
      lookup: (kid) => lookupKey(env.DB as D1Database, kid),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("revoked");

    // New key verifies.
    const fresh = await verifyTeamKey(rotated.team_key, {
      pepperBase64: env.HMAC_PEPPER,
      lookup: (kid) => lookupKey(env.DB as D1Database, kid),
    });
    expect(fresh.ok).toBe(true);
  });
});

describe("/admin/revoke", () => {
  it("revokes the active key without deleting the teammate", async () => {
    const env = await makeFakeEnv();
    const prov = (await (await call(
      env,
      req(env, "POST", "/admin/provision", { display_name: "Carol" }),
    )).json()) as { team_key: string; teammate_id: string };

    const revRes = await call(env, req(env, "POST", "/admin/revoke", { display_name: "Carol" }));
    expect(revRes.status).toBe(200);

    const v = await verifyTeamKey(prov.team_key, {
      pepperBase64: env.HMAC_PEPPER,
      lookup: (kid) => lookupKey(env.DB as D1Database, kid),
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("revoked");

    // Operator can rotate to give Carol a new key — teammate row still active.
    const rot = await call(env, req(env, "POST", "/admin/rotate", { display_name: "Carol" }));
    expect(rot.status).toBe(200);
  });
});

describe("/admin/list", () => {
  it("returns fingerprints, never plaintext keys", async () => {
    const env = await makeFakeEnv();
    await call(env, req(env, "POST", "/admin/provision", { display_name: "Dan" }));
    const res = await call(env, req(env, "GET", "/admin/list"));
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt).not.toMatch(/tk_/); // no plaintext team-key shape anywhere
    const body = JSON.parse(txt) as { teammates: { keys: { fingerprint: string }[] }[] };
    expect(body.teammates[0]!.keys[0]!.fingerprint.length).toBe(8);
  });
});

describe("/admin/clear-block", () => {
  it("clears a per-keyid block without forcing rotation", async () => {
    const env = await makeFakeEnv();
    // Manually insert a block for some keyid.
    const target = "keyid:LOCKEDIN";
    const future = Date.now() + 3600_000;
    await (env._db as unknown as { prepare: (sql: string) => { bind: (...a: unknown[]) => { run: () => Promise<unknown> } } })
      .prepare("INSERT INTO ratelimit (rkey, window_start, count, blocked_until) VALUES (?, ?, ?, ?)")
      .bind(target, Date.now(), 99, future)
      .run();

    const res = await call(env, req(env, "POST", "/admin/clear-block", { target }));
    expect(res.status).toBe(200);

    const row = await (env._db as unknown as { prepare: (sql: string) => { bind: (...a: unknown[]) => { first: <T>() => Promise<T | null> } } })
      .prepare("SELECT blocked_until FROM ratelimit WHERE rkey = ?")
      .bind(target)
      .first<{ blocked_until: number | null }>();
    expect(row).toBeNull();
  });
});

