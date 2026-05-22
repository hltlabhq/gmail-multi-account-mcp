// Label tools. Gmail's label model:
//   * Labels are per-inbox (per Google account). System labels (INBOX, SENT,
//     UNREAD, etc.) cannot be created or deleted, and we don't second-guess
//     Gmail on that — calls that violate Gmail's rules will surface as a
//     `gmail_error` from mapGmailError.
//   * label_message / label_thread accept a list of label NAMES (not ids) for
//     ergonomics; we resolve names to ids by listing labels first. If a
//     name doesn't exist we return a structured "label_not_found" error.

import { z } from "zod";
import { defineTool } from "../tool_registry.js";
import { resolveInbox, mapGmailError } from "./_inbox_helpers.js";
import {
  listLabels as gmailListLabels,
  createLabel as gmailCreateLabel,
  updateLabel as gmailUpdateLabel,
  deleteLabel as gmailDeleteLabel,
  modifyMessageLabels,
  modifyThreadLabels,
} from "../../gmail/api.js";

const NICKNAME = z.string().min(1).max(40).trim();
const LABEL_NAME = z.string().min(1).max(225).describe("Gmail label name.");

defineTool({
  name: "list_labels",
  description: "List the labels (both user and system) in a named inbox.",
  inputSchema: z.object({ inbox: NICKNAME }),
  async handler({ inbox: nickname }, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, nickname);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const r = await gmailListLabels(env, inbox);
      return {
        ok: true,
        inbox: nickname,
        labels: r.labels.map((l) => ({
          id: l.id,
          name: l.name,
          type: l.type ?? "user",
          message_list_visibility: l.messageListVisibility ?? null,
          label_list_visibility: l.labelListVisibility ?? null,
        })),
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, nickname);
    }
  },
});

