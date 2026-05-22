// Draft tools — create, list, update, delete. Sending a draft is NOT here;
// that's `send_message` (always explicit, always names the sending inbox).

import { z } from "zod";
import { defineTool } from "../tool_registry.js";
import { resolveInbox, mapGmailError } from "./_inbox_helpers.js";
import { buildMime } from "../../gmail/mime.js";
import {
  listDrafts as gmailListDrafts,
  createDraft as gmailCreateDraft,
  updateDraft as gmailUpdateDraft,
  getDraft as gmailGetDraft,
  deleteDraft as gmailDeleteDraft,
} from "../../gmail/api.js";

const NICKNAME = z.string().min(1).max(40).trim();
const ADDRESS = z.string().min(3).max(320);
const SUBJECT = z.string().max(998).default("");
const BODY = z.string().max(64_000);
const HTML_BODY = z.string().max(128_000).optional();

defineTool({
  name: "create_draft",
  description:
    "Create a new draft in a named inbox. The draft is NOT sent. Returns the " +
    "Gmail draft id; use update_draft to edit it later, or send_message to " +
    "actually send it.",
  inputSchema: z.object({
    inbox: NICKNAME.describe("The inbox to save the draft in."),
    to: z.array(ADDRESS).min(1).max(50).describe("Recipient addresses."),
    cc: z.array(ADDRESS).max(50).optional(),
    bcc: z.array(ADDRESS).max(50).optional(),
    subject: SUBJECT,
    body: BODY.describe("Plain-text body."),
    html_body: HTML_BODY.describe("Optional HTML alternative."),
    thread_id: z.string().min(1).max(200).optional().describe(
      "If replying, the Gmail thread id to attach this draft to.",
    ),
    in_reply_to: z.string().min(1).max(500).optional().describe(
      "Message-Id of the message being replied to (with angle brackets).",
    ),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
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
      threadId: input.thread_id,
    });
    try {
      const created = await gmailCreateDraft(
        env,
        inbox,
        mime.raw_base64url,
        input.thread_id,
      );
      // Refetch via drafts.get to obtain canonical message.id / message.threadId.
      // Gmail's drafts.create response can carry IDs that aren't yet resolvable
      // via threads.get / messages.get in the same session — refetching is the
      // documented way to get IDs the rest of the API will accept.
      const canonical = await gmailGetDraft(env, inbox, created.id);
      return {
        ok: true,
        inbox: input.inbox,
        draft_id: canonical.id,
        message_id: canonical.message.id ?? null,
        thread_id: canonical.message.threadId ?? null,
        message:
          `Draft saved in '${input.inbox}'. Nothing has been sent. ` +
          `Use update_draft to edit or send_message to send.`,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});

defineTool({
  name: "list_drafts",
  description: "List drafts in a named inbox. Returns ids and thread ids only; use get_thread to read the body.",
  inputSchema: z.object({
    inbox: NICKNAME,
    max_results: z.number().int().min(1).max(50).optional(),
  }),
  async handler({ inbox: nickname, max_results }, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, nickname);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const r = await gmailListDrafts(env, inbox, { maxResults: max_results ?? 25 });
      return {
        ok: true,
        inbox: nickname,
        result_count: r.drafts?.length ?? 0,
        next_page_token: r.nextPageToken ?? null,
        drafts: (r.drafts ?? []).map((d) => ({
          inbox: nickname,
          draft_id: d.id,
          message_id: d.message?.id ?? null,
          thread_id: d.message?.threadId ?? null,
        })),
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, nickname);
    }
  },
});

defineTool({
  name: "update_draft",
  description:
    "Replace the contents of an existing draft. The draft id stays the same. " +
    "Does NOT send. Pass the full new recipients/subject/body — this is a " +
    "replacement, not a patch.",
  inputSchema: z.object({
    inbox: NICKNAME,
    draft_id: z.string().min(1).max(200),
    to: z.array(ADDRESS).min(1).max(50),
    cc: z.array(ADDRESS).max(50).optional(),
    bcc: z.array(ADDRESS).max(50).optional(),
    subject: SUBJECT,
    body: BODY,
    html_body: HTML_BODY,
    thread_id: z.string().min(1).max(200).optional(),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    const mime = buildMime({
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body: input.body,
      htmlBody: input.html_body,
    });
    try {
      const updated = await gmailUpdateDraft(
        env,
        inbox,
        input.draft_id,
        mime.raw_base64url,
        input.thread_id,
      );
      // Refetch via drafts.get for canonical IDs — same reason as create_draft.
      const canonical = await gmailGetDraft(env, inbox, updated.id);
      return {
        ok: true,
        inbox: input.inbox,
        draft_id: canonical.id,
        message_id: canonical.message.id ?? null,
        thread_id: canonical.message.threadId ?? null,
        message:
          `Draft '${canonical.id}' updated in '${input.inbox}'. Nothing has been sent.`,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});

defineTool({
  name: "delete_draft",
  description:
    "Delete a draft in a named inbox. The draft is gone permanently — " +
    "this is not 'move to trash', it's the full users.drafts.delete " +
    "operation. The draft's id stops being valid; no recovery from " +
    "this side. Does NOT send.",
  inputSchema: z.object({
    inbox: NICKNAME,
    draft_id: z.string().min(1).max(200),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      await gmailDeleteDraft(env, inbox, input.draft_id);
      return {
        ok: true,
        inbox: input.inbox,
        draft_id: input.draft_id,
        deleted: true,
        message: `Draft '${input.draft_id}' deleted from '${input.inbox}'.`,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});
