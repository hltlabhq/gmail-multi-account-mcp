# gmail-multi-account-mcp

A hosted Gmail MCP server that lets a small, fixed team operate **multiple
Gmail inboxes per teammate** through an AI assistant (Claude.ai or similar).
Built end-to-end on Cloudflare's free tier — Workers + D1 + KV — with
per-teammate isolation enforced server-side and the MCP transport
hand-rolled against the Model Context Protocol SDK.

> **Why this exists.** The default Gmail MCP connector binds an assistant to
> a single Google account. Anyone who runs their work across several inboxes
> (personal + work, plus a shared alerts account, plus a side project)
> can't get a complete answer to "did anything important arrive today?"
> without checking each inbox by hand. This server fixes that — one
> assistant, *N* inboxes per teammate, results labeled by inbox, sending
> always explicit about which account it goes from.

This is a **portfolio / reference implementation** of a real product, not a
managed service. Code, design docs, tests, and the security audit history
are all in this repo so you can read the whole thing.

---

## What's in here

| Path | What it is |
|---|---|
| [docs/proposal_v1.md](docs/proposal_v1.md) | Approved technical design — two-gate identity, data model, hardening, isolation contract |
| [docs/spec_v1.md](docs/spec_v1.md) | Original behavior specification — the specification-first prompt that scoped the build (kept as a record of process) |
| [docs/deploy.md](docs/deploy.md) | Operator deploy checklist — start here if you want to stand one up |
| [docs/operator.md](docs/operator.md) | Operator setup, admin CLI reference, common operations, isolation guarantees |
| [docs/teammate.md](docs/teammate.md) | One-page guide for a non-technical teammate connecting their first inbox |
| [docs/runbook.md](docs/runbook.md) | End-to-end manual runbook the operator walks against a live deploy |
| [docs/v1_1_backlog.md](docs/v1_1_backlog.md) | Deferred work tracked explicitly so it doesn't drift |
| [src/](src/) | The Worker source |
| [test/](test/) | Unit and integration suites (workerd-pool integration tests for the hard parts) |
| [bin/admin.ts](bin/admin.ts) | Operator CLI for provision / list / rotate / revoke / purge / clear-block |
| [patches/](patches/) | One `patch-package` patch against `ajv` for workerd compatibility |

---

## Architecture in one screen

### Two-gate identity

Two independent credentials gate the system:

1. **Gate 1 — Team key.** The operator runs `admin provision "Name"` and
   gets a high-entropy team key. The teammate pastes it **once** on the
   MCP authorize page; the assistant then holds a per-teammate MCP refresh
   token. The DB stores only `HMAC(pepper, secret)` — a DB read alone
   cannot impersonate anyone. Rotate, revoke, and purge are operator-side
   admin commands with uniform error responses and self-expiring rate
   limits. (See [docs/proposal_v1.md §3](docs/proposal_v1.md) and
   [docs/operator.md §3](docs/operator.md).)
2. **Gate 2 — Google OAuth.** Once a teammate is past Gate 1, they connect
   each Gmail inbox via standard "Sign in with Google." The Worker stores
   the refresh token encrypted at rest (AES-256-GCM, per-row IV, master
   key in Worker Secrets).

The two gates are deliberately separate. Compromising the team key alone
does not grant Gmail access; compromising a Gmail refresh token alone does
not let you act as a teammate against the MCP server.

### Per-teammate isolation

One middleware (`src/auth/session.ts`) is the **only** place the MCP bearer
is resolved to a `teammate_id`. Tools never accept a `teammate_id`
parameter — a boot-time `FORBIDDEN_INPUT_KEYS` guard in the tool registry
fails-loud if any tool ever tries. Every DB query that touches inbox /
token / draft data is scoped by `WHERE teammate_id = ?`. The combination
is exercised by a six-scenario isolation test in
[test/integration/isolation.test.ts](test/integration/isolation.test.ts)
that runs against real workerd via miniflare — including token
substitution, oauth-state forgery, and post-rotation re-entry attempts.
See [docs/operator.md](docs/operator.md) §Isolation guarantees for the
full breakdown.

### Hand-rolled Streamable HTTP MCP transport

The build initially used Cloudflare's `agents` package (`McpAgent`) but
hit three independent upstream issues in succession (ajv dynamic JSON
requires, `server.connect` double-call, `partyserver` pulling
`cloudflare:email` at module-load). The pivot to a hand-rolled
Streamable HTTP transport against the MCP SDK lives in
[src/mcp/transport.ts](src/mcp/transport.ts) — the file's header
comment captures the trade-off (why the agents path was unworkable in
workerd, and why McpAgent's value props aren't load-bearing at this
scope).

---

## How it was built

- **Behavior-first, specification-first.** The build began with
  [docs/spec_v1.md](docs/spec_v1.md) — a plain-language list of
  teammate-facing behaviors, frozen as a contract. This is in the
  spirit of BDD (behavior-first, user-perspective, *what* not *how*),
  but not the formal practice: no Gherkin, no Cucumber, no executable
  specs wired to tests. The technical design
  ([docs/proposal_v1.md](docs/proposal_v1.md)) fell out of that list,
  and the agent that built it was given the spec and discretion over
  stack, architecture, and libraries.
