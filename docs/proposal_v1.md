# Team Gmail Assistant — Final Build Proposal (v1, approved)

This document is the approved design for the Gmail multi-account MCP server described
in `docs/spec_v1.md`. It supersedes the earlier "Internal app / hd-claim" identity
model. The two access gates and all hardening notes below are the contract under
which the build proceeds.

---

## 1. Product summary

A hosted Gmail MCP server that lets a small, fixed team operate multiple Gmail
inboxes through an AI assistant (e.g. Claude.ai). One technical operator provisions
access; non-technical teammates connect their inboxes by clicking "Sign in with
Google" and giving each a short nickname. The server lives on Cloudflare Workers
(free tier), holds all durable state server-side, and enforces strict per-teammate
isolation.

Not multi-tenant. One team, that team's inboxes. Gmail only. Email only.

---

## 2. Two-gate access model

### Gate 1 — Access to the MCP itself (operator-controlled)

- The operator provisions one **team key** per teammate. The team key is the
  per-teammate, individually revocable credential that proves "I am teammate X"
  during the one-time MCP OAuth handshake with the assistant.
- **No Google Workspace / `hd` / domain enforcement** anywhere in the system.
  Team membership is defined solely by who the operator has issued a key to.
- A team key is a long-lived, reusable secret. The teammate pastes it once
  during MCP authorization; the assistant then holds an MCP refresh token bound
  to that teammate. The teammate keeps the key in case re-authorization is ever
  needed (operator/teammate docs must state this explicitly).

### Gate 2 — Which Gmail accounts a teammate may connect (Google-controlled)

- After a teammate is past Gate 1, they connect inboxes via normal "Sign in with
  Google" OAuth.
- The server enforces no domain/org restriction on the connected account.
  Whatever Google's consent flow permits is acceptable.

---

## 3. Team key

- **Format:** `tk_<keyid>_<secret>` — `keyid` is 8 base32 chars (lookup
  index), `secret` is 32 base32 chars (~160 bits of entropy).
- **At rest:** DB stores only `keyid` and `HMAC-SHA-256(pepper, secret)`.
  Pepper lives in Worker Secrets. A DB read alone cannot impersonate a
  teammate.
- **Verification:** O(1) lookup by `keyid`, then constant-time HMAC compare;
  uniform error responses across "unknown keyid", "bad secret", and "revoked".
- **Lifecycle:** plaintext shown to operator exactly once at provisioning.
  Revoke marks the key revoked. Rotate generates a new key for the same
  teammate and revokes the old one. The teammate then re-pastes on next
  re-authorization.

---

## 4. MCP OAuth flow (Claude.ai ↔ Worker)

Claude.ai speaks standard MCP OAuth 2.1 with PKCE + dynamic client registration
against the Worker's `/oauth/*` endpoints. The only thing that differs from a
typical "Sign in with Google" MCP server is the authorization page.

1. Teammate adds the MCP server in Claude.ai. Claude.ai initiates OAuth and
   redirects the teammate's browser to the Worker's `/oauth/authorize`.
2. The page shows a single field: **"Paste your team key"**.
3. Submit POSTs to `/oauth/authorize/verify`:
   - Parse `tk_<keyid>_<secret>`. Look up by `keyid`. Constant-time-compare
     `HMAC(pepper, secret)` to the stored hash. Reject if not found,
     mismatched, or revoked.
   - Rate-limit failures per IP and per keyid; self-expiring blocks (see §8).
   - On success: bind a new OAuth authorization code to that `teammate_id` and
     the PKCE challenge, then redirect back to Claude.ai's `redirect_uri`.
4. Claude.ai exchanges the code at `/oauth/token` for an access + refresh
   token pair, both bound to `teammate_id` in our DB.
5. Every subsequent MCP call carries the bearer; middleware resolves it to
   `teammate_id` once, at the chokepoint. Tools never accept a `teammate_id`
   parameter.

**Re-authorization:** if Claude.ai ever drops its MCP tokens, the teammate
re-runs the flow and pastes the same team key. No operator action required.

---

## 5. Gmail inbox connection flow (Gate 2)

1. Teammate (via assistant) calls the `connect_inbox` MCP tool. The tool
   returns a one-time URL.
2. Teammate clicks the URL. The Worker starts a Google OAuth flow with the
   minimum-necessary Gmail scopes (read, modify for labels, compose, send).
   The `state` parameter is a short-lived DB row binding the callback to the
   calling `teammate_id`.
