// Inbox-management MCP tools.
//
// All five take a `nickname` string — never an id. Server-side queries are
// scoped by (teammate_id, nickname); the chokepoint supplies teammate_id.
// defineTool refuses any input-key in FORBIDDEN_INPUT_KEYS at boot.

import { z } from "zod";
import { defineTool } from "../tool_registry.js";
import {
  listInboxes,
  toPublic,
  findInboxByNickname,
  renameInbox as renameInboxRow,
  deleteInbox,
  decryptRefreshToken,
} from "../../db/inboxes.js";
import { createState } from "../../db/oauth_states.js";
import { buildAuthorizeUrl, revokeAtGoogle } from "../../google/oauth.js";
import { log } from "../../util/log.js";

// The nickname is what teammates see. Keep it forgiving but not lawless:
// 1–40 chars, printable.
const NICKNAME = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[\x20-\x7e]+$/, "nickname must be printable ASCII")
  .trim();

function googleCallbackUrl(publicBaseUrl: string): string {
  return new URL("/google/callback", publicBaseUrl).toString();
}

defineTool({
  name: "connect_inbox",
  description:
    "Start connecting a new Gmail inbox. Returns a one-time sign-in URL the " +
    "teammate clicks. After they finish 'Sign in with Google' and pick the " +
    "account, the inbox is registered under the given nickname.",
  inputSchema: z.object({
    nickname: NICKNAME.describe(
      "A short label the teammate uses to refer to this inbox (e.g. 'work', 'support').",
    ),
  }),
  async handler({ nickname }, { teammate, env }) {
    const existing = await findInboxByNickname(env.DB, teammate.id, nickname);
    if (existing) {
      return {
        ok: false,
        error: "nickname_in_use",
        message: `You already have an inbox called '${nickname}'. Pick a different nickname, or use reconnect_inbox if you need to refresh that one.`,
      };
    }
    const state = await createState(env.DB, {
      teammateId: teammate.id,
      purpose: "connect_inbox",
      nickname,
    });
    const url = buildAuthorizeUrl(env, {
      state,
      redirectUri: googleCallbackUrl(env.PUBLIC_BASE_URL),
    });
    return {
      ok: true,
      sign_in_url: url,
      nickname,
      message: `Open this link to sign in with the Google account you want to label '${nickname}'.`,
    };
  },
});

defineTool({
  name: "reconnect_inbox",
  description:
    "Re-authorize an existing Gmail inbox after its refresh token expired or " +
    "was revoked. Returns a one-time sign-in URL. The inbox's nickname, id, " +
    "and connected Google account stay the same — only the credential is " +
    "replaced. Refuses if you sign in with a different Google account on the " +
    "way back.",
  inputSchema: z.object({
    nickname: NICKNAME.describe("The inbox nickname to reconnect."),
  }),
  async handler({ nickname }, { teammate, env }) {
    const inbox = await findInboxByNickname(env.DB, teammate.id, nickname);
    if (!inbox) {
      return {
        ok: false,
        error: "not_found",
        message: `No inbox called '${nickname}'. Run list_inboxes to see what you have, or use connect_inbox to add it.`,
      };
    }
    const state = await createState(env.DB, {
      teammateId: teammate.id,
      purpose: "reconnect_inbox",
      nickname,
    });
    const url = buildAuthorizeUrl(env, {
      state,
      redirectUri: googleCallbackUrl(env.PUBLIC_BASE_URL),
      loginHint: inbox.email,
    });
    return {
      ok: true,
      sign_in_url: url,
      nickname,
      expected_email: inbox.email,
      message: `Open this link and sign in as ${inbox.email}. Signing in with a different account will be refused.`,
    };
  },
});

defineTool({
  name: "list_inboxes",
  description:
    "List all Gmail inboxes the calling teammate has connected. Includes a " +
    "`needs_reconnect` flag per inbox; if true, the teammate should run " +
    "reconnect_inbox for that nickname before any other Gmail action against " +
    "it will work.",
  inputSchema: z.object({}).strict(),
  async handler(_input, { teammate, env }) {
    const rows = await listInboxes(env.DB, teammate.id);
    return {
      inboxes: rows.map(toPublic),
    };
  },
});

defineTool({
  name: "rename_inbox",
  description:
    "Change the nickname of one of your connected inboxes. The connected " +
    "Google account and stored credentials are unchanged.",
  inputSchema: z.object({
    nickname: NICKNAME.describe("Current nickname."),
    new_nickname: NICKNAME.describe("New nickname."),
  }),
  async handler({ nickname, new_nickname }, { teammate, env }) {
    if (nickname === new_nickname) {
      return { ok: true, message: "Nickname unchanged." };
    }
    const result = await renameInboxRow(env.DB, teammate.id, nickname, new_nickname);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return {
          ok: false,
          error: "not_found",
          message: `No inbox called '${nickname}'.`,
        };
      }
      if (result.reason === "conflict") {
        return {
          ok: false,
          error: "nickname_in_use",
          message: `You already have an inbox called '${new_nickname}'.`,
        };
      }
    }
    return { ok: true, nickname: new_nickname };
  },
});

defineTool({
  name: "disconnect_inbox",
  description:
    "Disconnect one of your Gmail inboxes. The server's stored credentials " +
    "are deleted and Google is asked to revoke the grant, so the assistant " +
    "can no longer read or send from that account on your behalf.",
  inputSchema: z.object({
    nickname: NICKNAME.describe("The inbox to disconnect."),
  }),
  async handler({ nickname }, { teammate, env }) {
    const inbox = await findInboxByNickname(env.DB, teammate.id, nickname);
    if (!inbox) {
      return {
        ok: false,
        error: "not_found",
        message: `No inbox called '${nickname}'.`,
      };
    }
    // Best-effort Google revocation. If Google says no, we still delete the
    // local row so the teammate's intent is honored.
    let googleStatus: number | "skipped" = "skipped";
    try {
      const refresh = await decryptRefreshToken(env.AES_MASTER_KEY, inbox);
      const r = await revokeAtGoogle(refresh);
      googleStatus = r.status;
      if (!r.ok) {
        log.warn("inbox.revoke_google_failed", {
          teammate_id: teammate.id,
          inbox_id: inbox.id,
          status: r.status,
        });
      }
    } catch (e) {
      log.warn("inbox.revoke_google_error", {
        teammate_id: teammate.id,
        inbox_id: inbox.id,
        msg: (e as Error).message,
      });
    }
    await deleteInbox(env.DB, teammate.id, inbox.id);
    return {
      ok: true,
      nickname,
      google_revoke_status: googleStatus,
      message: `Disconnected '${nickname}'.`,
    };
  },
});
