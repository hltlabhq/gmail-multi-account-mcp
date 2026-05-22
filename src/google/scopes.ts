// Minimum-necessary Gmail scopes. Each capability below is justified by a
// behavior in docs/spec_v1.md; do not add scopes without a corresponding
// behavior, and never request a broader scope when a narrower one suffices.
//
//   gmail.readonly    — list/search threads, read message bodies.
//   gmail.send        — send_message tool only. Does NOT include read or modify.
//   gmail.modify      — drafts (create/get/update/DELETE), labels
//                       (apply/remove), label CRUD. Per Google's
//                       users.drafts.delete API reference, gmail.modify
//                       is sufficient for draft deletion — gmail.compose
//                       is NOT additionally required (audit-review
//                       2026-05-22 verified this against the live docs).
//                       (gmail.modify implies read; we keep gmail.readonly
//                        anyway because some Gmail endpoints behave better
//                        when both are present and Google de-duplicates.)
//   openid email      — needed to learn the connected account's google_sub
//                       (subject claim) and primary email for nickname
//                       collision checks.
//
// Notably absent: gmail.settings, gmail.compose (modify covers drafts),
// gmail.metadata (too narrow), gmail.full (overshoot).

export const GMAIL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export const GMAIL_SCOPE_STRING = GMAIL_SCOPES.join(" ");
