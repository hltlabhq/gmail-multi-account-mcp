// Session chokepoint — the single place where a request bearer is mapped
// to a concrete, currently-valid teammate row. Every MCP tool call routes
// through resolveTeammate(); nothing else may produce a teammate identity
// from inside a request.
//
// Inputs:
//   * `props` — the decrypted props that @cloudflare/workers-oauth-provider
//     attaches to ctx.props after validating the bearer. We expect the shape
//     { teammateId: "tm_..." }, set at completeAuthorization time.
//   * `env`  — for D1 access. Every check verifies the teammate row is
//     still present and non-revoked, regardless of whatever the bearer
//     payload claims.
//
// On any failure path we throw SessionError. Callers convert it to whatever
// MCP/HTTP response is appropriate; the wire-level response is uniform.
//
// Defense in depth:
//   - workers-oauth-provider already validated the bearer cryptographically
//     and decrypted props with a key wrapped INTO the token. A modified token
//     would fail to decrypt.
//   - We re-check the teammate row in D1: if the operator revoked the
//     teammate (or the row was deleted by /admin/purge), every subsequent
//     request fails here, even if a valid-looking token is still in KV.

import type { Env } from "../index.js";
import { findTeammateById, type TeammateRow } from "../db/teammates.js";

export class SessionError extends Error {
  constructor(public reason: "no_props" | "bad_props" | "not_found" | "revoked") {
    super(`session: ${reason}`);
    this.name = "SessionError";
  }
}

// Shape of props we wrote at completeAuthorization time. Keep narrow.
// Indexed so it satisfies the agents/McpAgent Props constraint
// (Record<string, unknown>).
export interface McpGrantPropsShape {
  teammateId: string;
  [k: string]: unknown;
}

export function parseProps(props: unknown): McpGrantPropsShape {
  if (!props || typeof props !== "object") throw new SessionError("no_props");
  const p = props as { teammateId?: unknown };
  if (typeof p.teammateId !== "string" || !p.teammateId.startsWith("tm_") || p.teammateId.length < 5) {
    throw new SessionError("bad_props");
  }
  return { teammateId: p.teammateId };
}

export async function resolveTeammate(env: Env, props: unknown): Promise<TeammateRow> {
  const parsed = parseProps(props);
  const row = await findTeammateById(env.DB, parsed.teammateId);
  if (!row) throw new SessionError("not_found");
  if (row.revoked_at !== null) throw new SessionError("revoked");
  return row;
}
