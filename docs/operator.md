# Operator runbook — Team Gmail Assistant

You are the **one person** who sets this server up. After the steps below,
teammates onboard themselves by clicking "Sign in with Google" once — no
terminal, no credentials, no configuration. You issue them a team key, they
paste it in once, and that's their part done.

This doc covers: one-time setup, deployment, the operator CLI, lifecycle
operations (revoke / rotate / purge / clear-block), and troubleshooting.

---

## Isolation guarantees

Before you stand this up against a team's real mail, you should understand
what the server enforces and what it doesn't.

### What is guaranteed

**Per-teammate isolation.** Teammate A cannot read, search, list, draft,
send, label, or otherwise touch any of teammate B's connected Gmail
inboxes. A's MCP bearer reaches A's data only, regardless of what tool
input names or identifiers A passes. This guarantee holds across every
tool the server exposes.

### How it is enforced (real mechanisms)

Three load-bearing pieces in the code:

- **Session chokepoint.** Every MCP tool call routes through
  `resolveTeammate(env, props)` in `src/auth/session.ts:52` before any
  tool handler runs. The call site is `src/mcp/transport.ts:69`. The
  chokepoint takes the OAuth-library-decrypted props from the validated
  bearer, looks up the teammate row in D1, and refuses if the row is
  missing or `revoked_at` is set. A request that can't resolve to a
  single live teammate never reaches a tool.

- **No tool can be handed an identity.** At tool-registration time,
  `defineTool()` in `src/mcp/tool_registry.ts` walks each tool's Zod
  input schema and rejects any input field whose name appears in
  `FORBIDDEN_INPUT_KEYS` (line 19): `teammate_id`, `teammateId`,
  `tm_id`, `user_id`, `userId`, `owner_id`, `ownerId`, `operator_token`,
  `team_key`, `teamKey`. A future change that tried to introduce a tool
  taking another teammate's identity as input would fail to register —
  the Worker would not boot. The teammate identity always comes from
  the chokepoint's resolved value, never from input.

- **Every inbox / token query is teammate-scoped at the SQL.** All
  reads and writes against the `inboxes` table in `src/db/inboxes.ts`
  carry `WHERE teammate_id = ?` (or an equivalent FK-scoped helper),
  with `teammate_id` always taken from the chokepoint. There is no
  helper that fetches an inbox by id alone.

### How it is tested

`test/integration/isolation.test.ts` runs six scenarios end-to-end
through the real `/mcp` Streamable HTTP transport against
miniflare-backed D1 and KV — the same runtime the deploy uses. Two
scenarios are the load-bearing ones:

- **Scenario 3 — token-substitution forgery** (line 278). A bearer is
  forged with teammate A's userId prefix and teammate B's secret half
  (and vice versa). The OAuth library refuses at the API gate because
  the props-decryption key is wrapped into the bearer's secret part;
  splicing breaks the wrapping. Neither forged bearer reaches any
  handler. Alice's `teammate_id` never appears in any response body.

- **Scenario 5 — every tool, B's real bearer, A's identifiers**
  (line 346). With Bob's legitimately-issued bearer, the test calls
  18 separate tools (every inbox-management, search, thread, draft,
  send, and label tool plus `search_all`), each parameterized with
  Alice's nickname / inbox id / google_sub. Every call returns the
  uniform `not_found` shape; Alice's email, inbox id, and google_sub
  never appear in any response.

The other four scenarios cover identity round-trip via `whoami`,
revoked-teammate refusal, oauth_states integrity, and rotation
preserving isolation.

### Honest caveats

The guarantee above is **per-teammate isolation at the application
layer**. It is not a guarantee against the operator and not a guarantee
against access to the underlying Cloudflare account.

- **The operator token is a separate, privileged credential.** Whoever
  holds the raw `OPERATOR_TOKEN` (or the dotfile at
  `~/.gmail-mcp-admin.env` that contains it) can provision, rotate,
  revoke, and purge any teammate via the `/admin/*` endpoints. The
  operator role is outside the per-teammate isolation model by design —
  the operator is the model's root of trust.

