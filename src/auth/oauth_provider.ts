// MCP OAuth provider wiring.
//
// We use @cloudflare/workers-oauth-provider to implement OAuth 2.1 with PKCE
// + RFC 7591 dynamic client registration. The library owns:
//
//   * /.well-known/oauth-authorization-server  (metadata discovery)
//   * /oauth/token                              (code exchange + refresh)
//   * /oauth/register                           (dynamic client registration)
//   * the API surface (we declare /mcp as an apiRoute; the library
//     gates it on a valid bearer and hands our handler ctx.props)
//
// We own:
//
//   * /oauth/authorize       — renders the "paste your team key" page
//   * /oauth/authorize/verify — verifies the key, calls completeAuthorization,
//                               redirects back to the OAuth client (Claude.ai)
//
// teammate_id binding:
//
//   At completeAuthorization time we set BOTH:
//     userId = teammate.id
//     props  = { teammateId: teammate.id }
//
//   The library stores props encrypted with a key wrapped INTO the issued
//   token string itself, so a token cannot be modified to spoof props
//   without re-deriving the key (which requires the secret half of the
//   token). On every authenticated request, the library decrypts props and
//   exposes them as `ctx.props`. Our session chokepoint (src/auth/session.ts)
//   reads ctx.props.teammateId, double-checks the teammates row is non-revoked
//   in D1, and refuses on any mismatch.

import type { Env } from "../index.js";
import { renderAuthorizePage } from "./authorize_page.js";
import { verifyTeamKey } from "./team_keys.js";
import { lookupKey } from "../db/team_keys_repo.js";
import { findTeammateById } from "../db/teammates.js";
import { RateLimiter } from "./ratelimit.js";
import { rateLimited } from "../util/errors.js";
import { log } from "../util/log.js";
import { bytesToBase64, base64ToBytes } from "../crypto/hmac.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// The props attached to every grant. Keep this minimal; everything else can
// be fetched from D1 using teammateId.
export interface McpGrantProps {
  teammateId: string;
}

// Env extension that the library inserts: env.OAUTH_PROVIDER is populated
// when our defaultHandler is invoked.
export interface EnvWithOAuth extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

