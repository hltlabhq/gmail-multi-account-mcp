// D1 helpers for team_keys. Pairs with src/auth/team_keys.ts (which is the
// pure-logic mint/parse/verify layer).

import { mintTeamKey } from "../auth/team_keys.js";

export interface TeamKeyRow {
  keyid: string;
  teammate_id: string;
  secret_hash: Uint8Array | ArrayBufferLike;
  created_at: number;
  revoked_at: number | null;
}

export async function lookupKey(
  db: D1Database,
  keyid: string,
): Promise<{
  secretHash: Uint8Array;
  teammateId: string;
  keyRevokedAt: number | null;
  teammateRevokedAt: number | null;
} | null> {
  const row = await db
    .prepare(
      `SELECT k.keyid, k.teammate_id, k.secret_hash, k.revoked_at AS key_revoked_at,
              t.revoked_at AS teammate_revoked_at
         FROM team_keys k JOIN teammates t ON t.id = k.teammate_id
        WHERE k.keyid = ?`,
    )
    .bind(keyid)
    .first<{
      keyid: string;
      teammate_id: string;
      secret_hash: Uint8Array | ArrayBufferLike;
      key_revoked_at: number | null;
      teammate_revoked_at: number | null;
    }>();
  if (!row) return null;
  const raw = row.secret_hash as Uint8Array | ArrayBufferLike | Buffer;
  const secretHash = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
  return {
    secretHash,
    teammateId: row.teammate_id,
    keyRevokedAt: row.key_revoked_at,
    teammateRevokedAt: row.teammate_revoked_at,
  };
}

// Mint and persist a new active key for the given teammate. Returns the
// plaintext exactly once (caller is responsible for displaying it).
//
// If the teammate already has an active key, it is revoked first — a partial
// unique index in the schema enforces at-most-one active key per teammate.
export async function issueKeyForTeammate(
  db: D1Database,
  pepperBase64: string,
  teammateId: string,
): Promise<{ plaintext: string; keyid: string }> {
  const now = Date.now();
  await db
    .prepare(
      "UPDATE team_keys SET revoked_at = ? WHERE teammate_id = ? AND revoked_at IS NULL",
    )
    .bind(now, teammateId)
    .run();
  const minted = await mintTeamKey(pepperBase64);
  await db
    .prepare(
      "INSERT INTO team_keys (keyid, teammate_id, secret_hash, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(minted.keyid, teammateId, minted.secretHash, now)
    .run();
  return { plaintext: minted.plaintext, keyid: minted.keyid };
}

export async function revokeActiveKeyForTeammate(
  db: D1Database,
  teammateId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE team_keys SET revoked_at = ? WHERE teammate_id = ? AND revoked_at IS NULL",
    )
    .bind(Date.now(), teammateId)
    .run();
}

export async function listKeysForTeammate(
  db: D1Database,
  teammateId: string,
): Promise<TeamKeyRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM team_keys WHERE teammate_id = ? ORDER BY created_at DESC",
    )
    .bind(teammateId)
    .all<TeamKeyRow>();
  return res.results;
}
