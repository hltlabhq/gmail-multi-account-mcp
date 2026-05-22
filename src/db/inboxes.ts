// D1 helpers for inboxes. Every read/write is scoped by teammate_id; nothing
// in this file looks up an inbox by id alone.

import { newInboxId } from "../util/ids.js";
import { seal, open, type Sealed } from "../crypto/aead.js";

export interface InboxRow {
  id: string;
  teammate_id: string;
  nickname: string;
  email: string;
  google_sub: string;
  encrypted_refresh_token: Uint8Array | ArrayBufferLike;
  refresh_iv: Uint8Array | ArrayBufferLike;
  scopes: string;
  created_at: number;
  needs_reconnect_at: number | null;
}

export interface InboxPublic {
  id: string;
  nickname: string;
  email: string;
  scopes: string[];
  created_at: number;
  needs_reconnect: boolean;
}

export function toPublic(row: InboxRow): InboxPublic {
  return {
    id: row.id,
    nickname: row.nickname,
    email: row.email,
    scopes: row.scopes.length > 0 ? row.scopes.split(/\s+/) : [],
    created_at: row.created_at,
    needs_reconnect: row.needs_reconnect_at !== null,
  };
}

export async function listInboxes(db: D1Database, teammateId: string): Promise<InboxRow[]> {
  const res = await db
    .prepare("SELECT * FROM inboxes WHERE teammate_id = ? ORDER BY created_at ASC")
    .bind(teammateId)
    .all<InboxRow>();
  return res.results;
}

export async function findInboxByNickname(
  db: D1Database,
  teammateId: string,
  nickname: string,
): Promise<InboxRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM inboxes WHERE teammate_id = ? AND nickname = ?")
      .bind(teammateId, nickname)
      .first<InboxRow>()) ?? null
  );
}

export async function findInboxByEmail(
  db: D1Database,
  teammateId: string,
  email: string,
): Promise<InboxRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM inboxes WHERE teammate_id = ? AND email = ?")
      .bind(teammateId, email)
      .first<InboxRow>()) ?? null
  );
}

export async function createInbox(
  db: D1Database,
  aesMasterKeyB64: string,
  args: {
    teammateId: string;
    nickname: string;
    email: string;
    googleSub: string;
    refreshToken: string;
    scopes: string;
  },
): Promise<{ id: string }> {
  const id = newInboxId();
  const sealed = await seal(aesMasterKeyB64, args.refreshToken, id);
  await db
    .prepare(
      `INSERT INTO inboxes
         (id, teammate_id, nickname, email, google_sub,
          encrypted_refresh_token, refresh_iv, scopes, created_at, needs_reconnect_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      id,
      args.teammateId,
      args.nickname,
      args.email,
      args.googleSub,
      sealed.ciphertext,
      sealed.iv,
      args.scopes,
      Date.now(),
    )
    .run();
  return { id };
}

export async function renameInbox(
  db: D1Database,
  teammateId: string,
  oldNickname: string,
  newNickname: string,
): Promise<{ ok: boolean; reason?: "not_found" | "conflict" }> {
  const cur = await findInboxByNickname(db, teammateId, oldNickname);
  if (!cur) return { ok: false, reason: "not_found" };
  const conflict = await findInboxByNickname(db, teammateId, newNickname);
  if (conflict && conflict.id !== cur.id) return { ok: false, reason: "conflict" };
  await db
    .prepare(
      "UPDATE inboxes SET nickname = ? WHERE teammate_id = ? AND id = ?",
    )
    .bind(newNickname, teammateId, cur.id)
    .run();
  return { ok: true };
}

export async function deleteInbox(
  db: D1Database,
  teammateId: string,
  inboxId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM inboxes WHERE teammate_id = ? AND id = ?")
    .bind(teammateId, inboxId)
    .run();
}

export async function markNeedsReconnect(
  db: D1Database,
  teammateId: string,
  inboxId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE inboxes SET needs_reconnect_at = ? WHERE teammate_id = ? AND id = ? AND needs_reconnect_at IS NULL",
    )
    .bind(Date.now(), teammateId, inboxId)
    .run();
}

// Replace just the refresh token + scopes on an existing inbox, clear the
// needs_reconnect flag. Used by reconnect_inbox. The caller has already
// verified google_sub matches.
export async function replaceRefreshToken(
  db: D1Database,
  aesMasterKeyB64: string,
  args: {
    teammateId: string;
    inboxId: string;
    refreshToken: string;
    scopes: string;
  },
): Promise<void> {
  const sealed = await seal(aesMasterKeyB64, args.refreshToken, args.inboxId);
  await db
    .prepare(
      `UPDATE inboxes
          SET encrypted_refresh_token = ?, refresh_iv = ?, scopes = ?, needs_reconnect_at = NULL
        WHERE teammate_id = ? AND id = ?`,
    )
    .bind(sealed.ciphertext, sealed.iv, args.scopes, args.teammateId, args.inboxId)
    .run();
}

// Decrypt the stored refresh token. Caller must have already scoped the
// inbox row by teammate_id.
export async function decryptRefreshToken(
  aesMasterKeyB64: string,
  row: Pick<InboxRow, "id" | "encrypted_refresh_token" | "refresh_iv">,
): Promise<string> {
  const ct = row.encrypted_refresh_token instanceof Uint8Array
    ? row.encrypted_refresh_token
    : new Uint8Array(row.encrypted_refresh_token as ArrayBufferLike);
  const iv = row.refresh_iv instanceof Uint8Array
    ? row.refresh_iv
    : new Uint8Array(row.refresh_iv as ArrayBufferLike);
  const sealed: Sealed = { iv, ciphertext: ct };
  const bytes = await open(aesMasterKeyB64, sealed, row.id);
  return new TextDecoder().decode(bytes);
}
