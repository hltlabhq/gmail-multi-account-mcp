// Thin typed wrappers around Gmail's REST API. Each function is a single
// HTTP call via gmailFetch(). Response-shaping (truncating bodies, capping
// lists) happens in the tools that wrap these, not here.

import type { Env } from "../index.js";
import type { InboxRow } from "../db/inboxes.js";
import { gmailFetch } from "./client.js";
import { type GmailPayload } from "./mime.js";

export interface MessageSummary {
  id: string;
  threadId: string;
}

export interface MessageMetadataResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayload;
}

export interface ListMessagesResponse {
  messages?: MessageSummary[];
  resultSizeEstimate?: number;
  nextPageToken?: string;
}

export async function listMessages(
  env: Env,
  inbox: InboxRow,
  args: { q?: string; pageToken?: string; maxResults?: number; labelIds?: string[] },
): Promise<ListMessagesResponse> {
  return gmailFetch<ListMessagesResponse>(env, inbox, "/users/me/messages", {
    searchParams: {
      q: args.q,
      pageToken: args.pageToken,
      maxResults: args.maxResults,
      // labelIds is multi-valued; we collapse to comma list via the
      // searchParams stringifier. Gmail accepts repeated params; we keep it
      // simple by joining and reissuing as needed below.
      labelIds: args.labelIds?.join(","),
    },
  });
}

export async function getMessageMetadata(
  env: Env,
  inbox: InboxRow,
  messageId: string,
  format: "metadata" | "minimal" = "metadata",
): Promise<MessageMetadataResponse> {
  return gmailFetch<MessageMetadataResponse>(
    env,
    inbox,
    `/users/me/messages/${encodeURIComponent(messageId)}`,
    { searchParams: { format } },
  );
}

export interface FullMessageResponse extends MessageMetadataResponse {
  payload?: GmailPayload;
}

export async function getMessageFull(
  env: Env,
  inbox: InboxRow,
  messageId: string,
): Promise<FullMessageResponse> {
  return gmailFetch<FullMessageResponse>(
    env,
    inbox,
    `/users/me/messages/${encodeURIComponent(messageId)}`,
    { searchParams: { format: "full" } },
  );
}

export interface ThreadResponse {
  id: string;
  historyId?: string;
  messages?: FullMessageResponse[];
}

export async function getThread(
  env: Env,
  inbox: InboxRow,
  threadId: string,
): Promise<ThreadResponse> {
  return gmailFetch<ThreadResponse>(
    env,
    inbox,
    `/users/me/threads/${encodeURIComponent(threadId)}`,
    { searchParams: { format: "full" } },
  );
}

export interface ModifyResult {
  id: string;
  threadId: string;
  labelIds?: string[];
}

export async function modifyMessageLabels(
  env: Env,
  inbox: InboxRow,
  messageId: string,
  args: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<ModifyResult> {
  return gmailFetch<ModifyResult>(
    env,
    inbox,
    `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: "POST",
      body: JSON.stringify({
        addLabelIds: args.addLabelIds ?? [],
        removeLabelIds: args.removeLabelIds ?? [],
      }),
    },
  );
}

export async function modifyThreadLabels(
  env: Env,
  inbox: InboxRow,
  threadId: string,
  args: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<ModifyResult> {
  return gmailFetch<ModifyResult>(
    env,
    inbox,
    `/users/me/threads/${encodeURIComponent(threadId)}/modify`,
    {
      method: "POST",
      body: JSON.stringify({
        addLabelIds: args.addLabelIds ?? [],
        removeLabelIds: args.removeLabelIds ?? [],
      }),
    },
  );
}

export interface LabelResource {
  id: string;
  name: string;
  type?: "user" | "system";
  messageListVisibility?: "show" | "hide";
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
}

export async function listLabels(env: Env, inbox: InboxRow): Promise<{ labels: LabelResource[] }> {
  return gmailFetch<{ labels: LabelResource[] }>(env, inbox, "/users/me/labels");
}

export async function createLabel(
  env: Env,
  inbox: InboxRow,
  args: Pick<LabelResource, "name" | "messageListVisibility" | "labelListVisibility">,
): Promise<LabelResource> {
  return gmailFetch<LabelResource>(env, inbox, "/users/me/labels", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function updateLabel(
  env: Env,
  inbox: InboxRow,
  id: string,
  patch: Partial<Pick<LabelResource, "name" | "messageListVisibility" | "labelListVisibility">>,
): Promise<LabelResource> {
  return gmailFetch<LabelResource>(env, inbox, `/users/me/labels/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteLabel(env: Env, inbox: InboxRow, id: string): Promise<void> {
  await gmailFetch(env, inbox, `/users/me/labels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export interface DraftResource {
  id: string;
  message: { id?: string; threadId?: string; labelIds?: string[]; payload?: GmailPayload; raw?: string };
}

export interface DraftListResponse {
  drafts?: { id: string; message?: { id: string; threadId: string } }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export async function listDrafts(
  env: Env,
  inbox: InboxRow,
  args: { pageToken?: string; maxResults?: number; q?: string } = {},
): Promise<DraftListResponse> {
  return gmailFetch<DraftListResponse>(env, inbox, "/users/me/drafts", {
    searchParams: args,
  });
}

// users.drafts.get with format=metadata returns the draft's stored message
// reference with canonical id + threadId. Used after create/update to
// resolve IDs that get_thread / messages.get will actually accept — Gmail's
// drafts.create response can carry message IDs that aren't yet resolvable
// via the thread endpoint, so callers MUST refetch.
export async function getDraft(
  env: Env,
  inbox: InboxRow,
  draftId: string,
  format: "minimal" | "metadata" | "full" = "metadata",
): Promise<DraftResource> {
  return gmailFetch<DraftResource>(
    env,
    inbox,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    { searchParams: { format } },
  );
}

export async function createDraft(
  env: Env,
  inbox: InboxRow,
  raw_base64url: string,
  threadId?: string,
): Promise<DraftResource> {
  return gmailFetch<DraftResource>(env, inbox, "/users/me/drafts", {
    method: "POST",
    body: JSON.stringify({
      message: { raw: raw_base64url, ...(threadId ? { threadId } : {}) },
    }),
  });
}

export async function updateDraft(
  env: Env,
  inbox: InboxRow,
  draftId: string,
  raw_base64url: string,
  threadId?: string,
): Promise<DraftResource> {
  return gmailFetch<DraftResource>(
    env,
    inbox,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: { raw: raw_base64url, ...(threadId ? { threadId } : {}) },
      }),
    },
  );
}

// users.drafts.delete — covered by gmail.modify per Google's API reference
// (https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/delete):
//   "Requires one of the following OAuth scopes:
//      https://mail.google.com/
//      https://www.googleapis.com/auth/gmail.modify
//      https://www.googleapis.com/auth/gmail.compose"
// We already have gmail.modify, so adding delete_draft requires no scope
// change and no operator-visible re-consent.
export async function deleteDraft(
  env: Env,
  inbox: InboxRow,
  draftId: string,
): Promise<void> {
  await gmailFetch(
    env,
    inbox,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    { method: "DELETE" },
  );
}

export async function sendMessage(
  env: Env,
  inbox: InboxRow,
  raw_base64url: string,
  threadId?: string,
): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
  return gmailFetch<{ id: string; threadId: string; labelIds?: string[] }>(
    env,
    inbox,
    "/users/me/messages/send",
    {
      method: "POST",
      body: JSON.stringify({
        raw: raw_base64url,
        ...(threadId ? { threadId } : {}),
      }),
    },
  );
}
