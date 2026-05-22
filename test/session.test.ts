// Direct tests of the session chokepoint. The McpAgent runtime is exercised
// indirectly via the isolation test in increment 11; here we cover the pure
// function that every tool call routes through.

import { describe, expect, it } from "vitest";
import { parseProps, resolveTeammate, SessionError } from "../src/auth/session.js";
import { makeFakeEnv } from "./_helpers/env.js";
import { createTeammate } from "../src/db/teammates.js";
import type { Env } from "../src/index.js";

describe("parseProps", () => {
  it("accepts well-formed props", () => {
    expect(parseProps({ teammateId: "tm_abc123" }).teammateId).toBe("tm_abc123");
  });

  it("rejects undefined / non-object / null props", () => {
    expect(() => parseProps(undefined)).toThrow(SessionError);
    expect(() => parseProps(null)).toThrow(SessionError);
    expect(() => parseProps(42)).toThrow(SessionError);
    expect(() => parseProps("tm_abc123")).toThrow(SessionError);
  });

  it("rejects missing or non-string teammateId", () => {
    expect(() => parseProps({})).toThrow(SessionError);
    expect(() => parseProps({ teammateId: 123 })).toThrow(SessionError);
    expect(() => parseProps({ teammateId: null })).toThrow(SessionError);
  });

  it("rejects teammateId without the tm_ prefix", () => {
    expect(() => parseProps({ teammateId: "user_abc123" })).toThrow(SessionError);
    expect(() => parseProps({ teammateId: "" })).toThrow(SessionError);
    expect(() => parseProps({ teammateId: "tm_" })).toThrow(SessionError);
  });
});

describe("resolveTeammate", () => {
  it("returns the live D1 row when teammateId points to an active teammate", async () => {
    const env = await makeFakeEnv();
    const t = await createTeammate(env.DB as unknown as D1Database, { displayName: "Alice" });
    const row = await resolveTeammate(env as unknown as Env, { teammateId: t.id });
    expect(row.id).toBe(t.id);
    expect(row.display_name).toBe("Alice");
  });

  it("refuses on missing teammate row", async () => {
    const env = await makeFakeEnv();
    await expect(
      resolveTeammate(env as unknown as Env, { teammateId: "tm_doesnotexist" }),
    ).rejects.toThrowError(SessionError);
  });

  it("refuses if the teammate has been revoked", async () => {
    const env = await makeFakeEnv();
    const t = await createTeammate(env.DB as unknown as D1Database, { displayName: "Bob" });
    // Mark revoked.
    await env._db
      .prepare("UPDATE teammates SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), t.id)
      .run();
    const err = await resolveTeammate(env as unknown as Env, { teammateId: t.id }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).reason).toBe("revoked");
  });

  it("refuses on malformed props before touching the DB", async () => {
    const env = await makeFakeEnv();
    const err = await resolveTeammate(env as unknown as Env, null).catch((e) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).reason).toBe("no_props");
  });

  it("does NOT trust a teammateId that mismatches D1 (cross-teammate attempt)", async () => {
    // Even if a forged token's props point at a different teammate's id, the
    // resolver returns that *other* teammate's row only if it exists and is
    // active. The cross-teammate scenario (where a real teammate's id is
    // pasted into another's token) is fully covered by the isolation test in
    // increment 11; here we just sanity-check the resolver is purely a
    // function of (props, D1) and doesn't carry any cross-call state.
    const env = await makeFakeEnv();
    const a = await createTeammate(env.DB as unknown as D1Database, { displayName: "A" });
    const b = await createTeammate(env.DB as unknown as D1Database, { displayName: "B" });
    const rowA = await resolveTeammate(env as unknown as Env, { teammateId: a.id });
    const rowB = await resolveTeammate(env as unknown as Env, { teammateId: b.id });
    expect(rowA.id).toBe(a.id);
    expect(rowB.id).toBe(b.id);
    expect(rowA.id).not.toBe(rowB.id);
  });
});
