// Sanity tests for the initial schema. Verifies the migration applies cleanly
// and that core invariants from docs/proposal_v1.md hold at the SQL level:
//
//  * one active team_key per teammate
//  * cascading deletes from teammates to dependent rows
//  * inbox uniqueness on (teammate_id, nickname) and (teammate_id, email)
//
// Tool-level isolation (teammate B cannot read A's inboxes by any path) lives
// in test/isolation.test.ts and is added when the tools land.

import { describe, expect, it } from "vitest";
import { freshTestDb } from "./_helpers/sqlite.js";

const now = () => Date.now();

async function insertTeammate(db: Awaited<ReturnType<typeof freshTestDb>>, id: string, name: string) {
  await db
    .prepare(
      "INSERT INTO teammates (id, display_name, created_at) VALUES (?, ?, ?)",
    )
    .bind(id, name, now())
    .run();
}

async function insertTeamKey(
  db: Awaited<ReturnType<typeof freshTestDb>>,
  keyid: string,
  teammateId: string,
  opts: { revoked?: boolean } = {},
) {
  await db
    .prepare(
      "INSERT INTO team_keys (keyid, teammate_id, secret_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      keyid,
      teammateId,
      new Uint8Array(32), // placeholder hash
      now(),
      opts.revoked ? now() : null,
    )
    .run();
}

describe("schema", () => {
  it("applies migration cleanly", async () => {
    const db = await freshTestDb();
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all<{ name: string }>();
    const names = tables.results.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "teammates",
        "team_keys",
        "inboxes",
        "oauth_states",
        "ratelimit",
      ]),
    );
    // MCP OAuth tokens live in KV (managed by workers-oauth-provider). The
    // following tables MUST NOT appear in D1.
    for (const dead of [
      "mcp_oauth_clients",
      "mcp_auth_codes",
      "mcp_access_tokens",
      "mcp_refresh_tokens",
    ]) {
      expect(names).not.toContain(dead);
    }
  });

  it("enforces at most one active team_key per teammate", async () => {
    const db = await freshTestDb();
    await insertTeammate(db, "tm_a", "Alice");
    await insertTeamKey(db, "K1ACTIVE", "tm_a");
    // Second active key for same teammate must fail.
    await expect(insertTeamKey(db, "K2ACTIVE", "tm_a")).rejects.toThrow();

    // But a revoked old key alongside a new active one is fine.
    const db2 = await freshTestDb();
    await insertTeammate(db2, "tm_b", "Bob");
    await insertTeamKey(db2, "OLDKEY11", "tm_b", { revoked: true });
    await insertTeamKey(db2, "NEWKEY11", "tm_b");
  });

  it("cascades delete from teammates to team_keys and inboxes", async () => {
    const db = await freshTestDb();
    await insertTeammate(db, "tm_a", "Alice");
    await insertTeamKey(db, "KEY_A__1", "tm_a");
    await db
      .prepare(
        `INSERT INTO inboxes (id, teammate_id, nickname, email, google_sub,
           encrypted_refresh_token, refresh_iv, scopes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "ib_1",
        "tm_a",
        "work",
        "alice@example.com",
        "google-sub-1",
        new Uint8Array(16),
        new Uint8Array(12),
        "openid email",
        now(),
      )
      .run();

    await db.prepare("DELETE FROM teammates WHERE id = ?").bind("tm_a").run();
    const keys = await db.prepare("SELECT keyid FROM team_keys").all();
    const inboxes = await db.prepare("SELECT id FROM inboxes").all();
    expect(keys.results).toEqual([]);
    expect(inboxes.results).toEqual([]);
  });

  it("rejects duplicate (teammate_id, nickname) and (teammate_id, email)", async () => {
    const db = await freshTestDb();
    await insertTeammate(db, "tm_a", "Alice");
    const ins = (id: string, nick: string, email: string) =>
      db
        .prepare(
          `INSERT INTO inboxes (id, teammate_id, nickname, email, google_sub,
             encrypted_refresh_token, refresh_iv, scopes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          "tm_a",
          nick,
          email,
          "g",
          new Uint8Array(16),
          new Uint8Array(12),
          "s",
          now(),
        )
        .run();
    await ins("ib_1", "work", "a@example.com");
    await expect(ins("ib_2", "work", "b@example.com")).rejects.toThrow();
    await expect(ins("ib_3", "personal", "a@example.com")).rejects.toThrow();
    // Different teammate can reuse nicknames freely.
    await insertTeammate(db, "tm_b", "Bob");
    await db
      .prepare(
        `INSERT INTO inboxes (id, teammate_id, nickname, email, google_sub,
           encrypted_refresh_token, refresh_iv, scopes, created_at)
         VALUES ('ib_b1', 'tm_b', 'work', 'bob@example.com', 'g', ?, ?, 's', ?)`,
      )
      .bind(new Uint8Array(16), new Uint8Array(12), now())
      .run();
  });
});
