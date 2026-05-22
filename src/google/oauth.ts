// Google OAuth — code exchange, token refresh, and revocation.
//
// Refresh-token expiry policy (External + Testing apps):
//
//   Google revokes refresh tokens after ~7 days of inactivity and on a
//   number of other transitions (user revokes, password change, etc.).
//   The refresh endpoint returns 400 with body { error: "invalid_grant" }.
//   We classify the response so the caller can do the right thing:
//
//     200 + access_token            → ok (caller proceeds with API call)
//     400 invalid_grant             → InboxNeedsReconnectError; caller flips
//                                     inboxes.needs_reconnect_at and the
//                                     teammate sees a "reconnect" prompt.
//     400 other / 401 / 403         → InboxConfigError; operator-visible,
//                                     usually a credentials/scope issue.
//     5xx / network                 → TransientError; caller surfaces a
//                                     transient-style message to the teammate.

import type { Env } from "../index.js";
import { GMAIL_SCOPE_STRING } from "./scopes.js";

export class InboxNeedsReconnectError extends Error {
  constructor(public detail: string) {
    super(`inbox needs reconnect: ${detail}`);
    this.name = "InboxNeedsReconnectError";
  }
}

export class InboxConfigError extends Error {
  constructor(public detail: string) {
    super(`inbox config error: ${detail}`);
    this.name = "InboxConfigError";
  }
}

export class TransientError extends Error {
  constructor(public detail: string) {
    super(`transient: ${detail}`);
    this.name = "TransientError";
  }
}

const AUTHZ_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export interface CodeExchangeResult {
  access_token: string;
  refresh_token: string;
  scopes: string;     // canonical space-separated list of granted scopes
  email: string;
  google_sub: string;
  expires_at_ms: number;
}

export interface AuthorizeUrlOptions {
  state: string;
  redirectUri: string;
  loginHint?: string; // used by reconnect_inbox to preselect the right account
}

export function buildAuthorizeUrl(env: Env, opts: AuthorizeUrlOptions): string {
  const u = new URL(AUTHZ_URL);
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_SCOPE_STRING);
  u.searchParams.set("state", opts.state);
  // Required for refresh-token issuance.
  u.searchParams.set("access_type", "offline");
  // `prompt=consent` forces Google to mint a fresh refresh_token even if the
  // user has previously consented. Without this, reconnect flows often get
  // back only an access_token and we cannot store anything useful.
  u.searchParams.set("prompt", "consent");
  // `include_granted_scopes=true` lets Google add prior consents to this
  // flow's grant; harmless and slightly friendlier UX.
  u.searchParams.set("include_granted_scopes", "true");
  if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint);
  return u.toString();
}

export async function exchangeCode(
  env: Env,
  args: { code: string; redirectUri: string },
): Promise<CodeExchangeResult> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* fall through; classifyTokenError handles non-JSON below */
  }
  if (!res.ok) {
    throw classifyTokenError(res.status, parsed, text);
  }
  const access = expectString(parsed, "access_token");
  const refresh = expectString(parsed, "refresh_token");
  const expiresIn = Number(parsed.expires_in ?? 0);
  const scopes = String(parsed.scope ?? "");
  // We need the connected account's google_sub + email. The ID token would
  // give us both without a second round trip, but parsing JWTs is fiddly and
  // userinfo is a single small request. Acceptable.
  const ui = await fetchUserinfo(access);
  return {
    access_token: access,
    refresh_token: refresh,
    scopes,
    email: ui.email,
    google_sub: ui.sub,
    expires_at_ms: Date.now() + Math.max(0, expiresIn - 60) * 1000,
  };
}

export interface RefreshResult {
  access_token: string;
  expires_at_ms: number;
  // If Google rotated the refresh token, the caller should persist the new one.
  new_refresh_token: string | null;
}

export async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (!res.ok) throw classifyTokenError(res.status, parsed, text);

  const access = expectString(parsed, "access_token");
  const expiresIn = Number(parsed.expires_in ?? 0);
  const rotated = typeof parsed.refresh_token === "string" ? parsed.refresh_token : null;
  return {
    access_token: access,
    expires_at_ms: Date.now() + Math.max(0, expiresIn - 60) * 1000,
    new_refresh_token: rotated,
  };
}

// Revoke a refresh (or access) token at Google. Called by disconnect_inbox
// and by /admin/purge. Best-effort: a 200 means Google deleted the grant;
// any non-200 we log and continue, because the DB-side delete must still
// happen to honor the teammate's intent.
export async function revokeAtGoogle(token: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  return { ok: res.ok, status: res.status };
}

interface Userinfo {
  sub: string;
  email: string;
}

async function fetchUserinfo(accessToken: string): Promise<Userinfo> {
  const res = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new InboxConfigError(`userinfo http ${res.status}`);
  const body = (await res.json()) as { sub?: string; email?: string };
  if (typeof body.sub !== "string" || typeof body.email !== "string") {
    throw new InboxConfigError("userinfo missing sub or email");
  }
  return { sub: body.sub, email: body.email };
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new InboxConfigError(`token response missing ${key}`);
  }
  return v;
}

// Allowlist of OAuth error codes we'll surface in error messages. Anything
// else is logged as the raw status only — Google's `error_description` and
// raw body slices can echo back app-identifying material that ends up in
// logs via callers' `(e as Error).message` patterns.
const SAFE_OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

export function classifyTokenError(
  status: number,
  parsed: Record<string, unknown>,
  // rawText kept in the signature for callers that pre-fetch the body, but
  // it is deliberately NOT inlined into the returned error's message. See
  // the SAFE_OAUTH_ERROR_CODES allowlist above.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _rawText: string,
): Error {
  const code = String(parsed.error ?? "").toLowerCase();
  if (status >= 500 || status === 408 || status === 429) {
    return new TransientError(`http ${status}`);
  }
  if (status === 400 && code === "invalid_grant") {
    // Don't echo Google's error_description (free-form, can include
    // app-identifying detail). The error class itself is enough signal.
    return new InboxNeedsReconnectError("invalid_grant");
  }
  if (status === 400 || status === 401 || status === 403) {
    const safe = SAFE_OAUTH_ERROR_CODES.has(code) ? code : "";
    return new InboxConfigError(safe ? `http ${status} ${safe}` : `http ${status}`);
  }
  return new InboxConfigError(`http ${status}`);
}