3. Google redirects back. Worker exchanges the code for an access + refresh
   token, prompts the teammate for a nickname (short web form), and stores:
   - `email` (from Google),
   - `google_sub` (Google subject),
   - `nickname` (must be unique per teammate),
   - `encrypted_refresh_token` (AES-256-GCM, per-row IV, master key in Secrets),
   - granted `scopes`.
4. No `hd` claim is enforced. Whatever account Google authorized is accepted.

---

## 6. Tech stack & project layout

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (TypeScript, `nodejs_compat`) |
| MCP framework | `@modelcontextprotocol/sdk` + Cloudflare `agents` (`McpAgent`) |
| OAuth Authorization Server | `@cloudflare/workers-oauth-provider` |
| DB | Cloudflare D1 (SQLite) |
| Secrets | Worker Secrets: Google client ID/secret, AES master key, HMAC pepper, OAuth provider signing key, OPERATOR_TOKEN |
| Encryption at rest | AES-256-GCM (Web Crypto), per-row IV |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` (miniflare) |
| Build/deploy | Wrangler |

```
gmail-multi-account-mcp/
  src/
    index.ts                 # Worker entry, routes
    mcp/
      agent.ts               # McpAgent subclass
      tools/                 # one file per group
        inboxes.ts           # connect, list, rename, disconnect
        search.ts            # search_one, search_all (cross-inbox)
        threads.ts           # get_thread, list_messages
        drafts.ts            # create/list/update_draft
        send.ts              # send_message (explicit from_inbox)
        labels.ts            # list/create/update/delete; label/unlabel
    auth/
      mcp_oauth.ts           # workers-oauth-provider config; /oauth/* routes
      authorize_page.ts      # the "paste your team key" HTML page
      team_keys.ts           # generate, hash, verify, revoke, rotate
      google.ts              # Gate-2 OAuth: connect inbox flow
      session.ts             # resolve teammate_id from MCP bearer (chokepoint)
      admin.ts               # /admin/* endpoints (operator-only)
      ratelimit.ts           # per-IP + per-keyid + per-OPERATOR_TOKEN limits
    gmail/
      client.ts              # Gmail REST wrapper (fetch)
      shape.ts               # response trimming for 1 MB cap
    db/
      schema.sql
      teammates.ts, inboxes.ts, team_keys.ts, tokens.ts
    crypto/
      aead.ts                # AES-GCM encrypt/decrypt
      hmac.ts                # peppered HMAC for keys
      ct.ts                  # constant-time compare
    util/
      ids.ts, errors.ts, env.ts, log.ts (with secret-scrubbing)
  bin/
    admin.ts                 # operator CLI (Node)
  migrations/0001_init.sql
  test/                      # vitest suites; includes isolation test
  docs/
    spec_v1.md
    proposal_v1.md           # this file
    operator.md              # operator setup + admin CLI guide
    teammate.md              # teammate onboarding (keep your key!)
  wrangler.toml, package.json, tsconfig.json, .gitignore, README.md
