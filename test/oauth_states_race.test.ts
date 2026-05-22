// Tests the single-use atomicity of consumeState (audit finding 4: race
// conditions on TTL-bounded single-use values).
//
// Two concurrent consumers of the same state token MUST NOT both succeed.
// Exactly one wins; the other gets null. The fix is the atomic
// `DELETE … RETURNING *` (replacing the prior SELECT-then-DELETE pattern).

import { describe, expect, it } from "vitest";
import { freshTestDb } from "./_helpers/sqlite.js";
import { createState, consumeState } from "../src/db/oauth_states.js";
import { createTeammate } from "../src/db/teammates.js";
import type { D1Like } from "./_helpers/sqlite.js";

async function seedTeammate(db: D1Like): Promise<string> {
  const t = await createTeammate(db as unknown as D1Database, { displayName: "X" });
  return t.id;
}

describe("consumeState — single-use atomicity", () => {
  it("two concurrent consumes of the same state: exactly one returns the row, the other returns null", async () => {
    const db = await freshTestDb();
    const teammateId = await seedTeammate(db);
    const state = await createState(db as unknown as D1Database, {
      teammateId,
      purpose: "connect_inbox",
      nickname: "work",
    });

    // Race two consumes. With node:sqlite the statements are serialized,
    // but the SELECT-then-DELETE race would still surface as both reads
    // happening before either delete. The atomic DELETE RETURNING means
    // each statement is one indivisible operation.
    const [a, b] = await Promise.all([
      consumeState(db as unknown as D1Database, state),
      consumeState(db as unknown as D1Database, state),
    ]);

    const got = [a, b].filter((r) => r !== null);
    expect(got.length).toBe(1);
    const won = got[0]!;
    expect(won.teammate_id).toBe(teammateId);
    expect(won.purpose).toBe("connect_inbox");

    // The row is gone from the table — no possible replay.
    const remaining = await (db as unknown as D1Database)
      .prepare("SELECT COUNT(*) AS c FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ c: number }>();
    expect(remaining!.c).toBe(0);
  });

  it("expired states are returned as null even before any concurrent call", async () => {
    const db = await freshTestDb();
    const teammateId = await seedTeammate(db);
    const state = await createState(db as unknown as D1Database, {
      teammateId,
      purpose: "connect_inbox",
      nickname: "x",
    });
    // Force-expire the row.
    await (db as unknown as D1Database)
      .prepare("UPDATE oauth_states SET expires_at = ? WHERE state = ?")
      .bind(Date.now() - 1000, state)
      .run();

    const r = await consumeState(db as unknown as D1Database, state);
    expect(r).toBeNull();
    // But the row is still DELETEd from the table — draining stale rows.
    const remaining = await (db as unknown as D1Database)
      .prepare("SELECT COUNT(*) AS c FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ c: number }>();
    expect(remaining!.c).toBe(0);
  });

  it("an unknown state returns null without throwing", async () => {
    const db = await freshTestDb();
    const r = await consumeState(db as unknown as D1Database, "totally-bogus-state-value");
    expect(r).toBeNull();
  });
});