defineTool({
  name: "create_label",
  description: "Create a new user label in a named inbox.",
  inputSchema: z.object({
    inbox: NICKNAME,
    name: LABEL_NAME,
    message_list_visibility: z.enum(["show", "hide"]).optional(),
    label_list_visibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const l = await gmailCreateLabel(env, inbox, {
        name: input.name,
        messageListVisibility: input.message_list_visibility,
        labelListVisibility: input.label_list_visibility,
      });
      return { ok: true, inbox: input.inbox, label: { id: l.id, name: l.name } };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});

defineTool({
  name: "update_label",
  description: "Rename a label or change its visibility in a named inbox. Takes the current label name.",
  inputSchema: z.object({
    inbox: NICKNAME,
    name: LABEL_NAME,
    new_name: LABEL_NAME.optional(),
    message_list_visibility: z.enum(["show", "hide"]).optional(),
    label_list_visibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const labels = await gmailListLabels(env, inbox);
      const target = labels.labels.find((l) => l.name === input.name);
      if (!target) {
        return {
          ok: false,
          error: "label_not_found",
          inbox: input.inbox,
          message: `No label named '${input.name}' in '${input.inbox}'.`,
        };
      }
      const updated = await gmailUpdateLabel(env, inbox, target.id, {
        name: input.new_name,
        messageListVisibility: input.message_list_visibility,
        labelListVisibility: input.label_list_visibility,
      });
      return {
        ok: true,
        inbox: input.inbox,
        label: { id: updated.id, name: updated.name },
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});

defineTool({
  name: "delete_label",
  description: "Delete a label (by current name) in a named inbox.",
  inputSchema: z.object({
    inbox: NICKNAME,
    name: LABEL_NAME,
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const labels = await gmailListLabels(env, inbox);
      const target = labels.labels.find((l) => l.name === input.name);
      if (!target) {
        return {
          ok: false,
          error: "label_not_found",
          inbox: input.inbox,
          message: `No label named '${input.name}' in '${input.inbox}'.`,
        };
      }
      await gmailDeleteLabel(env, inbox, target.id);
      return { ok: true, inbox: input.inbox, deleted: input.name };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});

async function resolveLabelNamesToIds(
  env: Awaited<ReturnType<typeof resolveInbox>>,
  inboxRow: { /* placeholder */ } & Parameters<typeof gmailListLabels>[1],
  names: string[],
): Promise<{ ids: string[]; missing: string[] }> {
  const list = await gmailListLabels(
    // The signature here is a small TS workaround: we pass env via the
    // shared resolveInbox flow above. resolveLabelNamesToIds is private to
    // this file and is only invoked after `resolved` is the success variant.
    (env as { row: typeof inboxRow }).row && undefined as never,
    inboxRow,
  );
  const map = new Map<string, string>();
  for (const l of list.labels) map.set(l.name, l.id);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const id = map.get(n);
    if (id) ids.push(id);
    else missing.push(n);
  }
  return { ids, missing };
}
void resolveLabelNamesToIds; // helper kept for future use; replaced inline below.

defineTool({
  name: "label_message",
  description:
    "Apply one or more labels to a specific message in a named inbox. Label names must already exist (use create_label first).",
  inputSchema: z.object({
    inbox: NICKNAME,
    message_id: z.string().min(1).max(200),
    add: z.array(LABEL_NAME).min(1).max(20),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const list = await gmailListLabels(env, inbox);
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of input.add) {
        const found = list.labels.find((l) => l.name === n);
        if (found) ids.push(found.id);
        else missing.push(n);
      }
      if (missing.length > 0) {
        return {
          ok: false,
          error: "label_not_found",
          inbox: input.inbox,
          missing,
          message: `These labels don't exist in '${input.inbox}': ${missing.join(", ")}. Use create_label first.`,
        };
      }
      const r = await modifyMessageLabels(env, inbox, input.message_id, { addLabelIds: ids });
      return {
        ok: true,
        inbox: input.inbox,
        message_id: r.id,
        applied: input.add,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});

defineTool({
  name: "unlabel_message",
  description: "Remove one or more labels from a specific message in a named inbox.",
  inputSchema: z.object({
    inbox: NICKNAME,
    message_id: z.string().min(1).max(200),
    remove: z.array(LABEL_NAME).min(1).max(20),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const list = await gmailListLabels(env, inbox);
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of input.remove) {
        const found = list.labels.find((l) => l.name === n);
        if (found) ids.push(found.id);
        else missing.push(n);
      }
      // For unlabel we tolerate missing names — silently dropping a label
      // that isn't there is fine, but we report which were skipped.
      if (ids.length === 0) {
        return {
          ok: false,
          error: "label_not_found",
          inbox: input.inbox,
          missing,
          message: `None of those labels exist in '${input.inbox}'.`,
        };
      }
      const r = await modifyMessageLabels(env, inbox, input.message_id, { removeLabelIds: ids });
      return {
        ok: true,
        inbox: input.inbox,
        message_id: r.id,
        removed: input.remove.filter((n) => !missing.includes(n)),
        skipped: missing,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});

defineTool({
  name: "label_thread",
  description: "Apply labels to a whole thread (all current and future messages in it) in a named inbox.",
  inputSchema: z.object({
    inbox: NICKNAME,
    thread_id: z.string().min(1).max(200),
    add: z.array(LABEL_NAME).min(1).max(20),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const list = await gmailListLabels(env, inbox);
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of input.add) {
        const found = list.labels.find((l) => l.name === n);
        if (found) ids.push(found.id);
        else missing.push(n);
      }
      if (missing.length > 0) {
        return {
          ok: false,
          error: "label_not_found",
          inbox: input.inbox,
          missing,
          message: `These labels don't exist in '${input.inbox}': ${missing.join(", ")}.`,
        };
      }
      const r = await modifyThreadLabels(env, inbox, input.thread_id, { addLabelIds: ids });
      return { ok: true, inbox: input.inbox, thread_id: r.id, applied: input.add };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});

defineTool({
  name: "unlabel_thread",
  description: "Remove labels from a whole thread in a named inbox.",
  inputSchema: z.object({
    inbox: NICKNAME,
    thread_id: z.string().min(1).max(200),
    remove: z.array(LABEL_NAME).min(1).max(20),
  }),
  async handler(input, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, input.inbox);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const list = await gmailListLabels(env, inbox);
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of input.remove) {
        const found = list.labels.find((l) => l.name === n);
        if (found) ids.push(found.id);
        else missing.push(n);
      }
      if (ids.length === 0) {
        return {
          ok: false,
          error: "label_not_found",
          inbox: input.inbox,
          missing,
          message: `None of those labels exist in '${input.inbox}'.`,
        };
      }
      const r = await modifyThreadLabels(env, inbox, input.thread_id, { removeLabelIds: ids });
      return {
        ok: true,
        inbox: input.inbox,
        thread_id: r.id,
        removed: input.remove.filter((n) => !missing.includes(n)),
        skipped: missing,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, input.inbox);
    }
  },
});
