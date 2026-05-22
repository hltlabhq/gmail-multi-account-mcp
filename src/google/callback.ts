// /google/callback — final leg of the connect-inbox and reconnect-inbox flows.
//
// 1. Validate the `state` against oauth_states (single-use, TTL).
// 2. The state row carries (teammate_id, purpose, nickname). The teammate
//    identity comes from this row, not from any session cookie.
// 3. Exchange the code with Google; fetch the connected account's email and
//    google_sub from userinfo.
// 4. Connect: insert a new inbox row (encrypted refresh token, scopes,
//    google_sub). Reject if the chosen email or google_sub is already in use
//    under this teammate.
// 5. Reconnect: load the existing inbox by (teammate_id, nickname). REFUSE
//    if the new google_sub mismatches the stored one — the teammate logged
//    into the wrong Google account. Otherwise replace the encrypted refresh
//    token and clear needs_reconnect_at.
// 6. Show a small confirmation HTML page with the same hardened headers as
//    the team-key page. Errors render an explanation, also as a uniform
//    HTML page (no internal details leaked to the wire).

import type { Env } from "../index.js";
import { consumeState } from "../db/oauth_states.js";
import {
  createInbox,
  findInboxByEmail,
  findInboxByNickname,
  replaceRefreshToken,
} from "../db/inboxes.js";
import { exchangeCode } from "./oauth.js";
import { log } from "../util/log.js";
import { RateLimiter } from "../auth/ratelimit.js";
import { rateLimited } from "../util/errors.js";

// Per-IP rate limit applied to /google/callback. A valid `state` row IS
// the credential here (high-entropy, single-use, 10-minute TTL); legitimate
// callbacks pass through cleanly. Any callback with missing / expired /
// already-consumed state counts as a failure — that's what an attacker
// hammering the endpoint with random `state=`/`code=` values would
// generate. The IP bucket is shared with /oauth/authorize/verify and
// /admin/*; an attacker who triggers failures in any of them also gets
// rate-limited at /google/callback (and vice versa), which is the right
// posture for a public-facing surface.
export async function handleGoogleCallback(req: Request, env: Env): Promise<Response> {
  const ip =
    req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  const rl = new RateLimiter({ db: env.DB });
  const ipPeek = await rl.peek(`ip:${ip}`);
  if (!ipPeek.allowed) return rateLimited();

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    await rl.noteFailure(`ip:${ip}`);
    log.warn("google.cb_error_param", { error: errorParam });
    // Bumping the bucket on the ?error= short-circuit closes the small
    // gap an attacker could otherwise drive (hammering /google/callback
    // with ?error=access_denied to keep log noise high without ever
    // touching state). Trade-off the operator accepted on audit review:
    // a teammate who clicks Cancel on Google's consent screen many
    // times in a minute from one IP can rate-limit themselves. Recovery
    // is the existing `admin clear-block` command, OR waiting one
    // minute for the soft block to self-expire.
    return renderResult({
      title: "Sign-in didn't finish",
      body:
        "Google reported a problem with the sign-in (you may have clicked " +
        "Cancel). Ask your assistant to start the flow again.",
      isError: true,
    });
  }
  if (!code || !state) {
    await rl.noteFailure(`ip:${ip}`);
    return renderResult({
      title: "Sign-in didn't finish",
      body: "The sign-in link was incomplete. Ask your assistant to start the flow again.",
      isError: true,
    });
  }

  const stateRow = await consumeState(env.DB, state);
  if (!stateRow) {
    await rl.noteFailure(`ip:${ip}`);
    return renderResult({
      title: "Sign-in link expired",
      body:
        "This sign-in link has already been used or is more than 10 minutes old. " +
        "Ask your assistant to start the flow again.",
      isError: true,
    });
  }

  // Valid state — clear the IP bucket so the teammate's subsequent flows
  // from the same IP aren't penalized by their own earlier mis-types.
  await rl.noteSuccess(`ip:${ip}`);

  const redirectUri = new URL("/google/callback", env.PUBLIC_BASE_URL).toString();

  let exchanged;
  try {
    exchanged = await exchangeCode(env, { code, redirectUri });
  } catch (e) {
    log.warn("google.exchange_failed", {
      teammate_id: stateRow.teammate_id,
      purpose: stateRow.purpose,
      msg: (e as Error).message,
    });
    return renderResult({
      title: "Sign-in didn't finish",
      body:
        "Google didn't return the credentials we need. Ask your assistant " +
        "to start the flow again.",
      isError: true,
    });
  }

  if (stateRow.purpose === "connect_inbox") {
    return await onConnect(env, stateRow.teammate_id, stateRow.nickname ?? "", exchanged);
  }
  // reconnect_inbox
  return await onReconnect(env, stateRow.teammate_id, stateRow.nickname ?? "", exchanged);
}

