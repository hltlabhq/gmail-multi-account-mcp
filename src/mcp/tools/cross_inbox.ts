// search_all — the one cross-inbox tool. Behavior is locked by the design
// notes in increment 10. Key invariants:
//
//   * Inbox set comes ONLY from the chokepoint's resolved teammate. There
//     is no input field for selecting inboxes. (defineTool's boot guard
//     also refuses identity-shaped fields.)
//   * One inbox's failure (needs_reconnect / 5xx / config) never aborts the
//     whole request. Promise.allSettled drives the dispatch; each inbox's
//     status surfaces structurally in the response.
//   * Per-hit `inbox` label is structural — every hit object is built only
//     via makeHit() which requires the inbox nickname.
//   * Response is shaped to fit the Workers 1MB cap: proportional trim
//     across inboxes if total hits exceed MAX_TOTAL_HITS, then a single
//     re-serialize with truncated snippets if the byte target is exceeded.
//   * Merge is O(N log N) for N <= ~100 hits — CPU-trivial for ~4 inboxes.

import { z } from "zod";
import { defineTool } from "../tool_registry.js";
import { listInboxes, type InboxRow } from "../../db/inboxes.js";
import { listMessages, getMessageMetadata } from "../../gmail/api.js";
import { findHeader } from "../../gmail/mime.js";
import { mapGmailError, type ToolError } from "./_inbox_helpers.js";
import { log } from "../../util/log.js";

const QUERY = z.string().min(0).max(2000);
const PER_INBOX_FETCH_CAP = 25;
const MAX_TOTAL_HITS = 40;
const MIN_PER_INBOX_KEEP = 2;     // if an inbox had hits, keep at least this many
const SOFT_BYTE_TARGET = 900_000; // leave headroom below the 1 MB Workers cap
const SHORT_SNIPPET_CHARS = 120;

interface Hit {
  inbox: string;           // structural: REQUIRED, first.
  message_id: string;
  thread_id: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  internal_date_ms: number;
  snippet: string | null;
  label_ids: string[];
}

// makeHit is the only constructor for a Hit. The signature forces `inbox` to
// be supplied — no path can produce a Hit without it.
function makeHit(args: {
  inbox: string;
  meta: {
    id?: string;
    threadId?: string;
    snippet?: string;
    labelIds?: string[];
    internalDate?: string;
    payload?: { headers?: { name: string; value: string }[] };
  };
}): Hit {
  return {
    inbox: args.inbox,
    message_id: args.meta.id ?? "",
    thread_id: args.meta.threadId ?? "",
    from: findHeader(args.meta.payload?.headers, "From"),
    to: findHeader(args.meta.payload?.headers, "To"),
    subject: findHeader(args.meta.payload?.headers, "Subject"),
    date: findHeader(args.meta.payload?.headers, "Date"),
    internal_date_ms: args.meta.internalDate ? Number(args.meta.internalDate) : 0,
    snippet: args.meta.snippet ?? null,
    label_ids: args.meta.labelIds ?? [],
  };
}

interface PerInboxOk {
  nickname: string;
  status: "ok";
  hit_count: number;
  trimmed_from?: number;
}
interface PerInboxFail {
  nickname: string;
  status: "needs_reconnect" | "transient" | "config" | "gmail_error";
  message: string;
}
type PerInbox = PerInboxOk | PerInboxFail;

