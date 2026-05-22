// Dedicated tests for src/util/log.ts secret-scrubbing.
//
// Cloudflare Workers tail output is visible to anyone with Worker access.
// The audit calls out: no logging of secrets, tokens or token prefixes,
// encryption keys, email addresses, subject lines, message bodies, or
// stack traces containing payload. The first line of defense is "don't
// put those into log fields in the first place" (audited at call sites);
// scrubSecrets is the belt-and-braces second line — if any of those
// shapes ever appears in a log payload, it gets redacted before reaching
// console.* (and from there, wrangler tail).

import { describe, expect, it, vi } from "vitest";
import { scrubSecrets, log } from "../src/util/log.js";

describe("scrubSecrets — known sensitive shapes", () => {
  it("team keys (tk_<keyid>_<secret>) are redacted", () => {
    const s = scrubSecrets("teammate paste: tk_ABCDEFGH_BCDEFGHIJKLMNOPQRSTUVWXYZ2345672 saved");
    expect(s).not.toMatch(/tk_[A-Z2-7]/);
    expect(s).toMatch(/\[REDACTED-TK\]/);
  });

  it("Authorization: Bearer headers are redacted", () => {
    const s = scrubSecrets("upstream: Authorization: Bearer ya29.abcdefg1234567xxxx");
    expect(s).toMatch(/\[REDACTED\]/);
    // Bearer prefix preserved, secret stripped.
    expect(s).toMatch(/Authorization: Bearer \[REDACTED\]/);
  });

  it("Google access tokens (ya29.…) are redacted on their own", () => {
    const s = scrubSecrets('access_token=ya29.A0AeXR1234567abcd-EFG_HIJ.refresh');
    expect(s).toMatch(/\[REDACTED-GOOGLE-AT\]/);
    expect(s).not.toMatch(/ya29\./);
  });

  it("Google refresh tokens (1//…) are redacted", () => {
    const s = scrubSecrets("stored refresh 1//0gabcdefghijklmnopqrstuvwxyz0123456789");
    expect(s).toMatch(/\[REDACTED-GOOGLE-RT\]/);
    expect(s).not.toMatch(/1\/\/0g/);
  });

  it("64-hex tokens (OPERATOR_TOKEN_HMAC shape) are redacted", () => {
    const s = scrubSecrets("op fingerprint: " + "a".repeat(64));
    expect(s).toMatch(/\[REDACTED-HEX64\]/);
  });

  it("email addresses get host-redacted (local part kept for context)", () => {
    const s = scrubSecrets("send failed for alice@example.com");
    expect(s).toBe("send failed for alice@[REDACTED]");
  });

  it("addresses with dots and pluses redact host only", () => {
    const s = scrubSecrets("notify alice.foo+filter@sub.example.co.uk now");
    expect(s).toBe("notify alice.foo+filter@[REDACTED] now");
  });

  it("multiple sensitive shapes in one line are all caught", () => {
    const input =
      'token "tk_ABCDEFGH_BCDEFGHIJKLMNOPQRSTUVWXYZ2345672"' +
      ' inbox alice@example.com refresh 1//0gabcdefghijklmnopqrstuvwxyzAB' +
      ' access ya29.abcdefg-_xyz';
    const out = scrubSecrets(input);
    expect(out).not.toMatch(/tk_[A-Z2-7]/);
    expect(out).not.toMatch(/alice@example/);
    expect(out).not.toMatch(/1\/\/0gabcd/);
    expect(out).not.toMatch(/ya29\.abcdef/);
  });

  it("benign text is not touched", () => {
    const s = "ok: search_one returned 3 hits in inbox 'work'";
    expect(scrubSecrets(s)).toBe(s);
  });
});

describe("log.info/warn/error route through scrubSecrets before console.*", () => {
  it("a sensitive value in a structured field is redacted at write time", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      log.warn("test.leak_attempt", {
        // imagine someone passed a Google refresh token here by mistake
        oops: "1//0gabcdefghijklmnopqrstuvwxyz0123456789",
        // and a teammate email
        addr: "alice@example.com",
      });
      expect(spy).toHaveBeenCalledOnce();
      const line = spy.mock.calls[0]![0] as string;
      expect(line).toMatch(/\[REDACTED-GOOGLE-RT\]/);
      expect(line).toMatch(/alice@\[REDACTED\]/);
      expect(line).not.toMatch(/1\/\/0gabcd/);
      expect(line).not.toMatch(/example\.com/);
    } finally {
      spy.mockRestore();
    }
  });
});
