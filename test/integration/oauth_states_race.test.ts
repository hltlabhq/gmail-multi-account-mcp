// consumeState atomicity validated against real miniflare-backed D1
// (workerd-bundled SQLite — the same engine the production Worker talks
// to). Runs in the workers pool so the SQL fix is exercised in the
// runtime where it actually has to hold, not just node:sqlite.
//
// The companion test in test/oauth_states_race.test.ts runs in the node
// pool against node:sqlite. Both pools agree the SQL is correct; this
// one additionally confirms D1 itself accepts and serializes the
// statement (the v1.0 contract — DELETE … RETURNING is atomic at the
// statement level per SQLite, and D1 honors that).

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createState, consumeState } from "../../src/db/oauth_states.js";
import { createTeammate } from "../../src/db/teammates.js";

describe("consumeState atomicity — real D1 (audit finding 4)", () => {
  it("two consumes of the same state, fired simultaneously via Promise.all: exactly one wins", async () => {
    const t = await createTeammate(env.DB, {
      displayName: "race-" + crypto.randomUUID().slice(0, 8),
    });
    const state = await createState(env.DB, {
      teammateId: t.id,
      purpose: "connect_inbox",
      nickname: "work",
    });

    // Both consumes dispatch their DELETE…RETURNING to D1 from a single
    // event-loop tick. D1 / SQLite serializes the two statements; one
    // matches the row and returns it, the other matches nothing and
    // returns null. (If the implementation were still SELECT-then-DELETE,
    // both reads could land before either delete — both would succeed.)
    const [a, b] = await Promise.all([
      consumeState(env.DB, state),
      consumeState(env.DB, state),
    ]);

    const got = [a, b].filter((r) => r !== null);
    expect(got.length).toBe(1);
    expect(got[0]!.teammate_id).toBe(t.id);
    expect(got[0]!.purpose).toBe("connect_inbox");

    // Row is gone from the table in real D1.
    const remaining = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ c: number }>();
    expect(remaining!.c).toBe(0);
  });

  it("sequential consumes against real D1: first wins, second returns null", async () => {
    const t = await createTeammate(env.DB, {
      displayName: "seq-" + crypto.randomUUID().slice(0, 8),
    });
    const state = await createState(env.DB, {
      teammateId: t.id,
      purpose: "reconnect_inbox",
      nickname: "work",
    });
    const first = await consumeState(env.DB, state);
    const second = await consumeState(env.DB, state);
    expect(first?.teammate_id).toBe(t.id);
    expect(second).toBeNull();
  });
});
