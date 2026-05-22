// /admin/* endpoints.
//
// Auth model:
//   * Operator stores OPERATOR_TOKEN locally (never in the Worker).
//   * Worker stores OPERATOR_TOKEN_HMAC = HMAC(HMAC_PEPPER, OPERATOR_TOKEN).
//   * Each /admin/* request must carry `Authorization: Bearer <token>`.
//     We HMAC the presented token under the pepper and constant-time-compare
//     to OPERATOR_TOKEN_HMAC.
//
// All hardening applied to /oauth/authorize/verify applies here:
//   * uniform error responses
//   * rate-limited per IP and per OPERATOR_TOKEN fingerprint
//   * no token or team-key material logged (the log helper scrubs already,
//     and we never construct a log line that includes the raw token)

import type { Env } from "../index.js";
import { hmacSha256Hex } from "../crypto/hmac.js";
import { timingSafeEqualHex } from "../crypto/ct.js";
import {
  jsonResponse,
  rateLimited,
  uniformAuthFailure,
} from "../util/errors.js";
import { log } from "../util/log.js";
import { RateLimiter } from "./ratelimit.js";
import {
  createTeammate,
  findTeammateByName,
  listTeammates,
} from "../db/teammates.js";
import {
  issueKeyForTeammate,
  listKeysForTeammate,
  revokeActiveKeyForTeammate,
} from "../db/team_keys_repo.js";
import { keyFingerprint } from "./team_keys.js";
import {
  decryptRefreshToken,
  deleteInbox,
  listInboxes,
} from "../db/inboxes.js";
import { revokeAtGoogle } from "../google/oauth.js";

export async function handleAdmin(
  req: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  // Rate-limit on IP regardless of whether auth ultimately succeeds. The
  // OPERATOR_TOKEN fingerprint is only known after we parse the header, so
  // we also note IP failures before we know the bucket id.
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  const rl = new RateLimiter({ db: env.DB });

  const ipPeek = await rl.peek(`ip:${ip}`);
  if (!ipPeek.allowed) {
    return rateLimited();
  }

  // Parse and verify the operator bearer.
  const presented = parseBearer(req);
  if (presented === null) {
    await rl.noteFailure(`ip:${ip}`);
    return uniformAuthFailure();
  }
  const presentedHmacHex = await hmacSha256Hex(env.HMAC_PEPPER, presented);
  const opFp = presentedHmacHex.slice(0, 16); // not the full HMAC; fingerprint only
  const opPeek = await rl.peek(`op:${opFp}`);
  if (!opPeek.allowed) {
    return rateLimited();
  }

  if (!timingSafeEqualHex(presentedHmacHex, env.OPERATOR_TOKEN_HMAC)) {
    await rl.noteFailure(`ip:${ip}`);
    await rl.noteFailure(`op:${opFp}`);
    return uniformAuthFailure();
  }
  await rl.noteSuccess(`ip:${ip}`);
  await rl.noteSuccess(`op:${opFp}`);

  // Authenticated. Route.
  switch (`${req.method} ${pathname}`) {
    case "POST /admin/provision":
      return adminProvision(req, env);
    case "GET /admin/list":
      return adminList(env);
    case "POST /admin/rotate":
      return adminRotate(req, env);
    case "POST /admin/revoke":
      return adminRevoke(req, env);
    case "POST /admin/purge":
      return adminPurge(req, env);
    case "POST /admin/clear-block":
      return adminClearBlock(req, env);
    default:
      return uniformAuthFailure();
  }
}

function parseBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+([^\s]+)$/.exec(h);
  return m ? m[1]! : null;
}

interface ProvisionBody {
  display_name?: string;
  contact_note?: string;
}

async function adminProvision(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as ProvisionBody | null;
  const name = body?.display_name?.trim();
  if (!name) return jsonResponse(400, { error: "bad_request" });

  // Refuse if name is already in use by an active teammate.
  const existing = await findTeammateByName(env.DB, name);
  if (existing) return jsonResponse(409, { error: "conflict", detail: "name in use" });

  const teammate = await createTeammate(env.DB, {
    displayName: name,
    contactNote: body?.contact_note,
  });
  const minted = await issueKeyForTeammate(env.DB, env.HMAC_PEPPER, teammate.id);

  log.info("admin.provision", {
    teammate_id: teammate.id,
    keyid: minted.keyid,
    // Plaintext is never logged. It is returned only in the response body.
  });

  return jsonResponse(200, {
    teammate_id: teammate.id,
    display_name: teammate.display_name,
    keyid: minted.keyid,
    team_key: minted.plaintext, // returned exactly once
  });
}

