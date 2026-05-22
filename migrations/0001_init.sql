-- 0001_init.sql
-- Initial schema for the Team Gmail Assistant MCP server.
--
-- Design notes:
--  * Per-teammate isolation: every row of inboxes, team_keys, and
--    oauth_states is owned by exactly one teammate_id. Tool-side queries
--    always filter on the request's resolved teammate_id.
--  * No Google Workspace / hd / domain enforcement anywhere. Team
--    membership = "operator gave you a team key".
--  * Secrets at rest: team-key secrets stored only as peppered HMAC.
--    Gmail refresh tokens stored only as AES-256-GCM ciphertext + per-row IV.
--  * MCP OAuth tokens / clients / grants live in KV (managed by
--    @cloudflare/workers-oauth-provider, binding OAUTH_KV), not here.
--    The teammate_id binding for those tokens lives in the grant's encrypted
--    `props` (set at completeAuthorization time); see src/auth/oauth_provider.ts.

PRAGMA foreign_keys = ON;

------------------------------------------------------------------------------
-- teammates: one row per provisioned team member.
------------------------------------------------------------------------------
CREATE TABLE teammates (
  id            TEXT PRIMARY KEY,           -- internal id (e.g. tm_<base32>)
  display_name  TEXT NOT NULL,
  contact_note  TEXT,                       -- operator's free-text reference
  created_at    INTEGER NOT NULL,           -- unix epoch ms
  revoked_at    INTEGER                     -- nullable; set on revoke/purge
);

CREATE UNIQUE INDEX teammates_display_name_unique
  ON teammates(display_name)
  WHERE revoked_at IS NULL;

------------------------------------------------------------------------------
-- team_keys: per-teammate credentials used to authenticate the one-time
-- MCP OAuth handshake. Format `tk_<keyid>_<secret>`; only `keyid` and
-- HMAC(pepper, secret) are stored.
------------------------------------------------------------------------------
CREATE TABLE team_keys (
  keyid         TEXT PRIMARY KEY,           -- 8 base32 chars
  teammate_id   TEXT NOT NULL REFERENCES teammates(id) ON DELETE CASCADE,
  secret_hash   BLOB NOT NULL,              -- HMAC-SHA-256 (peppered)
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER                     -- nullable
);

CREATE INDEX team_keys_by_teammate ON team_keys(teammate_id);

-- At most one active (non-revoked) key per teammate. Older rows kept for audit.
CREATE UNIQUE INDEX team_keys_one_active_per_teammate
  ON team_keys(teammate_id)
  WHERE revoked_at IS NULL;

------------------------------------------------------------------------------
-- inboxes: connected Gmail accounts, scoped to the owning teammate.
------------------------------------------------------------------------------
CREATE TABLE inboxes (
  id                        TEXT PRIMARY KEY,    -- ib_<base32>
  teammate_id               TEXT NOT NULL REFERENCES teammates(id) ON DELETE CASCADE,
  nickname                  TEXT NOT NULL,
  email                     TEXT NOT NULL,
  google_sub                TEXT NOT NULL,
  encrypted_refresh_token   BLOB NOT NULL,
  refresh_iv                BLOB NOT NULL,
  scopes                    TEXT NOT NULL,       -- space-separated granted scopes
  created_at                INTEGER NOT NULL,
  -- Google's External + Testing OAuth refresh tokens expire after ~7 days
  -- of inactivity (and on user revoke / password change). When a refresh
  -- attempt returns `invalid_grant`, the refresh layer sets this flag and
  -- every Gmail tool checks it before calling Google. The teammate-facing
  -- recovery path is the `reconnect_inbox` MCP tool, which keeps the row
  -- id / nickname / email / google_sub stable and only replaces the token.
  needs_reconnect_at        INTEGER,             -- unix ms; NULL while healthy
  UNIQUE(teammate_id, nickname),
  UNIQUE(teammate_id, email)
);

CREATE INDEX inboxes_by_teammate ON inboxes(teammate_id);

------------------------------------------------------------------------------
-- oauth_states: short-lived state for in-flight Google OAuth callbacks
-- (Gate 2 / connect-inbox flow). Always bound to the teammate that started
-- the flow.
------------------------------------------------------------------------------
CREATE TABLE oauth_states (
  state        TEXT PRIMARY KEY,            -- random opaque token
  teammate_id  TEXT NOT NULL REFERENCES teammates(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL,               -- 'connect_inbox'
  nickname     TEXT,                        -- chosen nickname, if pre-selected
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL             -- 10 min from creation
);

CREATE INDEX oauth_states_by_teammate ON oauth_states(teammate_id);
CREATE INDEX oauth_states_by_expiry  ON oauth_states(expires_at);

------------------------------------------------------------------------------
-- ratelimit: bucketed counters for /oauth/authorize/verify and /admin/*.
-- key = "<scope>:<id>" where scope is 'ip' | 'keyid' | 'op'.
------------------------------------------------------------------------------
CREATE TABLE ratelimit (
  rkey         TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,            -- unix epoch ms, bucket start
  count        INTEGER NOT NULL,
  blocked_until INTEGER                     -- nullable; self-expiring
);

CREATE INDEX ratelimit_by_blocked_until ON ratelimit(blocked_until);

-- MCP OAuth tokens / clients / grants are NOT stored here. They live in KV
-- (binding OAUTH_KV), managed by @cloudflare/workers-oauth-provider. The
-- teammate_id is bound to each grant via the grant's encrypted `props`
-- (set at completeAuthorization time) and is also the `userId` portion of
-- the token string. See src/auth/oauth_provider.ts and src/auth/session.ts.
