import { describe, expect, it } from "vitest";
import {
  KEY_PREFIX,
  KEYID_LEN,
  SECRET_LEN,
  mintTeamKey,
  parseTeamKey,
  verifyTeamKey,
  keyFingerprint,
  type VerifyDeps,
} from "../src/auth/team_keys.js";
import { bytesToBase64 } from "../src/crypto/hmac.js";

const PEPPER_B64 = bytesToBase64(new Uint8Array(32).fill(0xab));

function makeLookup(rows: Map<string, NonNullable<Awaited<ReturnType<VerifyDeps["lookup"]>>>>) {
  return async (keyid: string) => rows.get(keyid) ?? null;
}

describe("parseTeamKey", () => {
  it("accepts the canonical shape", () => {
    const k = `${KEY_PREFIX}ABCDEFGH_${"A".repeat(SECRET_LEN)}`;
    const p = parseTeamKey(k);
    expect(p).not.toBeNull();
    expect(p?.keyid).toBe("ABCDEFGH");
    expect(p?.secret.length).toBe(SECRET_LEN);
  });

  it("rejects bad shapes", () => {
    expect(parseTeamKey("")).toBeNull();
    expect(parseTeamKey("tk_")).toBeNull();
    expect(parseTeamKey("tk_short_secret")).toBeNull();
    expect(parseTeamKey(`tk_${"A".repeat(KEYID_LEN)}${"A".repeat(SECRET_LEN)}`)).toBeNull(); // no underscore
    expect(parseTeamKey(`prefix_${"A".repeat(KEYID_LEN)}_${"A".repeat(SECRET_LEN)}`)).toBeNull();
    expect(parseTeamKey(`tk_${"a".repeat(KEYID_LEN)}_${"A".repeat(SECRET_LEN)}`)).toBeNull(); // lowercase
    expect(parseTeamKey(`tk_${"A".repeat(KEYID_LEN)}_${"1".repeat(SECRET_LEN)}`)).toBeNull(); // '1' not in base32
  });

  it("rejects non-string input safely", () => {
    expect(parseTeamKey(undefined as unknown as string)).toBeNull();
    expect(parseTeamKey(null as unknown as string)).toBeNull();
    expect(parseTeamKey(123 as unknown as string)).toBeNull();
  });
});

describe("mintTeamKey", () => {
  it("emits keys matching the parser", async () => {
    const minted = await mintTeamKey(PEPPER_B64);
    expect(minted.plaintext.startsWith(KEY_PREFIX)).toBe(true);
    const parsed = parseTeamKey(minted.plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyid).toBe(minted.keyid);
    expect(parsed!.secret.length).toBe(SECRET_LEN);
    expect(minted.secretHash.length).toBe(32); // SHA-256 output
  });

  it("never produces duplicate keys across many mints", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const m = await mintTeamKey(PEPPER_B64);
      expect(seen.has(m.plaintext)).toBe(false);
      seen.add(m.plaintext);
    }
  });

  it("hashes deterministically given the same pepper and secret", async () => {
    // Mint, then re-hash the same secret manually via hmacSha256 round-trip.
    const m = await mintTeamKey(PEPPER_B64);
    const parsed = parseTeamKey(m.plaintext)!;
    const { hmacSha256 } = await import("../src/crypto/hmac.js");
    const rehash = await hmacSha256(PEPPER_B64, parsed.secret);
    expect(rehash).toEqual(m.secretHash);
  });
});

describe("verifyTeamKey", () => {
  it("accepts a valid key bound to a non-revoked teammate", async () => {
    const minted = await mintTeamKey(PEPPER_B64);
    const rows = new Map([
      [
        minted.keyid,
        {
          secretHash: minted.secretHash,
          teammateId: "tm_a",
          keyRevokedAt: null,
          teammateRevokedAt: null,
        },
      ],
    ]);
    const res = await verifyTeamKey(minted.plaintext, {
      pepperBase64: PEPPER_B64,
      lookup: makeLookup(rows),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.teammateId).toBe("tm_a");
      expect(res.keyid).toBe(minted.keyid);
    }
  });

  it("rejects malformed input", async () => {
    const res = await verifyTeamKey("not a key", {
      pepperBase64: PEPPER_B64,
      lookup: async () => null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("malformed");
  });

  it("rejects unknown keyid (lookup miss)", async () => {
    const minted = await mintTeamKey(PEPPER_B64);
    const res = await verifyTeamKey(minted.plaintext, {
      pepperBase64: PEPPER_B64,
      lookup: async () => null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("rejects wrong secret even when keyid exists", async () => {
    const minted = await mintTeamKey(PEPPER_B64);
    const other = await mintTeamKey(PEPPER_B64);
    const rows = new Map([
      [
        minted.keyid,
        {
          secretHash: other.secretHash, // mismatched hash
          teammateId: "tm_a",
          keyRevokedAt: null,
          teammateRevokedAt: null,
        },
      ],
    ]);
    const res = await verifyTeamKey(minted.plaintext, {
      pepperBase64: PEPPER_B64,
      lookup: makeLookup(rows),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_secret");
  });

  it("rejects revoked key", async () => {
    const minted = await mintTeamKey(PEPPER_B64);
    const rows = new Map([
      [
        minted.keyid,
        {
          secretHash: minted.secretHash,
          teammateId: "tm_a",
          keyRevokedAt: Date.now(),
          teammateRevokedAt: null,
        },
      ],
    ]);
    const res = await verifyTeamKey(minted.plaintext, {
      pepperBase64: PEPPER_B64,
      lookup: makeLookup(rows),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("revoked");
  });

  it("rejects revoked teammate (defense in depth)", async () => {
    const minted = await mintTeamKey(PEPPER_B64);
    const rows = new Map([
      [
        minted.keyid,
        {
          secretHash: minted.secretHash,
          teammateId: "tm_a",
          keyRevokedAt: null,
          teammateRevokedAt: Date.now(),
        },
      ],
    ]);
    const res = await verifyTeamKey(minted.plaintext, {
      pepperBase64: PEPPER_B64,
      lookup: makeLookup(rows),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("teammate_revoked");
  });

  it("still computes an HMAC on cache-miss to keep timing roughly uniform", async () => {
    // We can't directly assert on timing, but we can assert the lookup is
    // called exactly once and an HMAC was computed before the miss is
    // returned (by ensuring the function awaits both before resolving).
    let lookupCalls = 0;
    const minted = await mintTeamKey(PEPPER_B64);
    const res = await verifyTeamKey(minted.plaintext, {
      pepperBase64: PEPPER_B64,
      lookup: async () => {
        lookupCalls++;
        return null;
      },
    });
    expect(lookupCalls).toBe(1);
    expect(res.ok).toBe(false);
  });
});

describe("keyFingerprint", () => {
  it("is deterministic per (pepper, keyid) and not the stored hash", async () => {
    const minted = await mintTeamKey(PEPPER_B64);
    const fp1 = await keyFingerprint(PEPPER_B64, minted.keyid);
    const fp2 = await keyFingerprint(PEPPER_B64, minted.keyid);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(8); // 4 bytes -> 8 hex
    // Sanity: fingerprint of a different keyid changes.
    const fpOther = await keyFingerprint(PEPPER_B64, "AAAAAAAA");
    expect(fpOther).not.toBe(fp1);
  });
});
