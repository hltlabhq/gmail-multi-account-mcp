// Search and read tools for a single named inbox.
//
//   search_one     — Gmail search-query over one inbox; returns trimmed
//                    metadata per match (no message bodies).
//   get_thread     — read a full thread, with bodies decoded and capped.
//   list_messages  — alias for search_one with an empty query; useful when
//                    the teammate just wants "the last N messages."

import { z } from "zod";
import { defineTool } from "../tool_registry.js";
import { resolveInbox, mapGmailError } from "./_inbox_helpers.js";
import {
  listMessages,
  getMessageMetadata,
  getThread,
} from "../../gmail/api.js";
import { findHeader, pickBestBody } from "../../gmail/mime.js";

const NICKNAME = z.string().min(1).max(40).trim();
const QUERY = z.string().min(0).max(2000);

const SEARCH_MAX = 25;
const THREAD_MAX_MESSAGES = 25;
const THREAD_BODY_CHAR_CAP = 4096;

interface SearchHit {
  inbox: string;
  message_id: string;
  thread_id: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  label_ids: string[];
}

defineTool({
  name: "search_one",
  description:
    "Search a single named Gmail inbox. Returns a list of matching messages " +
    "(no bodies — use get_thread to read one). The query is a Gmail search " +
    "expression (e.g. 'from:alice has:attachment newer_than:7d'). Every " +
    "result is explicitly labeled with which inbox it came from.",
  inputSchema: z.object({
    inbox: NICKNAME.describe("The nickname of the inbox to search."),
    query: QUERY.describe("Gmail search query. Empty string returns recent messages."),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(SEARCH_MAX)
      .optional()
      .describe(`Cap on results (default and max: ${SEARCH_MAX}).`),
  }),
  async handler({ inbox: nickname, query, max_results }, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, nickname);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    const cap = max_results ?? SEARCH_MAX;

    try {
      const list = await listMessages(env, inbox, {
        q: query,
        maxResults: cap,
      });
      const ids = (list.messages ?? []).slice(0, cap).map((m) => m.id);
      // Hydrate metadata in parallel. Cap concurrency at the result count
      // (small) and stay well inside the Workers 50-subrequest limit.
      const hits = await Promise.all(
        ids.map(async (id) => {
          const meta = await getMessageMetadata(env, inbox, id);
          const hit: SearchHit = {
            inbox: nickname,
            message_id: id,
            thread_id: meta.threadId,
            from: findHeader(meta.payload?.headers, "From"),
            to: findHeader(meta.payload?.headers, "To"),
            subject: findHeader(meta.payload?.headers, "Subject"),
            date: findHeader(meta.payload?.headers, "Date"),
            snippet: meta.snippet ?? null,
            label_ids: meta.labelIds ?? [],
          };
          return hit;
        }),
      );
      return {
        ok: true,
        inbox: nickname,
        query,
        result_count: hits.length,
        approximate_total: list.resultSizeEstimate ?? hits.length,
        next_page_token: list.nextPageToken ?? null,
        results: hits,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, nickname);
    }
  },
});

defineTool({
  name: "list_messages",
  description:
    "Convenience shortcut for 'search_one' with no query — returns the " +
    "newest messages in a named inbox. Results are labeled by inbox.",
  inputSchema: z.object({
    inbox: NICKNAME.describe("The inbox to list."),
    max_results: z.number().int().min(1).max(SEARCH_MAX).optional(),
  }),
  async handler({ inbox: nickname, max_results }, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, nickname);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    const cap = max_results ?? SEARCH_MAX;
    try {
      const list = await listMessages(env, inbox, { maxResults: cap });
      const ids = (list.messages ?? []).slice(0, cap).map((m) => m.id);
      const hits = await Promise.all(
        ids.map(async (id) => {
          const meta = await getMessageMetadata(env, inbox, id);
          return {
            inbox: nickname,
            message_id: id,
            thread_id: meta.threadId,
            from: findHeader(meta.payload?.headers, "From"),
            subject: findHeader(meta.payload?.headers, "Subject"),
            date: findHeader(meta.payload?.headers, "Date"),
            snippet: meta.snippet ?? null,
          };
        }),
      );
      return {
        ok: true,
        inbox: nickname,
        result_count: hits.length,
        next_page_token: list.nextPageToken ?? null,
        results: hits,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, nickname);
    }
  },
});

defineTool({
  name: "get_thread",
  description:
    "Read a full thread in a named inbox. Returns each message's headers " +
    "and decoded body, capped to keep the response under the Worker's 1MB " +
    "limit (per-message body truncated to ~4KB, thread truncated to the " +
    "first ~25 messages). The inbox the thread came from is named " +
    "explicitly in the response.",
  inputSchema: z.object({
    inbox: NICKNAME.describe("The inbox the thread lives in."),
    thread_id: z.string().min(1).max(200).describe("Gmail thread id (from search results)."),
  }),
  async handler({ inbox: nickname, thread_id }, { teammate, env }) {
    const resolved = await resolveInbox(env, teammate.id, nickname);
    if ("error" in resolved) return resolved;
    const inbox = resolved.row;
    try {
      const t = await getThread(env, inbox, thread_id);
      const messages = (t.messages ?? []).slice(0, THREAD_MAX_MESSAGES);
      const truncatedThread = (t.messages ?? []).length > THREAD_MAX_MESSAGES;
      const out = messages.map((m) => {
        const body = pickBestBody(m.payload, THREAD_BODY_CHAR_CAP);
        return {
          message_id: m.id,
          internal_date: m.internalDate ?? null,
          from: findHeader(m.payload?.headers, "From"),
          to: findHeader(m.payload?.headers, "To"),
          cc: findHeader(m.payload?.headers, "Cc"),
          subject: findHeader(m.payload?.headers, "Subject"),
          date: findHeader(m.payload?.headers, "Date"),
          label_ids: m.labelIds ?? [],
          snippet: m.snippet ?? null,
          body_kind: body.kind,
          body_truncated: body.truncated,
          body: body.text,
        };
      });
      return {
        ok: true,
        inbox: nickname,
        thread_id,
        message_count: out.length,
        thread_truncated: truncatedThread,
        messages: out,
      };
    } catch (e) {
      return mapGmailError(e, env, teammate.id, inbox, nickname);
    }
  },
});