```

---

## 7. Data model (D1)

`teammates`
- `id` TEXT PK
- `display_name` TEXT NOT NULL
- `contact_note` TEXT NULL (operator's free-text reference; informational)
- `created_at` INTEGER NOT NULL
- `revoked_at` INTEGER NULL

`team_keys`
- `keyid` TEXT PK (8 base32 chars)
- `teammate_id` TEXT NOT NULL REFERENCES teammates(id) ON DELETE CASCADE
- `secret_hash` BLOB NOT NULL (HMAC-SHA-256, peppered)
- `created_at` INTEGER NOT NULL
- `revoked_at` INTEGER NULL
- One active row per teammate at a time; superseded rows retained for audit.

`inboxes`
- `id` TEXT PK
- `teammate_id` TEXT NOT NULL REFERENCES teammates(id) ON DELETE CASCADE
- `nickname` TEXT NOT NULL
- `email` TEXT NOT NULL
- `google_sub` TEXT NOT NULL
- `encrypted_refresh_token` BLOB NOT NULL
- `refresh_iv` BLOB NOT NULL
- `scopes` TEXT NOT NULL
- `created_at` INTEGER NOT NULL
- UNIQUE(`teammate_id`,`nickname`), UNIQUE(`teammate_id`,`email`)

OAuth provider tables (`mcp_clients`, `mcp_auth_codes`, `mcp_access_tokens`,
`mcp_refresh_tokens`) — every issued token references `teammate_id`.

`oauth_states` — short-lived rows for in-flight Google OAuth callbacks.

`ratelimit` — bucketed counters for `/oauth/authorize/verify` and `/admin/*`.

---

## 8. Hardening

Applied identically to `/oauth/authorize/verify` **and** `/admin/*`:

- **High-entropy secrets.** Team keys: 160-bit secret. `OPERATOR_TOKEN`:
  ≥ 256 bits.
- **Peppered hash at rest.** Both team-key secrets and (optionally) the
  `OPERATOR_TOKEN` are stored as HMACs, never plaintext, on the server side.
  (`OPERATOR_TOKEN` lives in Worker Secrets, but admin endpoints compare via
  constant-time HMAC of the presented token against an HMAC stored in
  Secrets — see §10.)
- **Constant-time comparisons** on all secret verifications.
- **Uniform errors.** "Unknown keyid", "bad secret", "revoked", and
  "rate-limited" all return the same status + body to outside callers.
- **Self-expiring rate limits.** Per-IP and per-keyid (or per-`OPERATOR_TOKEN`
  for admin) buckets. A per-keyid block self-expires (default: 1 hour);
  operator has a `clear-block` admin command that does **not** force a
  rotation. Defaults: 5 failures per IP per minute → soft block; 20 per hour
  → hard block until next hour.
- **No secrets in logs.** A logging utility scrubs any value matching the
  team-key or operator-token shapes before emission. CI grep guard against
  `console.log` of known-sensitive identifiers.
- **No key material in URLs or referers.** The team key only ever travels in
  a POST body to our own origin over HTTPS. Authorize page sets
  `Referrer-Policy: no-referrer` and a strict CSP.

---

## 9. Operator CLI (`bin/admin.ts`)

Run on the operator's machine. Talks to the deployed Worker over HTTPS,
authenticated by `OPERATOR_TOKEN` read from `~/.gmail-mcp-admin.env` (chmod
600) or an env var — **never** from a CLI flag.

Commands:

```
npm run admin -- provision "Alice" [--note "alice@org"]
    # Prints the new team key on stdout exactly once. Does NOT log it.

npm run admin -- list
    # Shows teammates, key fingerprints (NOT secrets), created/revoked stamps.

npm run admin -- rotate "Alice"
    # Revokes Alice's current key, issues a new one, prints once.

npm run admin -- revoke "Alice"
    # Marks Alice's key revoked. Invalidates her MCP tokens. Keeps her
    # encrypted Gmail tokens in the DB (reversible by issuing a new key).

npm run admin -- purge "Alice"
    # Calls Google's token revocation endpoint for each of Alice's connected
    # inboxes, then deletes inbox rows, MCP tokens, key rows, and the
    # teammate row.

npm run admin -- clear-block <keyid|ip>
    # Manually clears a self-expiring rate-limit block without rotating the
    # key. Used when a legitimate teammate gets locked out.
```

**Echo / history safety (required):**

- `OPERATOR_TOKEN` is read from env / dotfile only. The CLI rejects
  `--operator-token` flags. It is never printed to stdout, stderr, or any log.
- Newly minted team keys are written to **stdout only**, never to log files.
  The CLI prints a one-line warning above and below the key, plus a reminder
  to clear scrollback. On Bash/Zsh, the CLI suggests prefixing invocations
  with a space (HISTCONTROL=ignorespace) and refuses to run if it detects
  `HISTFILE` writing is enabled and `stdout` is a TTY *and* `--unsafe-tty`
  was not passed. (The friendlier path is to redirect to a file the operator
  controls: `npm run admin -- provision "Alice" > alice.key`.)
- The CLI never sets argv such that the team key or OPERATOR_TOKEN appear in
  `ps`. No subprocess invocation is used for HTTP.

---

## 10. `/admin/*` endpoint hardening

- All `/admin/*` routes require `Authorization: Bearer <OPERATOR_TOKEN>`.
- The server stores `HMAC(pepper, OPERATOR_TOKEN)` for comparison — not the
  raw token. Constant-time compare. Uniform error responses.
- Rate-limited identically to `/oauth/authorize/verify` (per-IP, plus a
  per-token bucket).
- No request or response body is logged. Audit log records only
  `{timestamp, route, actor=operator, teammate_id_or_keyid_affected,
  outcome}`.

---

## 11. Strict per-teammate isolation

- A single middleware (`auth/session.ts`) resolves the MCP bearer → exactly
  one `teammate_id`. All tools receive `teammate_id` from the request
  context, never as a parameter.
- Every DB query in `inboxes.ts`, `tokens.ts`, and Gmail tool code is
  parameterized by `teammate_id`. Reviewer rule: no inbox read/write may
  appear without a `WHERE teammate_id = ?` clause (or equivalent FK-scoped
  helper).
- **Explicit isolation test** (carried forward, restated for the team-key
  model):
  - Provision teammates A and B.
  - A authorizes MCP and connects an inbox `A1`.
  - B authorizes MCP and connects an inbox `B1`.
  - With B's MCP bearer, attempt every tool against `A1` (by nickname, by
    inbox id, by message id captured from A's session, etc.). Every attempt
    must fail with a uniform "not found / not yours" response.
  - With B's MCP bearer, list inboxes. `A1` must not appear.
  - Repeat after revoking and re-issuing B's key: still must not see `A1`.
  - Repeat by attempting to forge a Gmail OAuth `state` value from A's
    in-flight flow during B's session. Must fail.
- Test lives in `test/isolation.test.ts` and runs on every CI invocation.

---

## 12. Free-tier fit

- Heaviest path: cross-inbox search across N inboxes. Implemented as N
  parallel `fetch` subrequests to Gmail. Network I/O does not count toward
  Worker CPU. For ~4 inboxes/teammate this is comfortable.
- Per-inbox result counts capped (default 10). Bodies trimmed in `shape.ts`
  to stay under the 1 MB response cap.
- No background timers. The Worker only acts when called.

---

## 13. Behavior list (carried forward unchanged)

See §6 of `docs/spec_v1.md` and the "Plain-language behavior list" in the
previous proposal turn. Restated briefly:

1. Teammate connects the assistant once by pasting a team key. Operator
   issued it; nobody else has one.
2. Teammate connects inboxes by clicking "Sign in with Google" and typing a
   nickname.
3. Teammate can list, rename, disconnect inboxes by asking the assistant.
4. Same teammate can connect several inboxes; all stay connected across
   devices.
5. No teammate ever sees or acts on another teammate's inboxes.
6. Search/read in a named inbox.
7. Read a thread in a named inbox.
8. Single question can span all of the teammate's inboxes; results are
   labeled per inbox.
9. Teammate never has to think about "which inbox is currently connected".
10. Draft, save, edit drafts in a named inbox.
11. Send is explicit; always names the sending inbox out loud.
12. List/create/rename/delete labels; apply/remove on message or thread.
13. Every answer names the inbox it came from.
14. No self-scheduled background work.
15. Disconnect cuts further access cleanly.

---

## 14. Documentation deliverables

- `docs/operator.md` — one-time setup, env config, deploy, admin CLI usage,
  how to revoke / rotate / purge, how to clear a rate-limit block.
- `docs/teammate.md` — what your team key is, how to use it once, **keep it**
  in case re-authorization is needed, what to do if it leaks (ask operator
  to rotate).

---

## 15. Build plan (meaningful commits)

1. Repo init, `.gitignore`, package skeleton, wrangler scaffold.
2. D1 schema + migration runner; in-memory test wiring.
3. Crypto utilities (AES-GCM, HMAC, constant-time compare) + tests.
4. Team-key generate/hash/verify + tests.
5. `/admin/*` endpoints + operator CLI (`bin/admin.ts`); echo/history safety;
   admin rate limit + uniform errors; admin endpoint tests.
6. OAuth Authorization Server skeleton (`workers-oauth-provider`) + the
   "paste your team key" authorize page + `/oauth/authorize/verify`;
   rate-limit; uniform errors; tests.
7. MCP server skeleton (`McpAgent`), session middleware (`teammate_id`
   chokepoint), one trivial `whoami` tool for end-to-end smoke.
8. Gmail OAuth (Gate 2) connect-inbox flow + inbox CRUD MCP tools + tests.
9. Single-inbox tools: search, threads, drafts, labels, send.
10. Cross-inbox `search_all` with per-inbox labeling and response shaping.
11. Isolation test suite (`test/isolation.test.ts`) — mandatory green.
12. `purge` calls Google's token revocation endpoint for each inbox before
    deletion; revoke / rotate / clear-block round-trip tests.
13. Operator + teammate docs.
14. End-to-end manual test instructions (operator runbook).

Each step is a self-contained commit (or small series). No remote — local git
only.
