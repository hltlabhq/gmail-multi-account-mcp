import { describe, expect, it } from "vitest";
import {
  timingSafeEqualBytes,
  timingSafeEqualHex,
  hexToBytes,
  bytesToHex,
} from "../src/crypto/ct.js";
import { hmacSha256, hmacSha256Hex, base64ToBytes, bytesToBase64 } from "../src/crypto/hmac.js";
import { seal, open, openToString, _resetMasterKeyCacheForTest } from "../src/crypto/aead.js";

// 32-byte test pepper and master key. Fixed values keep KAT tests stable; they
// must NOT be reused in any real deployment.
const TEST_PEPPER_B64 = bytesToBase64(new Uint8Array(32).fill(0xab));
const TEST_KEY_B64 = bytesToBase64(new Uint8Array(32).fill(0xcd));

describe("ct.timingSafeEqualBytes", () => {
  it("returns true for equal arrays", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqualBytes(a, b)).toBe(true);
  });
  it("returns false for different content of same length", () => {
    expect(
      timingSafeEqualBytes(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 5])),
    ).toBe(false);
  });
  it("returns false for different-length inputs (still walks longer)", () => {
    expect(
      timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 0])),
    ).toBe(false);
  });
});

describe("ct hex helpers", () => {
  it("round-trips through hexToBytes / bytesToHex", () => {
    const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xff]);
    expect(bytesToHex(bytes)).toBe("00017f80ff");
    expect(hexToBytes("00017f80ff")).toEqual(bytes);
  });
  it("rejects odd-length or non-hex strings safely", () => {
    expect(hexToBytes("abc")).toEqual(new Uint8Array(0));
    expect(hexToBytes("zz")).toEqual(new Uint8Array(0));
  });
  it("compares hex constant-time", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false);
  });
});

describe("hmac", () => {
  it("base64 round-trip works", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 0xff]);
    const b64 = bytesToBase64(bytes);
    expect(base64ToBytes(b64)).toEqual(bytes);
  });
  it("produces deterministic 32-byte output", async () => {
    const sig = await hmacSha256(TEST_PEPPER_B64, "hello");
    expect(sig.length).toBe(32);
    const again = await hmacSha256(TEST_PEPPER_B64, "hello");
    expect(again).toEqual(sig);
  });
  it("changes when message changes", async () => {
    const a = await hmacSha256Hex(TEST_PEPPER_B64, "hello");
    const b = await hmacSha256Hex(TEST_PEPPER_B64, "hello!");
    expect(a).not.toBe(b);
  });
  it("changes when pepper changes", async () => {
    const a = await hmacSha256Hex(TEST_PEPPER_B64, "msg");
    const otherPepper = bytesToBase64(new Uint8Array(32).fill(0x01));
    const b = await hmacSha256Hex(otherPepper, "msg");
    expect(a).not.toBe(b);
  });
});

describe("aead (AES-256-GCM)", () => {
  it("round-trips bytes", async () => {
    _resetMasterKeyCacheForTest();
    const sealed = await seal(TEST_KEY_B64, new TextEncoder().encode("refresh-token-xyz"));
    expect(sealed.iv.length).toBe(12);
    expect(sealed.ciphertext.length).toBeGreaterThanOrEqual(16); // at least the tag
    const pt = await openToString(TEST_KEY_B64, sealed);
    expect(pt).toBe("refresh-token-xyz");
  });
  it("uses a fresh IV each call (no determinism)", async () => {
    _resetMasterKeyCacheForTest();
    const a = await seal(TEST_KEY_B64, "same-plaintext");
    const b = await seal(TEST_KEY_B64, "same-plaintext");
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });
  it("rejects tampered ciphertext", async () => {
    _resetMasterKeyCacheForTest();
    const sealed = await seal(TEST_KEY_B64, "secret");
    sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 0x01;
    await expect(open(TEST_KEY_B64, sealed)).rejects.toThrow();
  });
  it("binds AAD: wrong AAD fails decrypt", async () => {
    _resetMasterKeyCacheForTest();
    const sealed = await seal(TEST_KEY_B64, "secret", "row-id-1");
    await expect(open(TEST_KEY_B64, sealed, "row-id-2")).rejects.toThrow();
    const ok = await openToString(TEST_KEY_B64, sealed, "row-id-1");
    expect(ok).toBe("secret");
  });
  it("rejects a master key of wrong length", async () => {
    _resetMasterKeyCacheForTest();
    const tooShort = bytesToBase64(new Uint8Array(16));
    await expect(seal(tooShort, "x")).rejects.toThrow(/32 bytes/);
  });
});