- **Tests as a working contract.** 149 Node-pool tests + 10 workers-pool
  integration tests (`npm test`). The workers-pool tests run against real
  `workerd` via miniflare and cover the parts where a Node-pool unit
  test wouldn't catch the real failure mode: OAuth-state race
  consumption, end-to-end isolation across two real teammates, draft
  ID round-trips against `fetchMock`-driven Gmail.
- **Independent security audit.** The v1.0 candidate was audited by a
  separate review pass; findings either landed as fixes or were
  consciously deferred to v1.1 with a documented reason. See
  [docs/v1_1_backlog.md](docs/v1_1_backlog.md) for the deferred items
  and the rationale.
- **Live-usage doc reviews.** Two passes of "an agent exercised the MCP
  tools in a live session and wrote down what surprised it" landed real
  fixes — a draft stale-ID bug, a `--out` flag on the admin CLI to
  replace a shell-redirect footgun, an "Isolation guarantees" section
  written from the code rather than from intent.

---

## Honest tradeoffs

- **Google "Testing" mode.** The Google app stays in Testing — no
  verification, no audit, ≤100 test users. Two consequences worth
  knowing about up front:
  1. Teammates see Google's "Google hasn't verified this app" warning
     when they connect each inbox, and walk through
     **Advanced → Go to (unsafe) → Allow**. The
     [teammate guide](docs/teammate.md) walks them through it.
  2. Google expires the stored refresh token after ~7 days of inactivity.
     Each inbox prompts to reconnect roughly once a week. This is
     **expected and normal**, not a bug; verification is the only way to
     turn it off, and verification is a deliberate non-goal of this
     scope.
- **Not multi-tenant.** This serves one team, that team's inboxes. Gmail
  only. Email only. Adding multi-tenancy would mean either a per-team
  Worker deployment or a per-team Durable Object — both are real options,
  but not v1.0 scope.
- **Cloudflare account access is separate from the MCP isolation model.**
  Anyone with Cloudflare dashboard access to the Worker's account can
  read the underlying D1 rows directly. The isolation guarantees are
  *against MCP clients and the operator-token surface*, not against an
  attacker who has compromised the Cloudflare account. The operator
  token itself is a privileged credential that lives outside the
  per-teammate isolation model — see
  [docs/operator.md](docs/operator.md) §Isolation guarantees for the
  full caveat list.
- **Deferred work in v1.1.** AES master-key rotation, Wrangler 3 → 4
  upgrade, a dev-only `npm audit` cleanup (the deployed bundle has 0
  advisories; `vitest-pool-workers` 0.5.x is the source of the 11
  dev-pool findings), and an operator-side audit-log persistence table
  are tracked in [docs/v1_1_backlog.md](docs/v1_1_backlog.md) with shape,
  acceptance criteria, and rough estimates.

---

## Toolchain

- **Wrangler**: pinned to **`3.114.17`** in [package.json](package.json)
  (exact, no caret). The `new_sqlite_classes` Durable Objects feature
  works on this version and has been validated via
  `wrangler deploy --dry-run`. The 3 → 4 upgrade is a deliberate v1.1
  step (see [docs/v1_1_backlog.md](docs/v1_1_backlog.md) item 3).
- **Node**: 22 or newer (the test suite uses `node:sqlite`, which landed
  in 22).
- **Cloudflare**: Workers + D1 (SQLite) + KV. Free-tier-friendly by
  design — no Durable Objects, no R2, no Queues, no background timers.

---

## Running it locally

The minimum:

```sh
git clone https://github.com/hltlabhq/gmail-multi-account-mcp.git
cd gmail-multi-account-mcp
npm install                 # also applies patches/ via postinstall
npm run typecheck
npm test                    # 149 + 10 tests across two pools
```

To actually deploy and use the thing, follow [docs/deploy.md](docs/deploy.md)
end-to-end. It assumes you have a Cloudflare account, a Google Cloud
project with the Gmail API enabled, and the patience for one careful
~30-minute sit-down.

---

## Security posture

- Worker Secrets (`GOOGLE_CLIENT_SECRET`, `AES_MASTER_KEY`, `HMAC_PEPPER`,
  `OPERATOR_TOKEN_HMAC`, etc.) are set via `wrangler secret put` and never
  enter the repo. `wrangler.toml` is gitignored per-operator and contains
  real Cloudflare resource IDs; the committed template is
  [wrangler.toml.example](wrangler.toml.example).
- The operator's raw `OPERATOR_TOKEN`, team keys, and `credentials.json`
  belong only in a password manager and `~/.gmail-mcp-admin.env`
  (chmod 600).
- The admin CLI **refuses** an `--operator-token=...` flag outright (it
  would land in shell history). The token is read from the environment
  or the dotfile only.
- Outbound logs flow through a scrubber that redacts anything matching
  the team-key or operator-token shape before emission, and tests
  exercise the scrubber against representative inputs.

---

## License

[MIT](LICENSE) — © 2026 hltlabhq.

The MIT license covers only the first-party code authored for this
project. Dependencies and the `patches/ajv+8.20.0.patch` retain their own
licenses; see [THIRD_PARTY.md](THIRD_PARTY.md) for the breakdown.
