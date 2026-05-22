# End-to-end manual runbook

These are the **manual** verification steps for behaviors that the
automated suites can't (or shouldn't) prove. The automated suites cover
everything testable in workerd; this runbook covers behaviors that
require a real Google sign-in, real Claude.ai, and a real teammate's
attention.

Run this once after the first deploy, and after any significant change
to the OAuth or Gmail-touching code.

## Prerequisites

- A deployed worker at `https://<your-worker>.workers.dev` with the
  bindings + secrets from `docs/operator.md` §2.
- An operator workstation with the CLI configured (`docs/operator.md` §2.6).
- Two **real Gmail accounts** added to the Google Cloud test-user list
  (`docs/operator.md` §2.4). Call them `runbook-a@<domain>` and
  `runbook-b@<domain>`. Personal Gmail is fine; what matters is they're
  on the allowlist.
- Two team-mate personas: `A` and `B`. You can play both for the runbook;
  for the cross-isolation step, use two separate Claude.ai accounts (or
  two separate browser profiles).

## 1. Provision two teammates

```sh
npm run admin -- provision "Runbook-A" --out /tmp/a.key
npm run admin -- provision "Runbook-B" --out /tmp/b.key
npm run admin -- list
```

Expected: `list` shows both teammates, each with a `keys[0].fingerprint`
and no `revoked_at`. No plaintext team keys in the output.

## 2. Teammate A connects the assistant

In Claude.ai (logged in as A):

1. Add a custom MCP connector with URL `https://<worker>.workers.dev/mcp`.
2. Claude.ai opens the **"Paste your team key"** page. Paste the
   contents of `/tmp/a.key` (excluding the BEGIN/END sentinel lines).
3. Click Continue. You should land back on Claude.ai with the connector
   added.

Manual checks:
- The team-key field has `autocomplete="off"`.
- The page has zero JavaScript (View Source — no `<script>` tags).
- Browser DevTools → Network: response headers include
  `referrer-policy: no-referrer`, `cache-control: no-store`,
  `content-security-policy: default-src 'self'; script-src 'none'; ...`.

## 3. Teammate A connects their first Gmail inbox

In Claude with A:

> "Connect my Gmail inbox under the nickname 'work'."

Expected: the assistant returns a sign-in URL. Click it.

Google flow (the screens `docs/teammate.md` walks through):
- "Choose an account" — pick `runbook-a@<domain>`.
- **"Google hasn't verified this app"** — click **Advanced** → **Go to
  ... (unsafe)**.
- Scope grant — review (gmail.readonly, gmail.send, gmail.modify, openid,
  email) and click **Continue / Allow**.

Expected confirmation: a small page reading `Inbox 'work' connected.
You can close this tab...`

Back in Claude:

> "What inboxes do I have?"

Expected: one inbox `work`, with the email matching `runbook-a@`,
`needs_reconnect: false`.

## 4. Teammate A reads and searches

In Claude with A:

> "Search my work inbox for newer_than:7d."

Expected: a list of recent messages, each tagged with `"inbox": "work"`.
Pick any thread id and ask:

> "Read that thread in my work inbox."

Expected: full thread bodies decoded, headers shown, each message's
`body_truncated` flag set sensibly. The response also names
`"inbox": "work"`.

## 5. Teammate A connects a second inbox + cross-inbox search

> "Connect a second inbox under the nickname 'personal' — same Google
> account is fine for the runbook."

(You can use the same account twice if you don't have a second
allowlisted address handy — the inbox uniqueness is on `(teammate_id,
nickname)` AND `(teammate_id, email)`, so this needs a different
account. If you only have one allowlisted, skip ahead to step 6.)

Otherwise, repeat step 3 with `runbook-a-2@<domain>` and nickname
`personal`. Then:

> "Search all my inboxes for newer_than:7d."

Expected: response has `inbox_count: 2`, each hit in `results[]` carries
an `"inbox": "work"` or `"inbox": "personal"` field, and the per-inbox
`inboxes[]` array shows both as `status: "ok"`. If the total exceeds the
shaping cap (40), each inbox shows a `trimmed_from` field.

## 6. Teammate A sends a message (the explicit-from check)

> "Draft a one-line email to runbook-a@<domain> from my work inbox
> saying 'runbook test, please ignore'."

Expected: a draft is created. The response says `"Nothing has been sent."`

> "Send that draft."