- **Cloudflare account access is separate.** Anyone with admin access
  to the Cloudflare account (Workers / D1 / KV via dashboard or
  `wrangler`) can read the raw stored rows directly, bypassing the
  Worker entirely. The stored refresh tokens are encrypted at rest
  with `AES_MASTER_KEY` (a Worker Secret) and tied to row id via AAD,
  so raw D1 access yields ciphertext rather than plaintext tokens —
  but anyone who can read the D1 rows can also read the AES master key
  (it's in the same Cloudflare account's Worker Secrets).

- **Bearer tokens are bearers.** A teammate's MCP access token, once
  issued, is sufficient to act as that teammate. If a teammate's
  Claude.ai session is compromised, the attacker can reach that
  teammate's inboxes the same way the teammate would. Operator
  recovery is `admin rotate "<name>"` (kills the existing tokens and
  reissues a fresh team key).

The first two caveats are honest scoping — they describe what this
codebase claims and what it doesn't. The per-teammate isolation
guarantee inside that scope is the property the test suite proves.

---

## 1. What you need before you start

- A **Cloudflare account** on the Workers Free plan (or higher). SQLite-backed
  Durable Objects aren't needed by this server (the MCP transport is
  stateless), but you'll use Workers, D1, and KV.
- A **Google Cloud project** with OAuth credentials in **External + Testing**
  mode. (See §2.4 — there is a teammate-side consequence.)
- **Node 22+** locally (we use `node:sqlite` in unit tests).
- **Wrangler 3.114.17** (pinned in `package.json`; do not upgrade to 4.x mid-deploy).

---

## 2. One-time setup

### 2.1 Install and patch dependencies

```sh
npm install
```

The `postinstall` script applies `patches/ajv+8.20.0.patch`, which **inlines
the JSON requires inside the `ajv` library**. This is a permanent build
dependency.

> **Why the ajv patch is permanent.** The MCP SDK transitively depends on
> `ajv@8.20`, which uses `require("./refs/*.json")`. Workerd cannot resolve
> dynamic JSON requires from CJS-via-ESM-shimmed modules — both `wrangler
> dev` and `wrangler deploy` will fail at module-load without the patch.
> The patch converts each `require("./*.json")` in `ajv/dist/**/*.js` into
> an inline JS object literal. **If you upgrade `ajv` or `@modelcontextprotocol/sdk`,
> re-run `node scripts/inline_ajv_json_requires.mjs && npx patch-package ajv`
> to regenerate the patch.**

### 2.2 Create the Cloudflare resources

First, create your operator-local `wrangler.toml` from the committed
template (`wrangler.toml` itself is gitignored; each operator maintains
their own with their real Cloudflare resource IDs):

```sh
cp wrangler.toml.example wrangler.toml
```

Then:

```sh
# Once per environment. Note the IDs from the output and paste them into
# wrangler.toml in place of the REPLACE_WITH_* placeholders.
npx wrangler d1 create gmail-mcp
npx wrangler kv namespace create OAUTH_KV
```

Edit `wrangler.toml` (the local one you just copied — not the
`.example` template, which stays as-is):
- Set `[[d1_databases]].database_id` to the D1 id from `d1 create`.
- Set `[[kv_namespaces]].id` to the KV id from `kv namespace create`.

### 2.3 Apply the D1 migrations

```sh
npx wrangler d1 migrations apply DB --remote
```

(The `npm run migrate:remote` script in `package.json` is a thin wrapper
around this exact command — either form works and runs the same thing.
The direct command is used here and in `docs/deploy.md` step 7 so the
two docs read identically when followed side by side.)

### 2.4 Google OAuth client — External + Testing

> **`docs/deploy.md` has the step-by-step click path with screenshots-style
> instructions.** This section is the reference / why-it-looks-this-way
> companion.

This server is designed around Google's **External + Testing** OAuth mode.
There is no "Internal" path for this deploy — even if every teammate
sits in the same Google Workspace organization, the app stays External
+ Testing because:

- Internal apps require all consent flows to come from the same
  Workspace org, with no way to add outside addresses. External +
  Testing lets you add any Gmail address (Workspace or personal) to the
  test-users allowlist.
- The server's design pins behavior to External + Testing semantics —
  in particular the ~7-day refresh-token expiry that triggers
  `reconnect_inbox`. Switching to Internal would not lift that behavior
  (Internal apps have their own quirks) and would lock the
  test-users-allowlist escape hatch.

**Every teammate's Gmail address — including Workspace accounts inside
your own org — must be added to the test-users allowlist in step 15 of
the deploy checklist.** Google enforces this regardless of org
membership. Missing addresses fail at consent with "Access blocked:
this app is in testing".

