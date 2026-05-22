# Deploy checklist — single ordered sequence

Run this top to bottom. Don't skip ahead — later steps depend on values
from earlier ones. Total time: ~30 minutes the first time, ~10 minutes
the second.

This collapses what's spread across `docs/operator.md` §2.x and the
runbook — it is the only page you need open while deploying.

## Pre-flight (one-time, not per deploy)

- [ ] **Node 22+** installed locally (`node --version`).
- [ ] **Cloudflare account** on Workers Free or higher.
- [ ] **Google Cloud project** you can admin (or ability to create one).
- [ ] `cd <project root>` — every command below runs from there.

---

## The checklist

```
PHASE 1 — local setup
```

### 1. Install dependencies (this also applies the permanent ajv patch)

```sh
npm install
```

Confirm the `postinstall` log line `Applied patches/ajv+8.20.0.patch`.
If it errors, see `docs/operator.md` §5.

### 2. Create your local `wrangler.toml` from the committed template

```sh
cp wrangler.toml.example wrangler.toml
```

**Read this once and remember it:**

- **`wrangler.toml.example`** is the template committed to git. It has
  `REPLACE_WITH_D1_ID` / `REPLACE_WITH_OAUTH_KV_ID` placeholders and is
  what you read on GitHub.
- **`wrangler.toml`** is *your* operator-local config. It's listed in
  `.gitignore`, so `git status` will never show it and you cannot
  accidentally commit your real Cloudflare resource IDs. Every operator
  on every machine maintains their own `wrangler.toml`.

Every later step that says **"edit `wrangler.toml`"** means *this
file* — the copy you just made, not the template. Don't edit
`wrangler.toml.example`; that file stays as-is so a fresh clone
always has a clean starting point.

### 3. Sign in to Cloudflare from the CLI

```sh
npx wrangler login
```

Opens a browser. Authorize the CLI.

### 4. Record your account info (for your records)

```sh
npx wrangler whoami
```

