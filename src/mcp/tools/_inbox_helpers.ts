// Shared helpers for the inbox-scoped tools (search, threads, drafts, labels,
// send). The pattern is:
//
//   const inbox = await resolveInbox(env, teammate.id, nickname);
//   if ('error' in inbox) return inbox;        // not_found / needs_reconnect
//   // ...call Gmail via gmail/* helpers...
//
// resolveInbox is a tool-level helper, not security. The chokepoint already
// scoped to teammate.id; this function just turns 'nickname' into an InboxRow
// or a uniform structured error the assistant can render directly.

import type { Env } from "../../index.js";
import { findInboxByNickname, type InboxRow } from "../../db/inboxes.js";

export type InboxResolution =
  | { error: "not_found"; inbox: string; message: string }
  | { error: "needs_reconnect"; inbox: string; message: string }
  | { row: InboxRow };

export async function resolveInbox(
  env: Env,
  teammateId: string,
  nickname: string,
): Promise<InboxResolution> {
  const row = await findInboxByNickname(env.DB, teammateId, nickname);
  if (!row) {
    return {
      error: "not_found",
      inbox: nickname,
      message: `No inbox called '${nickname}'. Ask me to list_inboxes to see what's connected.`,
    };
  }
  if (row.needs_reconnect_at !== null) {
    return {
      error: "needs_reconnect",
      inbox: nickname,
      message:
        `Your '${nickname}' inbox needs to be reconnected. Ask me to run reconnect_inbox for '${nickname}' — ` +
        "I'll give you a link, you click 'Sign in with Google' once, and it's back.",
    };
  }
  return { row };
}

// Map gmail/oauth thrown errors to structured tool responses. Anything else
// rethrows.
import {
  InboxNeedsReconnectError,
  InboxConfigError,
  TransientError,
} from "../../google/oauth.js";
import { GmailApiError } from "../../gmail/client.js";
import { markNeedsReconnect } from "../../db/inboxes.js";

export interface ToolError {
  ok: false;
  error: string;
  inbox?: string;
  message: string;
}

export async function mapGmailError(
  e: unknown,
  env: Env,
  teammateId: string,
  inbox: InboxRow,
  nickname: string,
): Promise<ToolError> {
  if (e instanceof InboxNeedsReconnectError) {
    await markNeedsReconnect(env.DB, teammateId, inbox.id);
    return {
      ok: false,
      error: "needs_reconnect",
      inbox: nickname,
      message:
        `Your '${nickname}' inbox needs to be reconnected. Ask me to run reconnect_inbox for '${nickname}' — ` +
        "I'll give you a link, you click 'Sign in with Google' once, and it's back.",
    };
  }
  if (e instanceof TransientError) {
    return {
      ok: false,
      error: "transient",
      inbox: nickname,
      message: `'${nickname}' is temporarily unavailable. Try again in a minute.`,
    };
  }
  if (e instanceof InboxConfigError) {
    return {
      ok: false,
      error: "config",
      inbox: nickname,
      message: `'${nickname}' has a credential or configuration problem. Ask your operator to check the server logs.`,
    };
  }
  if (e instanceof GmailApiError) {
    return {
      ok: false,
      error: "gmail_error",
      inbox: nickname,
      message: `Gmail refused that operation on '${nickname}': HTTP ${e.status}.`,
    };
  }
  throw e;
}
