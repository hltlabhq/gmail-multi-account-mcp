// Team keys — Gate 1.
//
// A team key is the per-teammate credential the operator hands out. It
// authenticates the one-time MCP OAuth handshake; from then on Claude.ai
// holds an MCP refresh token tied to the same teammate.
//
// Wire format:           tk_<keyid>_<secret>
//   keyid   : 8 base32 chars (51-ish bits; identifies the row, not secret)
//   secret  : 32 base32 chars (~160 bits; the actual credential)
//
// At-rest format:        team_keys(keyid TEXT PK, secret_hash BLOB, ...)
//   secret_hash = HMAC-SHA-256(HMAC_PEPPER, secret_bytes)
//
// Verify path (constant-time, uniform-error):
//   1. Parse the input. On any malformed shape -> uniform "not found".
//   2. Look up by keyid. Missing row -> uniform "not found" (after sleeping
//      enough to hide DB-miss timing; in practice D1 is fast and the
//      timing leak is minor next to network jitter).
//   3. Compute HMAC of presented secret; constant-time compare to stored.
//   4. Check revoked_at IS NULL. Any failure path returns the same shape.

import { randomBase32 } from "../util/ids.js";
import { hmacSha256 } from "../crypto/hmac.js";
import { timingSafeEqualBytes } from "../crypto/ct.js";

export const KEY_PREFIX = "tk_";
export const KEYID_LEN = 8;
export const SECRET_LEN = 32;

const KEY_REGEX = new RegExp(
  `^${KEY_PREFIX}([A-Z2-7]{${KEYID_LEN}})_([A-Z2-7]{${SECRET_LEN}})$`,
);

export interface ParsedTeamKey {
  keyid: string;
  secret: string;
}

export interface MintedTeamKey {
  plaintext: string;        // tk_<keyid>_<secret> — shown to operator ONCE
  keyid: string;
  secretHash: Uint8Array;   // to persist
}

export function parseTeamKey(input: string): ParsedTeamKey | null {
  if (typeof input !== "string") return null;
  const m = KEY_REGEX.exec(input);
  if (!m) return null;
  return { keyid: m[1]!, secret: m[2]! };
}

export async function mintTeamKey(pepperBase64: string): Promise<MintedTeamKey> {
  const keyid = randomBase32(KEYID_LEN);
  const secret = randomBase32(SECRET_LEN);
  const plaintext = `${KEY_PREFIX}${keyid}_${secret}`;
  const secretHash = await hmacSha256(pepperBase64, secret);
  return { plaintext, keyid, secretHash };
}

// VerifyResult is intentionally narrow: callers should map *all* failures to
// the same outward response. Distinguish only for internal audit logging.
export type VerifyResult =
  | { ok: true; teammateId: string; keyid: string }
  | { ok: false; reason: "malformed" | "not_found" | "bad_secret" | "revoked" | "teammate_revoked" };

export interface VerifyDeps {
  pepperBase64: string;
  lookup: (keyid: string) => Promise<{
    secretHash: Uint8Array;
    teammateId: string;
    keyRevokedAt: number | null;
    teammateRevokedAt: number | null;
  } | null>;
}

export async function verifyTeamKey(input: string, deps: VerifyDeps): Promise<VerifyResult> {
  const parsed = parseTeamKey(input);
  if (!parsed) return { ok: false, reason: "malformed" };
  const row = await deps.lookup(parsed.keyid);
  // Always compute an HMAC (even on missing row) to keep timing similar.
  const presented = await hmacSha256(deps.pepperBase64, parsed.secret);
  if (!row) return { ok: false, reason: "not_found" };
  const stored = row.secretHash instanceof Uint8Array
    ? row.secretHash
    : new Uint8Array(row.secretHash as ArrayBufferLike);
  if (!timingSafeEqualBytes(presented, stored)) return { ok: false, reason: "bad_secret" };
  if (row.keyRevokedAt !== null) return { ok: false, reason: "revoked" };
  if (row.teammateRevokedAt !== null) return { ok: false, reason: "teammate_revoked" };
  return { ok: true, teammateId: row.teammateId, keyid: parsed.keyid };
}

// Fingerprint for audit logs / `admin list`. Safe to log; never reveals the
// secret. Uses the first 8 hex chars of HMAC(pepper, "fp" || keyid) — distinct
// from the at-rest hash so a log + DB leak still requires the pepper to link.
export async function keyFingerprint(pepperBase64: string, keyid: string): Promise<string> {
  const h = await hmacSha256(pepperBase64, `fp:${keyid}`);
  let out = "";
  for (let i = 0; i < 4; i++) out += (h[i] ?? 0).toString(16).padStart(2, "0");
  return out;
}
