// Gmail HTTP client.
//
// All Gmail API calls flow through gmailFetch(), which:
//   1. Decrypts the inbox's stored refresh token.
//   2. Calls Google's /token endpoint to mint a short-lived access token.
//   3. Issues the actual Gmail API request with that access token.
//   4. If Google rotated the refresh token (rare; happens on policy or
//      revocation events), re-encrypts and persists the new one.
//   5. On invalid_grant, flips inboxes.needs_reconnect_at and throws
//      InboxNeedsReconnectError. The MCP tool layer catches that and
//      returns the structured "reconnect this inbox" payload.
//   6. On Gmail-side 4xx/5xx, throws a typed error.
//
// We deliberately do NOT cache access tokens across requests in this v1.
// Free-tier Workers are stateless per request anyway, and the cost of one
// refresh is small (one round trip, ~200ms). When needed we can add a
// short-lived in-memory cache or a KV-backed one without touching callers.

import type { Env } from "../index.js";
import {
  decryptRefreshToken,
  markNeedsReconnect,
  replaceRefreshToken,
  type InboxRow,
} from "../db/inboxes.js";
import {
  InboxNeedsReconnectError,
  InboxConfigError,
  TransientError,
  refreshAccessToken,
} from "../google/oauth.js";

// GmailApiError carries the HTTP status code only. Per the audit's logging
// brief, raw Gmail response bodies must never end up in .message — Gmail
// error responses can include message metadata, headers, and addresses for
// the failing call, and .message ends up in error logs via callers'
// `(e as Error).message` patterns. If the operator needs the raw response
// for debugging, route it through a dedicated, scrubbed path — not through
// the exception message.
export class GmailApiError extends Error {
  constructor(public status: number) {
    super(`gmail api http ${status}`);
    this.name = "GmailApiError";
  }
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

export async function gmailFetch<T = unknown>(
  env: Env,
  inbox: InboxRow,
  path: string,
  init: RequestInit & { searchParams?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  if (inbox.needs_reconnect_at !== null) {
    throw new InboxNeedsReconnectError("inbox is in needs_reconnect state");
  }

  const refresh = await decryptRefreshToken(env.AES_MASTER_KEY, inbox);
  let access: string;
  try {
    const r = await refreshAccessToken(env, refresh);
    access = r.access_token;
    if (r.new_refresh_token && r.new_refresh_token !== refresh) {
      // Google rotated the refresh token. Persist before issuing the
      // Gmail call so we don't risk losing it on a crash later.
      await replaceRefreshToken(env.DB, env.AES_MASTER_KEY, {
        teammateId: inbox.teammate_id,
        inboxId: inbox.id,
        refreshToken: r.new_refresh_token,
        scopes: inbox.scopes,
      });
    }
  } catch (e) {
    if (e instanceof InboxNeedsReconnectError) {
      await markNeedsReconnect(env.DB, inbox.teammate_id, inbox.id);
      throw e;
    }
    throw e;
  }

  // Build URL with query params.
  const url = new URL(GMAIL_BASE + path);
  if (init.searchParams) {
    for (const [k, v] of Object.entries(init.searchParams)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${access}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Fall through — caller may want raw text.
      parsed = text;
    }
  }
  if (!res.ok) {
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      throw new TransientError(`gmail http ${res.status}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new InboxConfigError(`gmail http ${res.status}`);
    }
    // Status only — do NOT include `text` here. Gmail error response
    // bodies can contain email addresses, headers, and message metadata.
    throw new GmailApiError(res.status);
  }
  return parsed as T;
}