The high-level steps (full details in `docs/deploy.md`):

1. **APIs & Services → Library → Gmail API → Enable.** Required before
   any granted token can actually call Gmail; without this, calls fail
   with 403 `accessNotConfigured` even with valid consent.

2. **Google Auth Platform → Get Started**: External audience type,
   app name + support email.

3. **Google Auth Platform → Data Access**: add the five scopes —
   `openid`, `email`, `gmail.readonly`, `gmail.send`, `gmail.modify`.
   (These match `src/google/scopes.ts`.)

4. **Google Auth Platform → Audience**: leave Publishing status as
   **Testing**. Add every Gmail address any teammate will connect —
   Workspace org accounts included.

5. **Google Auth Platform → Clients → Create client**: Web application,
   authorized redirect URI = `<WORKER_URL>/google/callback`. Save the
   Client ID + secret for §2.5.

### 2.5 Worker secrets

Set each via `wrangler secret put`. The values shown are placeholders;
generate fresh random secrets for each `_KEY` / `_PEPPER` variable.

```sh
# Google OAuth credentials from §2.4.
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# 32-byte AES-256 key for at-rest encryption of stored refresh tokens.
# Generate: openssl rand -base64 32
npx wrangler secret put AES_MASTER_KEY

# 32-byte pepper for HMAC-SHA-256 (team-key hashing + operator-token
# fingerprint). Generate: openssl rand -base64 32
npx wrangler secret put HMAC_PEPPER

# Hex-encoded HMAC-SHA-256 of your operator token under HMAC_PEPPER.
# The OPERATOR_TOKEN itself never goes on the Worker.
# Generate locally, in a shell with HMAC_PEPPER and a freshly-generated
# OPERATOR_TOKEN exported as env vars:
#
#   node -e 'const c=require("node:crypto");const p=Buffer.from(process.env.HMAC_PEPPER,"base64");const t=process.env.OPERATOR_TOKEN;console.log(c.createHmac("sha256",p).update(t).digest("hex"));'
#
# Paste the hex output when wrangler prompts.
npx wrangler secret put OPERATOR_TOKEN_HMAC

# Your worker's external URL, e.g. https://gmail-mcp.your-acct.workers.dev
npx wrangler secret put PUBLIC_BASE_URL
```

### 2.6 Operator dotfile (local — never on the server)

On your operator workstation, write to `~/.gmail-mcp-admin.env` (chmod 600):

```ini
GMAIL_MCP_BASE_URL=https://gmail-mcp.your-acct.workers.dev
OPERATOR_TOKEN=<the raw OPERATOR_TOKEN you HMAC'd in §2.5>
```

The operator CLI reads this file (and refuses `--operator-token` flags so
the token never lands in shell history).

### 2.7 Deploy

```sh
# Dry-run first — validates wrangler.toml and bundles without uploading.
npx wrangler deploy --dry-run --outdir=/tmp/gmcp-dryrun

# Real deploy.
npm run deploy
```

> **If `npm run deploy` appears to hang** with no output after wrangler's
> version-warning banner, it is **not** frozen — wrangler is paused on
> an interactive prompt that doesn't always render clearly (first-deploy
> workers.dev subdomain registration, telemetry opt-in, upgrade nag,
> deploy confirmation — varies). Wait a few seconds, then press `Enter`
> (or `y`) at the prompt. The deploy completes shortly after.
>
> **Security note — do not enable `WRANGLER_LOG=debug` here.** Wrangler's
> debug output writes the Cloudflare OAuth refresh token to stdout in
> plaintext; an earlier workaround that piped that output into
> `deploy.log` leaked the token into a shared log. If debug output is
> ever genuinely needed for troubleshooting, treat the resulting file
> as secret-bearing: never share it, never commit it, and shred it
> (`shred -u <file>`, or platform equivalent) as soon as you're done.

Test:

```sh
curl https://gmail-mcp.your-acct.workers.dev/healthz
# → ok
```

---

## 3. Operator CLI

All five commands talk to the deployed Worker over HTTPS, authenticated by
`OPERATOR_TOKEN`. The CLI **refuses** `--operator-token` flags outright (a
flag value would leak to shell history) — set it in
`~/.gmail-mcp-admin.env` or your environment instead.

