// Logging with secret-scrubbing. Every log line passes through scrubSecrets()
// before emission. The patterns block known sensitive shapes — defense in
// depth, not a substitute for not putting secrets into log fields in the
// first place.
//
//   * team keys                tk_<8 base32>_<32 base32>
//   * OPERATOR_TOKEN values    64-hex (its expected shape; see operator.md)
//   * Authorization: Bearer …  raw HTTP header line
//   * Google access tokens     ya29.<…>   (Google's standard prefix)
//   * Google refresh tokens    1//<…>     (Google's standard prefix)
//   * email addresses          local@host (replaced with local@…)
//
// Cloudflare Workers tail output is visible to anyone with Worker access —
// treat it as part of the threat model.

const TEAM_KEY_RE = /tk_[A-Z2-7]{8}_[A-Z2-7]{32}/g;
const HEX64_RE = /\b[a-fA-F0-9]{64}\b/g;
const BEARER_RE = /(authorization\s*:\s*bearer\s+)[^\s"',}\]]+/gi;
// Google access tokens are JWT-shaped with the ya29. prefix. Match the
// prefix plus any non-whitespace tail; conservative on the tail to avoid
// eating punctuation in surrounding log text.
const GOOGLE_ACCESS_RE = /ya29\.[A-Za-z0-9_\-]+/g;
// Google refresh tokens start with `1//` followed by base64url-ish chars.
const GOOGLE_REFRESH_RE = /\b1\/\/[A-Za-z0-9_\-]{20,}/g;
// Email addresses — RFC-5322 in the wild is gnarly, but a conservative
// "local@host" with a TLD-shaped suffix catches the cases we actually emit
// (Gmail addresses, both google-sub-derived `email` field values and any
// addresses that might leak through error messages). Keep the local part —
// often useful context — but replace the host so neither domain enumeration
// nor full-address recovery is possible from logs.
const EMAIL_RE = /([A-Za-z0-9_.+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function scrubSecrets(s: string): string {
  return s
    .replace(BEARER_RE, "$1[REDACTED]")
    .replace(TEAM_KEY_RE, "[REDACTED-TK]")
    .replace(GOOGLE_ACCESS_RE, "[REDACTED-GOOGLE-AT]")
    .replace(GOOGLE_REFRESH_RE, "[REDACTED-GOOGLE-RT]")
    .replace(HEX64_RE, "[REDACTED-HEX64]")
    .replace(EMAIL_RE, "$1@[REDACTED]");
}

function fmt(level: string, msg: string, fields?: Record<string, unknown>): string {
  const base = { level, ts: new Date().toISOString(), msg };
  const merged = fields ? { ...base, ...fields } : base;
  // Stringify carefully so a stray secret in a field value is still scrubbed.
  return scrubSecrets(JSON.stringify(merged));
}

export const log = {
  info(msg: string, fields?: Record<string, unknown>): void {
    console.log(fmt("info", msg, fields));
  },
  warn(msg: string, fields?: Record<string, unknown>): void {
    console.warn(fmt("warn", msg, fields));
  },
  error(msg: string, fields?: Record<string, unknown>): void {
    console.error(fmt("error", msg, fields));
  },
};
