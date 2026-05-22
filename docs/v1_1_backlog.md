# v1.1 backlog

Things deliberately deferred past v1.0. These are tracked here — not as
code comments — so they don't drift indefinitely. Each item below is real
work with a real reason it didn't ship in v1.0 and a concrete shape for
what v1.1 should do.

Order is rough priority, top first.

---

## 1. AES master-key rotation

**Why it's not in v1.0**: a single 32-byte `AES_MASTER_KEY` in Worker
Secrets encrypts every stored Gmail refresh token. v1.0 has no path to
rotate it.

**Why it matters**: this key has the highest blast radius of any secret
in the system. Industry hygiene is to rotate it on a schedule (annually
at least) and after any incident that might have exposed Worker Secrets.
Today we can't, without writing a one-off migration script and risking
a window of failures.

**Shape for v1.1**:

- Store a `key_version` integer alongside each ciphertext column in the
  `inboxes` table (migration 0002). Default existing rows to version 1.
- Worker Secrets get a versioned map: `AES_MASTER_KEY_V1`,
  `AES_MASTER_KEY_V2`, etc. The Env reader picks the right key by the
  row's `key_version` for decrypt; new writes always use the current
  version.
- `bin/admin.ts -- rotate-master-key` command: streams every inbox row,
  decrypts with the old key, re-encrypts with the new key, updates
  `key_version`. Idempotent; can be interrupted and resumed.
- Operator runbook entry for "annual rotation" + an "after incident"
  variant.

**Acceptance**:
- Old ciphertext still decrypts after rotation.
- New ciphertext fails decrypt under the old key (negative test).
- Re-running `rotate-master-key` after completion is a no-op.
- The runbook captures a clean rotation against a 4-teammate, 10-inbox
  deploy.

**Estimate**: ~1 day. Localized to `src/db/inboxes.ts`, `src/crypto/aead.ts`,
`bin/admin.ts`, and one migration.

---

## 2. Dev-dependency vulnerability bumps (vitest-pool-workers ≥ 0.16)

**Why it's not in v1.0**: `npm audit` at v1.0 sign-off shows 11 advisories
(7 moderate, 4 high) across `vitest`, `vite`, `esbuild`, `wrangler`,
`miniflare`, `undici`, `ws`, and `devalue`. **All 11 are dev-only deps**
— pulled in via `@cloudflare/vitest-pool-workers` for the integration
test pool. `npm audit --omit=dev` returns **0 vulnerabilities**: the
deployed Worker bundle contains none of them.

**Why it matters anyway**: a developer running the test suite on a
machine with an attacker-controllable network (compromised dev VPN,
hostile cafe wifi) is in scope for some of these (esbuild dev-server
CORS abuse, undici HTTP-smuggling against the local miniflare upstream).
Two-pool CI runs in particular execute the workers pool, which
instantiates miniflare → workerd-via-vite-via-esbuild.

**Why this is deferred**: `npm audit fix --force` bumps
`@cloudflare/vitest-pool-workers` from 0.5.x to 0.16.x, which is a
breaking change. The 0.16 line likely requires Wrangler 4 to be useful,
making this a natural co-traveler with backlog item 3 below.

**Shape for v1.1**:

- Bump `@cloudflare/vitest-pool-workers` to ≥ 0.16 in `package.json`.
- Run `npm install`, re-run both test pools.
- If miniflare/wrangler version coupling forces wrangler 4, fold this
  into backlog item 3 and do both at once.
- After: `npm audit` should show 0 advisories across all scopes.

**Acceptance**:
- `npm audit` clean.
- Both test pools green (currently 142 node + 7 workers).
- The runbook end-to-end check still passes.

**Estimate**: ~half a day on its own; bundles with Wrangler 4 upgrade.

---

## 3. Wrangler 3 → 4 upgrade

**Why it's not in v1.0**: pinned at 3.114.17 in `package.json` to avoid
syntax / deploy-behavior surprises mid-build. Documented as a deliberate
post-v1.0 step.

**Why it matters**: Wrangler 4 is the supported line. Staying on 3 means
no new bundler features, no security fixes after Cloudflare's EOL date
(whenever that lands), and progressively more "out of date" warnings
during deploy.

**Shape for v1.1**:

- Bump `package.json`: `"wrangler": "4.x.y"` (latest stable at the time).
- Re-read the wrangler 4 migration guide — particularly the
  `wrangler.toml` syntax changes around bindings.
- Run `npm install`, fix any `wrangler.toml` warnings, re-run
  `wrangler deploy --dry-run`. Confirm the binding list is identical
  (KV: OAUTH_KV, D1: DB).
- Re-run the full automated suite (node + workers pools) — vitest-pool-workers
  may have its own version coupling.
- Walk `docs/runbook.md` end-to-end against a staging deploy before
  rolling to production.

**Acceptance**:
- All 129 tests still green.
- `wrangler deploy --dry-run` shows exactly the same two bindings.
- Runbook signed off.

**Estimate**: ~half a day if no surprises. README's "Toolchain pinned"
section gets a new version number.

---

## 4. Operator-side audit log persistence

**Why it's not in v1.0**: all logs flow through `src/util/log.ts` (which
scrubs secrets) and end up in Cloudflare Workers Observability. That's
retained per Cloudflare's stock policy — usually days, not months.