defineTool({
  name: "search_all",
  description:
    "Search every Gmail inbox the calling teammate has connected, in parallel. " +
    "Returns one unified list of hits, each labeled with the inbox it came " +
    "from. If any inbox is unavailable (needs reconnection, transient error, " +
    "etc.) the request still succeeds for the others — the response's " +
    "per-inbox `inboxes` list says exactly which inboxes returned what, and " +
    "the top-level `partial` flag is true. There is no way to select which " +
    "inboxes to search; it's always all of yours.",
  inputSchema: z.object({
    query: QUERY.describe(
      "Gmail search expression (e.g. 'newer_than:7d is:unread'). Empty string returns recent messages from each inbox.",
    ),
    max_results_per_inbox: z
      .number()
      .int()
      .min(1)
      .max(PER_INBOX_FETCH_CAP)
      .optional()
      .describe(`Cap on hits fetched from EACH inbox before merging (default and max: ${PER_INBOX_FETCH_CAP}).`),
  }),
  async handler({ query, max_results_per_inbox }, { teammate, env }) {
    const perInboxCap = max_results_per_inbox ?? PER_INBOX_FETCH_CAP;
    // Inbox set: chokepoint-derived. Never from input.
    const inboxes = await listInboxes(env.DB, teammate.id);

    if (inboxes.length === 0) {
      return {
        ok: true,
        query,
        inbox_count: 0,
        result_count: 0,
        partial: false,
        truncated: false,
        inboxes: [],
        results: [],
        message:
          "You haven't connected any Gmail inboxes yet — ask me to run connect_inbox.",
      };
    }

    // Dispatch in parallel; allSettled ensures one failure never aborts the
    // whole request.
    const dispatched = await Promise.allSettled(
      inboxes.map((inbox) => searchOneInbox(env, inbox, query, perInboxCap)),
    );

    const perInbox: PerInbox[] = [];
    const allHits: Hit[] = [];
    const byInbox = new Map<string, Hit[]>();

    for (let i = 0; i < inboxes.length; i++) {
      const inbox = inboxes[i]!;
      const settled = dispatched[i]!;
      const nickname = inbox.nickname;
      if (inbox.needs_reconnect_at !== null) {
        // The per-inbox search function would have returned needs_reconnect
        // anyway, but surfacing it here is cleaner and avoids one round trip
        // worth of state churn.
        perInbox.push({
          nickname,
          status: "needs_reconnect",
          message:
            `Your '${nickname}' inbox needs to be reconnected. Ask me to run reconnect_inbox for '${nickname}' — ` +
            "I'll give you a link, you click 'Sign in with Google' once, and it's back.",
        });
        continue;
      }
      if (settled.status === "rejected") {
        // Unexpected — searchOneInbox catches all known errors. Treat as
        // transient and move on.
        log.warn("search_all.unexpected_rejection", {
          teammate_id: teammate.id,
          nickname,
          msg: (settled.reason as Error)?.message ?? "unknown",
        });
        perInbox.push({
          nickname,
          status: "transient",
          message: `'${nickname}' is temporarily unavailable. Try again in a minute.`,
        });
        continue;
      }
      const value = settled.value;
      if ("error" in value) {
        perInbox.push({
          nickname,
          status: errToStatus(value),
          message: value.message,
        });
        continue;
      }
      // ok branch
      byInbox.set(nickname, value.hits);
      allHits.push(...value.hits);
      perInbox.push({
        nickname,
        status: "ok",
        hit_count: value.hits.length,
      });
    }

    // Proportional trim if over budget. Each inbox shrinks by the same
    // ratio; floor preserves at least MIN_PER_INBOX_KEEP for any inbox that
    // had hits, until the global cap is exhausted.
    let truncated = false;
    if (allHits.length > MAX_TOTAL_HITS) {
      truncated = true;
      const ratio = MAX_TOTAL_HITS / allHits.length;
      const kept: Hit[] = [];
      for (const entry of perInbox) {
        if (entry.status !== "ok") continue;
        const hits = byInbox.get(entry.nickname) ?? [];
        const target = Math.max(
          MIN_PER_INBOX_KEEP,
          Math.floor(hits.length * ratio),
        );
        const slice = hits.slice(0, Math.min(target, hits.length));
        entry.trimmed_from = entry.hit_count;
        entry.hit_count = slice.length;
        kept.push(...slice);
      }
      // Sort newest-first by internal_date_ms across all inboxes.
      kept.sort((a, b) => b.internal_date_ms - a.internal_date_ms);
      allHits.length = 0;
      allHits.push(...kept);
    } else {
      // Same sort order even when not trimming, for consistent assistant UX.
      allHits.sort((a, b) => b.internal_date_ms - a.internal_date_ms);
    }

    const partial =
      truncated ||
      perInbox.some((p) => p.status !== "ok");

    let response = {
      ok: true,
      query,
      inbox_count: inboxes.length,
      result_count: allHits.length,
      partial,
      truncated,
      inboxes: perInbox,
      results: allHits,
    };

    // Byte-target backstop. With our hit cap (40) and metadata-only payloads
    // we're typically well under 100KB, but a pathological snippet length
    // could push us up. One re-pass with shorter snippets.
    let serialized = JSON.stringify(response);
    if (serialized.length > SOFT_BYTE_TARGET) {
      const compactHits = allHits.map((h) => ({
        ...h,
        snippet:
          h.snippet === null
            ? null
            : h.snippet.length > SHORT_SNIPPET_CHARS
              ? h.snippet.slice(0, SHORT_SNIPPET_CHARS) + "…"
              : h.snippet,
      }));
      response = { ...response, truncated: true, results: compactHits };
      serialized = JSON.stringify(response);
      // If still over after snippet shortening, leave as is — the assistant
      // will surface what we have. Per-inbox trimmed_from already reflects
      // the count truncation; this is the snippet-length backstop.
    }

    return response;
  },
});

interface PerInboxSearchOk {
  hits: Hit[];
}
type PerInboxSearchResult = PerInboxSearchOk | ToolError;

async function searchOneInbox(
  env: Parameters<Parameters<typeof defineTool>[0]["handler"]>[1]["env"],
  inbox: InboxRow,
  query: string,
  perInboxCap: number,
): Promise<PerInboxSearchResult> {
  try {
    const list = await listMessages(env, inbox, { q: query, maxResults: perInboxCap });
    const ids = (list.messages ?? []).slice(0, perInboxCap).map((m) => m.id);
    const metadata = await Promise.all(
      ids.map((id) => getMessageMetadata(env, inbox, id)),
    );
    const hits = metadata.map((meta) => makeHit({ inbox: inbox.nickname, meta }));
    return { hits };
  } catch (e) {
    // mapGmailError handles InboxNeedsReconnect/Transient/Config/GmailApi.
    // For unknown errors it rethrows; we catch at the dispatcher.
    return await mapGmailError(e, env, inbox.teammate_id, inbox, inbox.nickname);
  }
}

function errToStatus(
  e: ToolError,
): "needs_reconnect" | "transient" | "config" | "gmail_error" {
  if (
    e.error === "needs_reconnect" ||
    e.error === "transient" ||
    e.error === "config" ||
    e.error === "gmail_error"
  ) {
    return e.error;
  }
  // Default to gmail_error for any unrecognized non-ok payload.
  return "gmail_error";
}