async function adminList(env: Env): Promise<Response> {
  const teammates = await listTeammates(env.DB);
  const items = await Promise.all(
    teammates.map(async (t) => {
      const keys = await listKeysForTeammate(env.DB, t.id);
      const enriched = await Promise.all(
        keys.map(async (k) => ({
          keyid: k.keyid,
          fingerprint: await keyFingerprint(env.HMAC_PEPPER, k.keyid),
          created_at: k.created_at,
          revoked_at: k.revoked_at,
        })),
      );
      return {
        teammate_id: t.id,
        display_name: t.display_name,
        contact_note: t.contact_note,
        created_at: t.created_at,
        revoked_at: t.revoked_at,
        keys: enriched,
      };
    }),
  );
  return jsonResponse(200, { teammates: items });
}

interface NameBody {
  display_name?: string;
}

async function lookupByName(env: Env, name: string | undefined) {
  if (!name || !name.trim()) return null;
  return findTeammateByName(env.DB, name.trim());
}

async function adminRotate(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as NameBody | null;
  const t = await lookupByName(env, body?.display_name);
  if (!t) return jsonResponse(404, { error: "not_found" });
  const minted = await issueKeyForTeammate(env.DB, env.HMAC_PEPPER, t.id);
  log.info("admin.rotate", { teammate_id: t.id, keyid: minted.keyid });
  return jsonResponse(200, {
    teammate_id: t.id,
    display_name: t.display_name,
    keyid: minted.keyid,
    team_key: minted.plaintext,
  });
}

async function adminRevoke(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as NameBody | null;
  const t = await lookupByName(env, body?.display_name);
  if (!t) return jsonResponse(404, { error: "not_found" });
  // Revoke active team key. MCP tokens (held in KV by workers-oauth-provider)
  // remain on disk but are dead on next use: the session chokepoint refuses
  // any request whose teammate row has no active key OR whose teammate.revoked_at
  // is set. Gmail refresh tokens are kept (reversible by rotate); they only
  // come back to life if the operator issues a new key to the same teammate.
  // Full removal + Google revocation happens via /admin/purge.
  await revokeActiveKeyForTeammate(env.DB, t.id);
  log.info("admin.revoke", { teammate_id: t.id });
  return jsonResponse(200, { teammate_id: t.id, display_name: t.display_name, ok: true });
}