(Or compose fresh: "Send a one-line email to runbook-a@... from my work
inbox.")

Expected: the assistant's response **explicitly says** `Sent from 'work'
(<email>)`. Check `runbook-a@<domain>`'s inbox — the message arrives with
the From: header matching the work inbox.

**Critical**: if you ask the assistant to send mail **without specifying
which inbox**, it must refuse or ask. Try:

> "Send a one-line email to runbook-a@... saying 'no from-inbox'."

Expected: the schema rejects the call because `from_inbox` is required.
The assistant should report this back to you, not silently pick a default.

## 7. Reconnect-inbox flow (the 7-day expiry path)

We don't want to wait 7 days. Trigger the path manually:

```sh
# Mark Alice's 'work' inbox as needing reconnect, server-side.
# (In production this happens automatically on the first invalid_grant
# from Google. For the runbook, force it via D1.)
npx wrangler d1 execute gmail-mcp --remote \
  --command "UPDATE inboxes SET needs_reconnect_at = strftime('%s','now')*1000 WHERE nickname='work'"
```

In Claude with A:

> "Search my work inbox."

Expected: a structured error message containing
`Your 'work' inbox needs to be reconnected. Ask me to run reconnect_inbox
for 'work' — I'll give you a link, you click 'Sign in with Google' once,
and it's back.`

> "Reconnect my work inbox."

Expected: a fresh sign-in URL. Click it. Sign in as the **same**
`runbook-a@` account.

Manual check — **wrong account refusal**:
- On the reconnect sign-in page, deliberately pick a *different*
  Google account than the inbox was originally connected to (one that's
  still allowlisted but isn't `runbook-a@`).
- Expected page: **"Wrong Google account"** with text matching
  `'work' was connected to runbook-a@... Start over and pick the right
  account, or use connect_inbox to add this one under a new nickname.`
- Go back and sign in as the correct account. The page should read
  `Inbox 'work' is back.`

## 8. Cross-teammate isolation (the manual sanity match for scenario 5)

In a different browser profile, log in to Claude.ai as Teammate B:

1. Add the MCP connector with the same URL.
2. Paste `/tmp/b.key`.
3. Ask: "What inboxes do I have?" — Expected: `[]`. **B sees none of A's
   inboxes.**
4. Ask: "Search my work inbox." — Expected: `error: "not_found"` or
   equivalent. **B cannot reach A's nickname.**
5. Ask: "Search all my inboxes for newer_than:7d." — Expected:
   `inbox_count: 0, result_count: 0`. No leak.

(The automated isolation suite already covers 18 tool probes including
forged-bearer attempts. This step is the eyes-on sanity check that
nothing surprises us at the assistant-rendering layer.)

## 9. Lifecycle: revoke, rotate, purge — manual confirmation

```sh
# Revoke Teammate B's key.
npm run admin -- revoke "Runbook-B"
```

In Claude with B: ask anything Gmail-related. Expected: **uniform
"session unavailable"** message (the assistant may surface it as a
generic "I can't reach your account right now" — that's fine).

```sh
# Rotate gives B a new key.
npm run admin -- rotate "Runbook-B" > /tmp/b-rotated.key
```

In Claude with B: re-add the connector (or re-paste team key when
prompted). Use the new key. Expected: works again, but B still sees
zero inboxes — rotation doesn't restore any data, just identity.

```sh
# Purge A — full removal including Google revocation.
npm run admin -- purge "Runbook-A"
```

Expected stdout / stderr:
```
  ok       work
  ok       personal     # if you connected a second inbox in step 5
purged teammate Runbook-A; row deleted=yes.
```

Exit code: 0.

Manual check at Google:
- Open https://myaccount.google.com/permissions in `runbook-a@<domain>`.
- Your app should no longer be listed under "Third-party apps with
  account access" — purge revoked the grant.

If you want to see the fail-loud branch, temporarily set
`GOOGLE_CLIENT_SECRET` to a wrong value via `wrangler secret put`,
reconnect an inbox, then run `purge` — you should see `FAIL` lines
on stderr and exit code 4. Restore the secret afterward.

## 10. Clear-block

(Optional, only if you've actually been locked out.)

In a browser, hit the team-key page 5 times with a deliberately wrong
team key. The 6th attempt should be HTTP 429. Then:

```sh
# Get the keyid (or use ip:<your ip>).
npm run admin -- list
npm run admin -- clear-block keyid:<keyid>
```

Retry the team-key paste. Expected: it works again immediately — no
rotation required.

---

## Sign-off

When all ten steps pass, the deploy is verified end-to-end against real
Google + real Claude.ai. Note the date and the worker URL somewhere.
Re-run this runbook after any change that touches:
- `src/auth/oauth_provider.ts`
- `src/google/`
- `src/mcp/transport.ts`
- the `inboxes` D1 schema
- the operator CLI