**Why it matters**: when investigating "did anyone act on Alice's inbox
last quarter?" the operator wants a queryable record that survives the
default Worker log retention window.

**Shape for v1.1**:

- A small `audit_events` D1 table keyed by `(timestamp, teammate_id,
  event, detail)`. Schema migration 0003.
- A `log.audit()` call that writes to both `console.log` (for
  short-term Observability) AND the audit table (for long-term query).
- Targeted call sites: `admin.provision`, `admin.rotate`, `admin.revoke`,
  `admin.purge`, `oauth.granted`, `inbox.connected`, `inbox.reconnected`,
  `inbox.reconnect_account_mismatch`, `mail.sent`. (Read events stay
  out — too high-volume; pull from Observability when needed.)
- A new `npm run admin -- audit [--since 7d] [--teammate "Name"]` query
  command that prints the table in human-friendly form.
- Operator doc entry on retention policy + how to export/archive the
  table (D1 → R2 dump on a cron, if anyone wants longer than D1's free
  tier holds).

**Acceptance**:
- Every operator-side state change writes an audit row.
- The `admin audit` query works with filters.
- A test confirms no secret material (tokens, team keys) ever reaches
  the audit table.

**Estimate**: ~1 day.

---

## Lower-priority items, flagged for awareness

- **Pepper rotation.** Current `HMAC_PEPPER` is a single value in Worker
  Secrets; rotating it invalidates every issued team key (operator must
  rotate all teammates). Acceptable for v1.0 but a v1.1 nicety would be
  a dual-pepper window during rollover.
- **Per-teammate Durable Object isolation.** v1.0 enforces isolation via
  the chokepoint + `WHERE teammate_id = ?` queries (proven by the
  isolation suite). If team size grows past ~20, moving each teammate's
  Gmail state into its own DO would harden the model further. Not needed
  at v1.0 scale.
- **Streamable HTTP resumability (`EventStore`).** The SDK supports
  resumable streams; v1.0 doesn't enable it (`enableJsonResponse: true`,
  no event store). If long-running tool calls become a thing, an R2- or
  D1-backed event store could be added without touching the chokepoint.
- **Telemetry beyond Workers Observability.** A small set of counters
  (provision rate, revoke rate, reconnect rate, search_all p95) shipped
  to Cloudflare Analytics Engine would be useful for capacity planning.
- **Test coverage parity (audit-review follow-up).** Two assertions
  the audit-review pass flagged as nice-to-have:
    1. A direct test that `OAuthProvider`'s `onError` callback routes
       through `log.warn` and gets the scrubber treatment. Currently
       the routing is wired in `src/index.ts` and the scrubber is
       independently tested in `test/log_scrub.test.ts`, but no test
       exercises the actual library-onError → log.warn → scrubber
       path end-to-end. Build it by driving the library into an
       error response (e.g. malformed `/oauth/token` body) and
       asserting the scrubbed line lands in a stubbed console.warn.
    2. An HSTS assertion on the `/google/callback` result page.
       `test/oauth_authorize.test.ts` already asserts `Strict-
       Transport-Security: max-age=…` on the team-key page; the
       callback page sets the same header but no test currently
       checks it. One-liner extension to the existing callback test.
  Both are low-impact (the fixes are landed; only the tests are
  missing), and neither blocks v1.0 — the code paths are covered by
  the existing scrubber unit tests and the existing authorize-page
  header test respectively.
- **`approximate_total` on `search_all` (reviewer suggestion).** When
  multiple inboxes contribute to a cross-inbox search, the per-inbox
  Gmail responses each carry a `resultSizeEstimate` field. The current
  `search_all` returns `result_count` (number of hits actually
  returned after shaping) and `inbox_count`, but doesn't surface the
  sum of per-inbox `resultSizeEstimate` values. Adding it would let
  the assistant phrase things like "I see 24 results across your 3
  inboxes (showing the most recent 10)" instead of just "showing 10".
  Scope: per-inbox `approximate_total` field on each `inboxes[]` entry,
  plus a top-level `approximate_total` summing across `ok` inboxes.
  Trivial — `listMessages` already returns the field; just propagate.
- **Pagination + configurable result cap on search tools (reviewer
  suggestion).** `search_one`, `list_messages`, and `search_all` cap at
  `SEARCH_MAX` / `MAX_TOTAL_HITS` (currently 25 per inbox, 40 total).
  No way for a teammate to ask "show me 50" or "show me the next page."
  Shape: add `page_token` to inputs (echo the Gmail `nextPageToken` we
  already capture in `next_page_token` on the response) and let
  `max_results` go up to a higher hard ceiling (proposed: 100 per
  inbox / 200 total across `search_all`, with the same proportional
  trim algorithm). The 1MB response budget shaping in `cross_inbox.ts`
  stays as the actual safety net — pagination just gives the teammate
  more control. Acceptance: round-trip `next_page_token` works against
  real Gmail.

---

## What v1.1 explicitly does NOT change

- The two-gate identity model (team key + Google OAuth). It's the right
  shape for this scope.
- The hand-rolled Streamable HTTP MCP transport. We pivoted to it
  deliberately; the reasoning lives in the header comment of
  `src/mcp/transport.ts`.
- The "no `teammate_id` parameter on any tool" invariant. The boot-time
  `FORBIDDEN_INPUT_KEYS` guard stays.
- The fail-loud purge contract.