// adminPurge — fully removes a teammate. Per the operator's fail-loud
// requirement, a per-inbox Google revoke failure must NOT result in a
// silent row delete + clean success. We:
//
//   1. Revoke the teammate's active team key (no Google dependency).
//   2. Mark the teammate row revoked if not already.
//   3. For each connected inbox, decrypt the refresh token and call
//      Google's /revoke. On success, delete the inbox row. On failure,
//      LEAVE the row and surface the failure in the per-inbox response.
//   4. If every inbox revoked cleanly, delete the teammate row
//      (CASCADE removes team_keys + oauth_states).
//   5. Response: per-inbox itemized + overall `ok` = true only when
//      every revoke succeeded.
//
// Failure modes that count as "revoke failed":
//   * Google returns non-200.
//   * Decrypt of the stored refresh token throws.
//   * Network/transient errors from fetch.
//
// Re-running purge after a failure is idempotent: the failing inbox
// stays until the operator manually revokes at Google or the next attempt
// succeeds.
async function adminPurge(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as NameBody | null;
  // findTeammateByName only returns non-revoked rows; for purge we may be
  // called against a teammate already revoked, so look up by name across
  // both states.
  const name = body?.display_name?.trim();
  if (!name) return jsonResponse(400, { error: "bad_request" });
  const t = await env.DB
    .prepare("SELECT * FROM teammates WHERE display_name = ?")
    .bind(name)
    .first<{
      id: string;
      display_name: string;
      contact_note: string | null;
      created_at: number;
      revoked_at: number | null;
    }>();
  if (!t) return jsonResponse(404, { error: "not_found" });

  // Always-do steps that have no Google dependency.
  await revokeActiveKeyForTeammate(env.DB, t.id);
  if (t.revoked_at === null) {
    await env.DB
      .prepare("UPDATE teammates SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), t.id)
      .run();
  }

  // Per-inbox attempt.
  const inboxes = await listInboxes(env.DB, t.id);
  const results: {
    nickname: string;
    inbox_id: string;
    status: "purged" | "revoke_failed";
    detail?: string;
    message?: string;
  }[] = [];
  let anyFailed = false;

  for (const inbox of inboxes) {
    let refresh: string;
    try {
      refresh = await decryptRefreshToken(env.AES_MASTER_KEY, inbox);
    } catch (e) {
      anyFailed = true;
      log.warn("admin.purge.decrypt_failed", {
        teammate_id: t.id,
        inbox_id: inbox.id,
      });
      results.push({
        nickname: inbox.nickname,
        inbox_id: inbox.id,
        status: "revoke_failed",
        detail: `decrypt_error: ${(e as Error).message}`,
        message:
          `Inbox '${inbox.nickname}' (${inbox.email}): could not decrypt stored refresh token — token may still be live at Google, verify manually.`,
      });
      continue;
    }
    let revokeResult: { ok: boolean; status: number };
    try {
      revokeResult = await revokeAtGoogle(refresh);
    } catch (e) {
      anyFailed = true;
      log.warn("admin.purge.revoke_threw", {
        teammate_id: t.id,
        inbox_id: inbox.id,
        msg: (e as Error).message,
      });
      results.push({
        nickname: inbox.nickname,
        inbox_id: inbox.id,
        status: "revoke_failed",
        detail: `network_error: ${(e as Error).message}`,
        message:
          `Inbox '${inbox.nickname}' (${inbox.email}): network error reaching Google's revoke endpoint — token may still be live at Google, verify manually.`,
      });
      continue;
    }
    if (!revokeResult.ok) {
      anyFailed = true;
      log.warn("admin.purge.revoke_failed", {
        teammate_id: t.id,
        inbox_id: inbox.id,
        status: revokeResult.status,
      });
      results.push({
        nickname: inbox.nickname,
        inbox_id: inbox.id,
        status: "revoke_failed",
        detail: `google_http_${revokeResult.status}`,
        message:
          `Inbox '${inbox.nickname}' (${inbox.email}): Google returned HTTP ${revokeResult.status} on revoke — token may still be live at Google, verify manually.`,
      });
      continue;
    }
    // Revoke succeeded — safe to delete the row.
    await deleteInbox(env.DB, t.id, inbox.id);
    results.push({
      nickname: inbox.nickname,
      inbox_id: inbox.id,
      status: "purged",
    });
  }

  // Only delete the teammate row if every inbox cleared cleanly. CASCADE
  // takes the team_keys and oauth_states rows with it. If any revoke
  // failed, leave the teammate row revoked-but-present so the operator
  // can re-run purge after manual cleanup.
  let teammateRowDeleted = false;
  if (!anyFailed) {
    await env.DB.prepare("DELETE FROM teammates WHERE id = ?").bind(t.id).run();
    teammateRowDeleted = true;
  }

  log.info("admin.purge", {
    teammate_id: t.id,
    inbox_count: inboxes.length,
    any_failed: anyFailed,
    teammate_row_deleted: teammateRowDeleted,
  });

  return jsonResponse(anyFailed ? 207 : 200, {
    ok: !anyFailed,
    partial: anyFailed,
    teammate_id: t.id,
    display_name: t.display_name,
    teammate_row_deleted: teammateRowDeleted,
    inboxes: results,
    ...(anyFailed
      ? {
          message:
            "One or more inboxes could not be revoked at Google. The teammate's team key is revoked and the bad rows remain — see `inboxes[]` for details. Manually revoke the listed accounts at https://myaccount.google.com/permissions, then re-run `admin purge` to clean up.",
        }
      : {}),
  });
}

interface ClearBlockBody {
  target?: string; // "ip:<ip>", "keyid:<keyid>", or a raw bucket key
}

async function adminClearBlock(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as ClearBlockBody | null;
  const target = body?.target?.trim();
  if (!target) return jsonResponse(400, { error: "bad_request" });
  const rl = new RateLimiter({ db: env.DB });
  await rl.clear(target);
  log.info("admin.clear_block", { target });
  return jsonResponse(200, { ok: true, target });
}