Save into a scratch `notes.txt` (you'll delete it at the end):

```
ACCOUNT_EMAIL = <from output>
ACCOUNT_ID    = <from output>
```

```
PHASE 2 — Cloudflare resources
```

### 5. Create the D1 database

```sh
npx wrangler d1 create gmail-mcp
```

The output ends with a copy-pasteable block:

```
[[d1_databases]]
binding = "DB"
database_name = "gmail-mcp"
database_id = "12345678-aaaa-bbbb-cccc-deadbeef9999"
```

**Edit `wrangler.toml`**: in the existing `[[d1_databases]]` block,
replace `REPLACE_WITH_D1_ID` with the `database_id` shown above.

> The `binding = "DB"` line is intentional and stays as-is — `DB` is the
> name the Worker code uses to access the database (`env.DB`). The
> `database_name = "gmail-mcp"` is the human-readable name in your
> Cloudflare account. They serve different purposes; both are correct.
> (Step 7 below passes `DB` to `migrations apply` because that's the
> binding wrangler looks up to find the `database_id` you just pasted.)

### 6. Create the KV namespace

```sh
npx wrangler kv namespace create OAUTH_KV
```

Output:

```
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "abcdef0123456789..."
```

**Edit `wrangler.toml`**: replace `REPLACE_WITH_OAUTH_KV_ID` with that
`id`.

### 7. Apply the D1 migrations to the remote database

```sh
npx wrangler d1 migrations apply DB --remote
```

Reports `Applied 1 migration`. Creates `teammates`, `team_keys`,
`inboxes`, `oauth_states`, `ratelimit`.

```
PHASE 3 — first deploy (the Worker URL comes alive here)
```

> **Why deploy before setting secrets**: wrangler refuses
> `wrangler secret put` against a Worker that hasn't been deployed yet
> (verified in the wrangler source: "the latest version of your Worker
> isn't currently deployed. Please ensure that the latest version of
> your Worker is fully deployed before modifying secrets"). And we can't
> register the Google redirect URI without a live URL anyway. So we
> deploy with bindings in place but no secrets — the Worker boots fine
> (it doesn't read secrets at module load); only authenticated routes
> would fail at runtime, and we don't hit those yet.

### 8. First deploy

```sh
npm run deploy
```

> **If this appears to hang with no output after the version warning,
> it is NOT frozen** — wrangler is paused on an interactive prompt
> that doesn't always render clearly in some terminals (first-deploy
> workers.dev subdomain registration, telemetry opt-in, upgrade nag,
> deploy confirmation — varies). Wait a few seconds, then press
> `Enter` (or `y`) at the prompt. The deploy completes in a few
> seconds after that.
>
> **Do not enable `WRANGLER_LOG=debug` to "see what's happening."**
> Wrangler's debug output writes the Cloudflare OAuth refresh token
> in plaintext to stdout. Piping that into a file or a shared
> terminal has leaked credentials in the past. If a debug log is
> ever genuinely needed for troubleshooting, treat it as
> secret-bearing — never share it, never commit it, and shred the
> file (`shred -u`, or equivalent) as soon as you're done.

Wrangler bundles, uploads, and prints the live URL near the end of its
output. Look for a line like:

```
Uploaded gmail-multi-account-mcp (X.Y sec)
Deployed gmail-multi-account-mcp triggers (X.Y sec)
  https://gmail-multi-account-mcp.<your-subdomain>.workers.dev
```

**Export it into the current shell** — every later step uses `$WORKER_URL`:

```sh
export WORKER_URL="https://gmail-multi-account-mcp.<your-subdomain>.workers.dev"
```

(Copy from the wrangler output. Also save it to `notes.txt` for Google
Cloud Console paste-ins in steps 13/14.)

### 9. Verify the Worker is live (only `/healthz`; authenticated paths come later)

```sh
curl "$WORKER_URL/healthz"
# Expected: ok
```

If `/healthz` returns `ok`, the URL is live and the bindings (D1, KV)
work. You can now register this URL in Google.

```
PHASE 4 — generate secrets locally (none go in shell history beyond
the generate command)
```

### 10. Generate the three random secrets + the operator token

```sh
openssl rand -base64 32      # → AES_MASTER_KEY value
openssl rand -base64 32      # → HMAC_PEPPER value
openssl rand -base64 48      # → OPERATOR_TOKEN value (raw — never goes on the Worker)
```

Save each into `notes.txt`:

```
AES_MASTER_KEY  = <first output>
HMAC_PEPPER     = <second output>
OPERATOR_TOKEN  = <third output>
```

### 11. Compute `OPERATOR_TOKEN_HMAC` locally

This is what the Worker stores. The raw `OPERATOR_TOKEN` itself never
goes on the Worker — only its HMAC under the pepper.

```sh
HMAC_PEPPER="<paste>" OPERATOR_TOKEN="<paste>" node -e '
  const c=require("node:crypto");
  const p=Buffer.from(process.env.HMAC_PEPPER,"base64");
  console.log(c.createHmac("sha256",p).update(process.env.OPERATOR_TOKEN).digest("hex"));
'
```

Save the 64-character hex output as `OPERATOR_TOKEN_HMAC`.

```
PHASE 5 — Google Cloud Console (using the live WORKER_URL from step 8)
```

> **UI note**: Google rolled the legacy "APIs & Services → OAuth consent
> screen / Credentials" pages into a tabbed product called **Google Auth
> Platform**. The path below describes the current UI as of mid-2026; if
> Google moves things again, the conceptual steps are the same:
> enable the Gmail API, set up the consent screen, add test users,
> create OAuth client credentials with our `/google/callback` redirect URI.

### 12. Enable the Gmail API for this project

The Gmail API must be explicitly enabled before any OAuth token can
actually call it — even after consent is granted, calls fail with a 403
`accessNotConfigured` if the API isn't on.

1. https://console.cloud.google.com → top-left project picker → select
   the project you're configuring.
2. Top-left hamburger menu → **APIs & Services → Library**.
3. Search for **Gmail API** → click the result → click **Enable**.
4. Wait until the page reloads with "API enabled". (Usually a few
   seconds.)

### 13. Open Google Auth Platform → Get Started

Top-left hamburger menu → **Google Auth Platform**. (If you've never
configured an auth client in this project, it lands on **Get Started**.
If you have, jump to the **Audience** or **Clients** tab directly via
the left sidebar.)

1. **Get Started** tab:
   - **App name**: anything ("Team Gmail Assistant" is fine).
   - **User support email**: yours.
   - **Audience type**: **External**.
   - **Developer contact email**: yours.
   - Click **Save and Continue** through any remaining onboarding panes.
     This creates the auth-platform configuration; it does NOT yet
     publish anything.

### 14. Data Access — add the Gmail scopes

Left sidebar → **Data Access**.

Click **Add or Remove Scopes** and add all five:

- `openid`
- `email`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.modify`

Save. The page should show all five in the "Your sensitive scopes" /
"Your non-sensitive scopes" tables (the Gmail ones are sensitive).

### 15. Audience — leave in Testing + add every teammate Gmail address

Left sidebar → **Audience**.

- **Publishing status**: leave as **Testing**. (This server is designed
  around test-mode behavior — the ~7-day refresh-token expiry that
  `reconnect_inbox` handles.)
- Scroll to **Test users** → click **Add users**.
- **Add every Gmail address any teammate will ever connect**, one
  address per line, including yourself. Each address has to be on this
  list **before** that teammate's `connect_inbox` flow runs against it,
  or Google refuses consent with "Access blocked: this app is in
  testing". Up to 100 addresses total.
- Save.

### 16. Clients — create the OAuth web-client credentials

Left sidebar → **Clients** → **Create client**.

- **Application type**: **Web application**.
- **Name**: anything (e.g. "Team Gmail Assistant Worker").
- **Authorized JavaScript origins**: leave empty.
- **Authorized redirect URIs** → **Add URI**:
  - Paste: **`$WORKER_URL/google/callback`** (substitute the actual
    URL — Google's UI doesn't expand env vars).
- Click **Create**.

A modal appears showing the credentials. Save:

```
GOOGLE_CLIENT_ID     = <from modal>
GOOGLE_CLIENT_SECRET = <from modal>
```

```
PHASE 6 — set Worker secrets (each silently redeploys)
```

### 17. Set every Worker secret (six commands — that's the full list)

Each command prompts you to paste the value. Paste from your scratch
notes and press Enter.

```sh
npx wrangler secret put GOOGLE_CLIENT_ID         # paste step 16 GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET     # paste step 16 GOOGLE_CLIENT_SECRET
npx wrangler secret put AES_MASTER_KEY           # paste step 10 AES_MASTER_KEY
npx wrangler secret put HMAC_PEPPER              # paste step 10 HMAC_PEPPER
npx wrangler secret put OPERATOR_TOKEN_HMAC      # paste step 11
npx wrangler secret put PUBLIC_BASE_URL          # paste $WORKER_URL from step 8
```

> **There is no `OAUTH_PROVIDER_SIGNING_KEY` secret.** Earlier drafts
> of `wrangler.toml` had it in the comments — that was speculative,
> from when the design hadn't been pinned to the
> `@cloudflare/workers-oauth-provider` library. **The library doesn't
> take a signing-key env var.** It derives the props-encryption key
> for every issued bearer by HMAC-ing the token string itself with a
> constant `WRAPPING_KEY_HMAC_KEY` baked into the library source. The
> security property — "you can't decrypt a grant's props without the
> secret half of the bearer that issued the grant" — is the same one
> the isolation suite's scenario 3 exercises. Six secrets is correct
> and complete.

Each `secret put` deploys a new Worker version automatically. After
the sixth one finishes, secrets are live.

```
PHASE 7 — verify the now-fully-configured Worker
```

### 18. Verify `/mcp` is gated by the OAuth library

```sh
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$WORKER_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# Expected: 401
```

A `401` means the OAuth library is loaded and refusing unauthenticated
calls — the bare minimum proof the apiHandler is wired up.

```
PHASE 8 — provision yourself
```

### 19. Write the operator dotfile (local — never on the Worker)

```sh
cat > "$HOME/.gmail-mcp-admin.env" <<EOF
GMAIL_MCP_BASE_URL=$WORKER_URL
OPERATOR_TOKEN=<paste raw OPERATOR_TOKEN from step 10>
EOF
chmod 600 "$HOME/.gmail-mcp-admin.env"
```

(The CLI refuses an `--operator-token` flag; the dotfile or
`OPERATOR_TOKEN` env var are the only accepted paths.)

### 20. Provision your first teammate (yourself!)

```sh
npm run admin -- provision "YourName" --out yourname.key
```

The CLI writes `yourname.key` itself with mode 0600. No shell
redirection involved, so npm's `> name@version admin` run-banner
can't contaminate the file. The file contains only the CLI's own
`--- BEGIN TEAM KEY --- / ... / --- END TEAM KEY ---` block. The
command refuses to overwrite an existing file (exit 5) unless you
pass `--force`.

Copy the `tk_…` line from `yourname.key` into your password manager.
Delete the file:

```sh
shred -u yourname.key    # GNU; or `rm -P yourname.key` on macOS; or `rm`
```

### 21. Clean up local scratch state

- Delete `notes.txt` — still has plaintext `OPERATOR_TOKEN`,
  `AES_MASTER_KEY`, `HMAC_PEPPER`.
- Close and reopen your terminal so the `openssl rand` outputs from
  step 10 leave scrollback.
- `$HOME/.gmail-mcp-admin.env` is the only place `OPERATOR_TOKEN`
  should exist locally now.

### 22. Connect your assistant

In Claude.ai (or Claude desktop / mobile):

1. Add a custom MCP connector with URL **`$WORKER_URL/mcp`**.
2. On the **"Paste your team key"** page, paste the team key from
   your password manager.
3. Click Continue → you should land back in Claude with the connector
   added.

### 23. Walk `docs/runbook.md` top to bottom against the live deploy

That's the live verification the automated suite can't do. Sign and
date the bottom of `runbook.md` when it's all green.

---

## When something goes wrong

| Symptom | Step | Fix |
|---|---|---|
| `npm install` fails on patch-package | 1 | The `ajv` version may have changed. Run `node scripts/inline_ajv_json_requires.mjs && npx patch-package ajv`, then re-`npm install`. |
| `cp wrangler.toml.example wrangler.toml` fails ("No such file") | 2 | You're not at the project root. `cd` into the cloned repo first. |
| `git status` keeps showing your `wrangler.toml` with real IDs | 2 | Confirm `wrangler.toml` is in `.gitignore` and that `git ls-files wrangler.toml` returns nothing. If it's still tracked, run `git rm --cached wrangler.toml`. |
| `wrangler whoami` fails | 3-4 | Re-run `npx wrangler login`. |
| `d1 create` says "already exists" | 5 | Fine if you previously created `gmail-mcp`. Run `npx wrangler d1 list` to find the existing id and paste that. |
| `migrations apply` complains about missing DB | 7 | Re-check the `database_id` you pasted in step 5 against `wrangler d1 list`. |
| Deploy uploads but logs `Error: Dynamic require of "...json"` at runtime | 8 | Step 1 didn't apply the ajv patch. Run `npm install` again; confirm `patches/ajv+8.20.0.patch` exists. |
| `npm run deploy` / `wrangler deploy` produces no output after the version warning and appears stuck | 8 | Wrangler is paused on an interactive prompt that didn't render (first-deploy subdomain registration, telemetry opt-in, deploy confirmation — varies). Wait briefly, then press `Enter` (or `y`) — it is waiting, not frozen. **Do not** enable `WRANGLER_LOG=debug` to debug this: wrangler debug output prints the Cloudflare OAuth refresh token in plaintext. |
| `/healthz` returns 502/500 | 9 | Tail the Worker for the real error: `npx wrangler tail`. Should be very rare at this stage — no secrets are read by `/healthz`. |
| `wrangler secret put` errors with "latest version isn't deployed" | 17 | You skipped step 8's first deploy. Run `npm run deploy`, then re-try the secret put. |
| Teammate's Gmail call fails with `accessNotConfigured` / 403 | 12 / runbook | You skipped step 12 (Enable Gmail API). Open the project, search Gmail API in the Library, click Enable. |
| `/mcp` returns 503 instead of 401 | 18 | The transport stub is somehow active. Confirm `src/mcp/transport.ts` contains the real Streamable HTTP transport (`buildServer` + `WebStandardStreamableHTTPServerTransport`), not the placeholder. |
| `admin provision` returns `invalid_request` | 20 | `OPERATOR_TOKEN_HMAC` on the Worker doesn't match the `OPERATOR_TOKEN` in your dotfile. Re-run step 11 to recompute, then re-do step 17 for that secret only. |
| Teammate sees "Access blocked: this app is in testing" | 23 / runbook | Their Gmail address isn't in the test-users list from step 15. Add it; have them retry. |

---

## Re-deploys (after the first one)

Subsequent deploys are just:

```sh
npm install              # if you pulled changes
npm test                 # quick sanity
npm run deploy
```

> **Same hang caveat as step 8 above.** If `npm run deploy` produces
> no output after wrangler's version-warning banner, it's paused on
> an interactive confirmation prompt that didn't render. Wait a few
> seconds, then press `Enter` (or `y`) — it is waiting, not frozen.
>
> Do **not** enable `WRANGLER_LOG=debug` to investigate: wrangler's
> debug output prints the Cloudflare OAuth refresh token in
> plaintext (this leaked into a shared log once already). If debug
> output is ever truly needed, treat the file as secret-bearing —
> don't share, don't commit, and shred it after use.

No need to re-run the resource-creation or secret-setting steps unless
you're rotating a secret or moving accounts.
