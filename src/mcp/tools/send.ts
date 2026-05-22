// send_message — the ONLY tool that actually puts mail in someone else's
// inbox. By design:
//
//   * The sending inbox is named explicitly as `from_inbox` (no implicit
//     "current" or "default" inbox). The spec_v1 doc calls this out
//     specifically: "Sending mail is always a deliberate, explicit action
//     with an explicitly named sending inbox."
//   * No other tool sends mail as a side effect. Drafts are saved, not sent.
//   * The response always names the inbox the mail went out from.

import { z } from "zod";
import { defineTool } from "../tool_registry.js";
import { resolveInbox, mapGmailError } from "./_inbox_helpers.js";
import { buildMime } from "../../gmail/mime.js";
import { sendMessage as gmailSendMessage } from "../../gmail/api.js";
import { log } from "../../util/log.js";

const NICKNAME = z.string().min(1).max(40).trim();
const ADDRESS = z.string().min(3).max(320);

defineTool({
  name: "send_message",
  description:
    "Send an email from a named inbox. This is the only way to actually send " +
    "mail — drafts and replies via other tools never send by themselves. The " +
    "response names the inbox the message went out from.",
  inputSchema: z.object({
    from_inbox: NICKNAME.describe(
      "Nickname of the inbox to send from. Required and explicit — there is no default.",
    ),
    to: z.array(ADDRESS).min(1).max(50),
    cc: z.array(ADDRESS).max(50).optional(),
    bcc: z.array(ADDRESS).max(50).optional(),
    subject: z.string().max(998).default(""),
    body: z.string().max(64_000),
    html_body: z.string().max(128_000).optional(),
    thread_id: z.string().min(1).max(200).optional().describe(
      "If this is a reply, the Gmail thread id to attach to.",
    ),
    in_reply_to: z.string().min(1).max(500).optional().describe(
      "Message-Id of the message being replied to (with angle brackets).",
    ),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.from_inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    const mime = buildMime({
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body: input.body,
      htmlBody: input.html_body,
      inReplyTo: input.in_reply_to,
    });
    try {
      const sent = await gmailSendMessage(env, inbox, mime.raw_base64url, input.thread_id);
      log.info("mail.sent", {
        teammate_id: teammate.id,
        inbox_id: inbox.id,
        message_id: sent.id,
        // Recipient counts only — never log addresses.
        to_count: input.to.length,
        cc_count: input.cc?.length ?? 0,
        bcc_count: input.bcc?.length ?? 0,
      });
      return {
        ok: true,
        sent_from_inbox: input.from_inbox,
        sent_from_email: inbox.email,
        message_id: sent.id,
        thread_id: sent.threadId,
        message: `Sent from '${input.from_inbox}' (${inbox.email}).`,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.from_inbox);
    }
  },
});