### `npm run admin -- provision "Name" --out <path> [--note "..."]`

Creates a new teammate and issues a single team key. With `--out`, the CLI
writes the team key directly to the named file with mode 0600 — no shell
redirection, no chance of npm's run-banner or any other byte contaminating
the file. The file content is wrapped in `--- BEGIN TEAM KEY --- / --- END
TEAM KEY ---` sentinels. The recommended form:

```sh
npm run admin -- provision "Alice" --out alice.key
# Send alice.key to Alice via a secure channel.
# Delete the file once she has it.
```

`--out` refuses to overwrite an existing file by default (exit 5). Pass
`--force` only if you have a deliberate reason to overwrite.

> **Legacy stdout form** (kept for scripts that already depend on it):
> running `provision` *without* `--out` writes the same BEGIN/END-wrapped
> block to stdout. The CLI refuses this path when stdout is an interactive
> terminal (scrollback / history risk) unless you pass `--unsafe-tty`. If
> you redirect stdout to a file, use `npm run --silent admin -- provision
> "Alice" > alice.key` so npm's run-banner doesn't land in the file ahead
> of the key. The `--out` form sidesteps both concerns and is preferred.

### `npm run admin -- list`

Shows all teammates, key fingerprints (not secrets), created/revoked
timestamps. Safe to pipe / log — no key material in the output.

### `npm run admin -- rotate "Name" --out <path>`

Revokes the teammate's current key and issues a fresh one. Same `--out`
file-write semantics as `provision` (mode 0600, refuses to overwrite
without `--force`). Existing MCP grants the teammate already has will keep
working until they're refreshed against the chokepoint — the chokepoint
refuses on the next call because the active key for that teammate is gone.

### `npm run admin -- revoke "Name"`

Marks the teammate's active key revoked. Their MCP bearers stop working
on next use. **Does not** delete their connected Gmail inboxes — those
stay (encrypted) so a later `rotate` brings them back to life. For full
removal use `purge`.

### `npm run admin -- purge "Name"`

Fully removes the teammate:

1. Revokes the active team key.
2. Marks the teammate row revoked.
3. For each connected Gmail inbox, calls Google's `/revoke` endpoint
   with the stored refresh token. **If revoke succeeds → the inbox row
   is deleted. If revoke fails for ANY reason (Google non-200, network
   error, decrypt error), the row stays and the CLI emits a FAIL line
   to stderr naming that inbox.**
4. Deletes the teammate row only if every inbox cleared.

Sample run:

```
$ npm run admin -- purge "Alice"
  ok       work
  FAIL     personal: Inbox 'personal' (alice-personal@example.com): Google returned HTTP 400 on revoke — token may still be live at Google, verify manually.

One or more inboxes could not be revoked at Google. The teammate's team key
is revoked and the bad rows remain — see `inboxes[]` for details. Manually
revoke the listed accounts at https://myaccount.google.com/permissions,
then re-run `admin purge` to clean up.
```

Exit code is **4** on any per-inbox failure. **Don't ignore it.** If you
get FAILs:

1. Open https://myaccount.google.com/permissions in the teammate's Google
   account (or have them open it).
2. Find your app under "Third-party apps with account access" and remove it.
3. Re-run `npm run admin -- purge "Alice"`. The remaining rows will clear.

This is idempotent — running purge multiple times is safe.

### `npm run admin -- clear-block <ip:1.2.3.4 | keyid:ABCDEFGH | op:fingerprint>`

A teammate who fat-fingers their team key 5 times in a minute trips the
per-keyid rate limit. The block self-expires in 1 hour, but the operator
can clear it sooner:

```sh
# Get the keyid from `admin list` (shown as `keyid` for each teammate).
npm run admin -- clear-block keyid:ABCDEFGH
```

Clearing a block **does not** rotate the key. The teammate can re-paste
the same key immediately.

---

## 4. Common operations

### Adding a new teammate

End-to-end, in order:

1. **Provision the key:**
   `npm run admin -- provision "Name" --out name.key`
   (The CLI writes the file itself, mode 0600. Refuses to overwrite an
   existing file unless you pass `--force`.)
2. **Deliver the key securely** to the teammate. See the next section —
   this is the step where people most often slip up. Don't paste the key
   into plain email or persistent chat.
3. **Confirm receipt** — wait until the teammate replies saying they have
   it and have saved it into their password manager. Until then, don't
   move on.