async function onConnect(
  env: Env,
  teammateId: string,
  nickname: string,
  ex: { email: string; google_sub: string; refresh_token: string; scopes: string },
): Promise<Response> {
  if (!nickname) {
    return renderResult({
      title: "Sign-in didn't finish",
      body: "Something went wrong (missing nickname). Ask your assistant to start the flow again.",
      isError: true,
    });
  }
  // Nickname uniqueness was checked at connect_inbox tool time, but races
  // happen. Re-check.
  if (await findInboxByNickname(env.DB, teammateId, nickname)) {
    return renderResult({
      title: "That nickname is already in use",
      body: `You already have an inbox called '${escapeForHtml(nickname)}'. Ask your assistant to pick a different nickname.`,
      isError: true,
    });
  }
  // Same Google account already connected under another nickname?
  if (await findInboxByEmail(env.DB, teammateId, ex.email)) {
    return renderResult({
      title: "That Google account is already connected",
      body: `'${escapeForHtml(ex.email)}' is already one of your inboxes. Ask your assistant to list_inboxes to find its nickname.`,
      isError: true,
    });
  }

  try {
    await createInbox(env.DB, env.AES_MASTER_KEY, {
      teammateId,
      nickname,
      email: ex.email,
      googleSub: ex.google_sub,
      refreshToken: ex.refresh_token,
      scopes: ex.scopes,
    });
  } catch (e) {
    log.error("inbox.create_failed", {
      teammate_id: teammateId,
      msg: (e as Error).message,
    });
    return renderResult({
      title: "Couldn't save the connection",
      body: "Something went wrong on our side. Ask your assistant to start the flow again, or tell your operator.",
      isError: true,
    });
  }

  log.info("inbox.connected", {
    teammate_id: teammateId,
    nickname,
    email_domain: ex.email.split("@")[1] ?? "unknown",
  });

  return renderResult({
    title: `Inbox '${escapeForHtml(nickname)}' connected`,
    body: `Connected ${escapeForHtml(ex.email)}. You can close this tab and go back to your assistant.`,
  });
}

async function onReconnect(
  env: Env,
  teammateId: string,
  nickname: string,
  ex: { email: string; google_sub: string; refresh_token: string; scopes: string },
): Promise<Response> {
  if (!nickname) {
    return renderResult({
      title: "Reconnect didn't finish",
      body: "Something went wrong (missing nickname). Ask your assistant to start the flow again.",
      isError: true,
    });
  }
  const inbox = await findInboxByNickname(env.DB, teammateId, nickname);
  if (!inbox) {
    return renderResult({
      title: "That inbox isn't here any more",
      body: `'${escapeForHtml(nickname)}' isn't connected. Ask your assistant to connect_inbox if you want to add it.`,
      isError: true,
    });
  }
  // The critical check: the returning Google account must be the same one
  // the inbox was originally connected against. We compare google_sub
  // (stable subject claim) — emails can be reassigned by Workspace admins.
  if (ex.google_sub !== inbox.google_sub) {
    log.warn("inbox.reconnect_account_mismatch", {
      teammate_id: teammateId,
      inbox_id: inbox.id,
      expected_sub: inbox.google_sub.slice(0, 6),
      got_sub: ex.google_sub.slice(0, 6),
    });
    return renderResult({
      title: "Wrong Google account",
      body:
        `You signed in as ${escapeForHtml(ex.email)} but '${escapeForHtml(nickname)}' was connected to ${escapeForHtml(inbox.email)}. ` +
        "Start over and pick the right account, or use connect_inbox to add this one under a new nickname.",
      isError: true,
    });
  }

  try {
    await replaceRefreshToken(env.DB, env.AES_MASTER_KEY, {
      teammateId,
      inboxId: inbox.id,
      refreshToken: ex.refresh_token,
      scopes: ex.scopes,
    });
  } catch (e) {
    log.error("inbox.reconnect_save_failed", {
      teammate_id: teammateId,
      inbox_id: inbox.id,
      msg: (e as Error).message,
    });
    return renderResult({
      title: "Couldn't save the new credential",
      body: "Something went wrong on our side. Tell your operator.",
      isError: true,
    });
  }

  log.info("inbox.reconnected", {
    teammate_id: teammateId,
    inbox_id: inbox.id,
    nickname: inbox.nickname,
  });

  return renderResult({
    title: `Inbox '${escapeForHtml(nickname)}' is back`,
    body: `Reconnected ${escapeForHtml(ex.email)}. You can close this tab and go back to your assistant.`,
  });
}

function escapeForHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderResult(opts: { title: string; body: string; isError?: boolean }): Response {
  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #333; }
    .err h1 { color: #b00020; }
  `;
  const wrapClass = opts.isError ? "err" : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeForHtml(opts.title)}</title>
<style>${css}</style>
</head>
<body class="${wrapClass}">
<h1>${escapeForHtml(opts.title)}</h1>
<p>${escapeForHtml(opts.body)}</p>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": [
        "default-src 'self'",
        "script-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "connect-src 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      // HSTS — see comment on the authorize page; same rationale.
      "strict-transport-security": "max-age=15552000; includeSubDomains",
    },
  });
}