// Encode/decode the AuthRequest blob carried across the team-key form post.
// Why round-trip the full AuthRequest instead of just storing it in KV with
// a short id? Two reasons:
//   1. The library re-validates AuthRequest fields (clientId, redirectUri,
//      PKCE challenge) when we call completeAuthorization; we want those to
//      survive verbatim.
//   2. Stateless avoids another KV key with TTL semantics to manage.
export function encodeAuthRequest(ar: AuthRequest): string {
  const json = JSON.stringify(ar);
  return bytesToBase64(new TextEncoder().encode(json))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeAuthRequest(blob: string): AuthRequest | null {
  try {
    const bytes = base64ToBytes(blob);
    const txt = new TextDecoder().decode(bytes);
    const obj = JSON.parse(txt);
    // Light shape check — defense in depth. The library re-validates the
    // request when completeAuthorization is called.
    if (
      typeof obj === "object" &&
      obj &&
      typeof obj.clientId === "string" &&
      typeof obj.redirectUri === "string" &&
      typeof obj.responseType === "string"
    ) {
      return obj as AuthRequest;
    }
    return null;
  } catch {
    return null;
  }
}

// GET /oauth/authorize — render the team-key form.
//
// NOT rate-limited: this is a read-only landing-page render (one KV
// lookupClient + an HTML response). No credential is checked here, so
// there's no auth-brute-force surface; an attacker who hammers it just
// pays the round-trip cost for nothing. The sensitive auth surfaces
// (/oauth/authorize/verify, /admin/*, /google/callback) are rate-limited
// where they need to be.
export async function handleAuthorize(
  req: Request,
  env: EnvWithOAuth,
): Promise<Response> {
  // The library parses ?response_type=&client_id=&redirect_uri=&... from the
  // request URL. parseAuthRequest validates the OAuth shape.
  let ar: AuthRequest;
  try {
    ar = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch (e) {
    log.warn("oauth.parse_auth_request_failed", { msg: (e as Error).message });
    return new Response("invalid authorization request", { status: 400 });
  }
  let clientName: string | undefined;
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(ar.clientId);
    clientName = client?.clientName ?? undefined;
  } catch {
    /* unknown client — render the page anyway; submit will fail uniformly */
  }
  return renderAuthorizePage({
    authRequestBlob: encodeAuthRequest(ar),
    clientName,
  });
}

// POST /oauth/authorize/verify — verify team key + complete the OAuth dance.
export async function handleAuthorizeVerify(
  req: Request,
  env: EnvWithOAuth,
): Promise<Response> {
  const ip =
    req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  const rl = new RateLimiter({ db: env.DB });

  const ipPeek = await rl.peek(`ip:${ip}`);
  if (!ipPeek.allowed) return rateLimited();

  let body: URLSearchParams;
  try {
    const raw = await req.text();
    body = new URLSearchParams(raw);
  } catch {
    await rl.noteFailure(`ip:${ip}`);
    return renderError("invalid form submission", null);
  }

  const presented = body.get("team_key")?.trim() ?? "";
  const blob = body.get("ar") ?? "";
  const ar = decodeAuthRequest(blob);
  if (!ar) {
    await rl.noteFailure(`ip:${ip}`);
    // No AuthRequest -> we can't redirect back to the client even if the key
    // is good. Render a generic error.
    return renderError("invalid authorization request", null);
  }

  const verify = await verifyTeamKey(presented, {
    pepperBase64: env.HMAC_PEPPER,
    lookup: (kid) => lookupKey(env.DB, kid),
  });

  if (!verify.ok) {
    await rl.noteFailure(`ip:${ip}`);
    // If we managed to parse a keyid, also count toward its per-key bucket.
    // verifyTeamKey doesn't return the keyid on failure (uniform errors), so
    // we re-parse to grab it. This is safe — keyid is not secret.
    const probe = /^tk_([A-Z2-7]{8})_/.exec(presented);
    if (probe) await rl.noteFailure(`keyid:${probe[1]}`);
    log.warn("oauth.verify_failed", { reason: verify.reason });
    // Uniform user-facing error — never reveal which of the four reasons.
    return renderError("Sign-in failed. Check your team key, or ask your operator to clear a temporary block.", ar);
  }

  // Defense in depth: the teammate row must be present and non-revoked even
  // if the key check passed (key could be stale w.r.t. teammate.revoked_at).
  const teammate = await findTeammateById(env.DB, verify.teammateId);
  if (!teammate || teammate.revoked_at !== null) {
    await rl.noteFailure(`ip:${ip}`);
    log.warn("oauth.teammate_unavailable", { teammate_id: verify.teammateId });
    return renderError("Sign-in failed. Ask your operator for help.", ar);
  }

  await rl.noteSuccess(`ip:${ip}`);
  await rl.noteSuccess(`keyid:${verify.keyid}`);

  // Issue the grant. userId AND props.teammateId both carry teammate.id —
  // see comment block at top of file for the binding rationale.
  const props: McpGrantProps = { teammateId: teammate.id };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: ar,
    userId: teammate.id,
    metadata: { display_name: teammate.display_name },
    scope: ar.scope.length > 0 ? ar.scope : ["mcp"],
    props,
  });

  log.info("oauth.granted", {
    teammate_id: teammate.id,
    keyid: verify.keyid,
    client_id: ar.clientId,
  });

  return Response.redirect(redirectTo, 302);
}

function renderError(msg: string, ar: AuthRequest | null): Response {
  return renderAuthorizePage({
    authRequestBlob: ar ? encodeAuthRequest(ar) : "",
    errorBanner: msg,
  });
}