4. **Shred your local copy:**
   `shred -u name.key` (GNU) or `rm -P name.key` (macOS) or `rm` if no
   shred. The file has the plaintext key; once they've got it, it
   shouldn't live on your machine either.
5. **Add their Gmail address(es) to the Google Cloud test-users list.**
   Open Google Cloud Console → Google Auth Platform → **Audience** tab
   → Test users → Add users. Every Gmail address they plan to connect,
   one per line. Workspace addresses included — no exception. Without
   this, their `connect_inbox` flow will fail at Google's consent
   screen with "Access blocked: this app is in testing".

The teammate then follows `docs/teammate.md` from their side.

---

### Delivering a team key to a teammate

The `tk_…` string is the teammate's **complete access**. Whoever holds
it can act as them — read their connected inboxes, send mail from any
of them. Treat it like a password: don't leave it sitting in a place
where it could be looked up later.

The real risk isn't the act of sending — it's the key persisting
somewhere logged or searchable. A team-key copy sitting in an email
thread, a Slack DM, or an SMS history is a problem because that record
sticks around and can be searched (by whoever has access to that
mailbox / workspace / phone) months later. The fix is to deliver via a
channel that either doesn't keep the key around, or where you can
remove it after the teammate has it.

You don't need fancy tooling for this. Pick one of the three options
below — the first is the recommended default.

#### Recommended: a one-time-secret link

Use a service like **onetimesecret.com** (or any equivalent —
self-hosted PrivateBin, the secret-sharing feature in your password
manager, etc.). These services let you paste a secret and get back a
URL that destroys itself the first time someone opens it.

Step by step:

1. Open the service in a browser (e.g. https://onetimesecret.com).
2. Paste **only** the team key (the `tk_…` line) into the secret
   field. **Do not** paste the teammate's name, your team name, the
   server URL, or anything else identifying alongside it. The link is
   short-lived, but if the service is ever compromised you want a
   leaked secret to mean "some random base32 string" rather than
   "Alice's key to the gmail-mcp server at your-acct.workers.dev".
3. Click **Create secret** (or equivalent).
4. Copy the resulting URL — it'll look like
   `https://onetimesecret.com/secret/abc123...`.
5. Send that URL to the teammate over whatever channel you normally
   use (Slack, email, SMS — at this point it doesn't matter, the URL
   itself is single-use and the secret leaves the service the moment
   it's read).
6. Tell them what's behind the link — "this is your team key for the
   Gmail assistant; open it once, copy the contents into your
   password manager immediately, don't leave it sitting in the chat."

Pick a reputable service. **One-time-secret links work because the
secret leaves the service once it's been read — re-loading the URL
shows nothing.** If the teammate sees a "secret has already been
viewed" page when they click, somebody else opened it first; treat
the key as compromised and rotate (see *If something goes wrong*
below).

#### Alternative: a password-manager secure-share link

If both you and the teammate already use the same password manager
**and** it has a secure-share feature, this is the cleanest path:

- **1Password**: select the item → ⋯ menu → **Share** → set "Expires
  after" to 1 day and "Available to" to 1 view → send the resulting
  link.
- **Bitwarden**: **Send** feature → text type → paste the key → set
  expiration to 1 day and "Maximum access count" to 1 → send the link.

Same one-time-view, self-destructing model as onetimesecret.com — just
hosted by the password manager you (and ideally the teammate) already
trust.

#### Alternative: split the key across two channels

If neither of the above fits — the teammate isn't on a password
manager and you don't want them clicking external links — read the key
to them over a voice call (phone, Signal call, etc.) while they type
it directly into their password manager. The key never lives in a
written-down form on either side.

This is the most teammate-friendly option for completely
non-technical people, at the cost of being a 60-second phone call.

#### What to avoid, and why

- **Plain email** — sits in your Sent folder and their Inbox forever,
  searchable by anyone who later gains access to either mailbox.
- **Persistent chat (Slack DMs, Discord, etc.)** — same problem. The
  team's Slack admin, anyone who later joins as an admin, anyone the
  account is shared with, or anyone who exports the channel can find
  it.
- **SMS** — phone backups archive it; carriers may log it.

The pattern: **don't put the key anywhere it'll live in a permanent,
searchable record.** If you must use a channel like this, deliver only
the one-time-secret URL (which is useless after it's been read) — not
the key itself.

#### After the teammate confirms they have it

Tell them, in this order:

1. "Save the key directly into your password manager (1Password,
   Bitwarden, browser password manager — whatever you use). Name the
   entry something like 'Team Gmail Assistant team key'."
2. "Delete the message / close the one-time-secret tab. Don't leave
   the key in the delivery channel."

Once they confirm, on your side:

```sh
shred -u name.key      # GNU; or `rm -P name.key` on macOS; or `rm` if no shred
```

And then add the teammate's Gmail address(es) to the Google Cloud
test-users list (the step in §2.4 / deploy.md step 15). Without that,
their first `connect_inbox` attempt will fail at Google.

#### If something goes wrong

Mishandling a key is not a crisis. If any of the following happens:

- You sent the key to the wrong person.
- The teammate accidentally pasted it into the wrong window or chat.
- The one-time-secret link page showed "already viewed" when the
  teammate clicked it (meaning someone else read it first).
- The teammate's laptop got stolen with the key still on it.
- You just have a bad feeling about how the delivery went.

Run:

```sh
npm run admin -- rotate "Name" --out name.key
```

This **immediately invalidates the old key** — anyone who has it,
including the right teammate, can no longer use it. It issues a fresh
key for the same teammate; deliver the new one through the steps
above. Other teammates are unaffected — `rotate` only touches the
named teammate's key.

Don't agonize over a delivery slip. The recovery is one command and
takes 30 seconds. The thing to actually avoid is shipping a key
through a channel that **persists** and never rotating it — that's
when an old leaked key turns into a real problem.

---

### A teammate lost their team key / it leaked

```sh
npm run admin -- rotate "Name" --out name.key
```

Send the new key, delete the file. The old key is immediately dead.

### A teammate left the team

```sh
npm run admin -- purge "Name"
```

Verify every line says `ok`. If any says `FAIL`, follow the
`myaccount.google.com/permissions` procedure under §3's `purge` section.

### A teammate is locked out

If they tell you "the assistant says my sign-in is failing":

```sh
# Identify their keyid:
npm run admin -- list

# Clear the rate-limit block:
npm run admin -- clear-block keyid:<their keyid>
```

If clearing doesn't help, `rotate` and re-send the key.

---

## 5. Troubleshooting

### `wrangler deploy` fails with "Dynamic require of …data.json"

Re-run `npm install` to re-apply the `ajv` patch via `postinstall`.

If the patch fails to apply (e.g. you bumped `ajv`):

```sh
node scripts/inline_ajv_json_requires.mjs
npx patch-package ajv
git add patches/
```

### A teammate's connect_inbox flow fails at Google with "Access blocked: this app is in testing"

You forgot to add their Gmail address to the test-users allowlist
(deploy checklist step 15 / §2.4). Add it — including Workspace
addresses, no exception for "my own org". Have them retry.

### A teammate's Gmail call fails with `accessNotConfigured` (HTTP 403)

The Gmail API isn't enabled for your Google Cloud project (deploy
checklist step 12). Open the project → APIs & Services → Library →
search "Gmail API" → Enable. Existing teammate consents are unaffected
— calls just start working once the API is on.

### A teammate sees the "Google hasn't verified this app" warning

That's expected in External + Testing mode. `docs/teammate.md` walks them
through clicking past it.

### A teammate suddenly can't reach an inbox; the assistant says "reconnect this inbox"

Also expected — External + Testing refresh tokens expire after ~7 days
of inactivity. They run `reconnect_inbox <nickname>` in the assistant
and click the new sign-in link. No operator action needed.

### Looking at live Worker logs

```sh
# Standard tail — request lines + Worker console output:
npx wrangler tail
```

`wrangler tail` does not take a `--log-level` flag in wrangler 3.114.
Verbosity is controlled by the `WRANGLER_LOG` env var, but **we
deliberately do not recommend `WRANGLER_LOG=debug`** as a routine
troubleshooting tool: wrangler's debug stream prints the Cloudflare
OAuth refresh token in plaintext (one such log was inadvertently
shared in the past, which is what prompted this warning). If you
ever do need debug output to diagnose a wrangler-client issue,
treat the session as secret-bearing — keep it on-screen only, do
not redirect to a file, do not paste it into chat or tickets, and
clear the scrollback when done.
