// D1 helpers for oauth_states. Short-lived rows that bind an in-flight
// Google OAuth callback to the teammate (and, for reconnect, the target
// inbox) that started the flow. Every consumer scopes by teammate_id; the
// callback handler additionally enforces that the state hasn't expired or
// been consumed.

import { newOauthState } from "../util/ids.js";

export type OauthStatePurpose = "connect_inbox" | "reconnect_inbox";

export interface OauthStateRow {
  state: string;
  teammate_id: string;
  purpose: OauthStatePurpose;
  nickname: string | null;
  created_at: number;
  expires_at: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export async function createState(
  db: D1Database,
  args: {
    teammateId: string;
    purpose: OauthStatePurpose;
    nickname: string;
  },
): Promise<string> {
  const state = newOauthState();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO oauth_states (state, teammate_id, purpose, nickname, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      state,
      args.teammateId,
      args.purpose,
      args.nickname,
      now,
      now + STATE_TTL_MS,
    )
    .run();
  return state;
}

// Look up and consume a state row in one go. Returns null if missing,
// expired, or already consumed. Atomic single-use semantics: under two
// concurrent callbacks with the same state, exactly one wins — the other
// gets null — because the DELETE … RETURNING is a single statement that
// SQLite/D1 serializes against itself.
//
// (Audit finding 4: a SELECT-then-DELETE pattern would be racy. Two
// concurrent Google callbacks with the same state could both succeed,
// which would let a state token act on the wrong teammate's account if a
// state were ever shared across teammates. Atomic delete-with-return
// closes that.)
export async function consumeState(
  db: D1Database,
  state: string,
): Promise<OauthStateRow | null> {
  const row = await db
    .prepare("DELETE FROM oauth_states WHERE state = ? RETURNING *")
    .bind(state)
    .first<OauthStateRow>();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

export async function purgeExpired(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM oauth_states WHERE expires_at < ?")
    .bind(Date.now())
    .run();
}
