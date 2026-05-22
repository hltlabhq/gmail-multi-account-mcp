// Teammate row helpers. Every query takes either a teammate_id or a display
// name; nothing here ever blends rows across teammates.

import { newTeammateId } from "../util/ids.js";

export interface TeammateRow {
  id: string;
  display_name: string;
  contact_note: string | null;
  created_at: number;
  revoked_at: number | null;
}

export async function createTeammate(
  db: D1Database,
  args: { displayName: string; contactNote?: string },
): Promise<TeammateRow> {
  const id = newTeammateId();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO teammates (id, display_name, contact_note, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id, args.displayName, args.contactNote ?? null, now)
    .run();
  return {
    id,
    display_name: args.displayName,
    contact_note: args.contactNote ?? null,
    created_at: now,
    revoked_at: null,
  };
}

export async function findTeammateByName(
  db: D1Database,
  displayName: string,
): Promise<TeammateRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM teammates WHERE display_name = ? AND revoked_at IS NULL")
      .bind(displayName)
      .first<TeammateRow>()) ?? null
  );
}

export async function findTeammateById(
  db: D1Database,
  id: string,
): Promise<TeammateRow | null> {
  return (
    (await db.prepare("SELECT * FROM teammates WHERE id = ?").bind(id).first<TeammateRow>()) ?? null
  );
}

// Mark a teammate as revoked and revoke their active team key. MCP tokens
// (held in KV by workers-oauth-provider) are not touched here — the session
// chokepoint refuses any request whose teammate row has revoked_at set,
// regardless of KV state. Gmail token revocation lives in /admin/purge.
export async function revokeTeammate(db: D1Database, id: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      "UPDATE teammates SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    )
    .bind(now, id)
    .run();
  await db
    .prepare(
      "UPDATE team_keys SET revoked_at = ? WHERE teammate_id = ? AND revoked_at IS NULL",
    )
    .bind(now, id)
    .run();
}

export async function listTeammates(db: D1Database): Promise<TeammateRow[]> {
  const res = await db
    .prepare("SELECT * FROM teammates ORDER BY created_at ASC")
    .all<TeammateRow>();
  return res.results;
}
