// Constant-time equality for byte sequences. Used wherever a server-side
// secret is compared against attacker-controlled input (team-key hashes,
// HMACs of OPERATOR_TOKEN, etc.).
//
// The Web Crypto API does not ship a constant-time compare, so we implement
// one over Uint8Array. The XOR-OR pattern below has no early exit and runs
// in time proportional to max(a.length, b.length). Comparing two byte arrays
// of different lengths is also a fixed cost: we still walk to the longer
// length, but the result is guaranteed not equal.

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // Out-of-bounds reads on Uint8Array return undefined; coerce to 0 so the
    // XOR still folds something into `diff`.
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// Convenience: compare equal-length hex strings constant-time.
export function timingSafeEqualHex(a: string, b: string): boolean {
  return timingSafeEqualBytes(hexToBytes(a), hexToBytes(b));
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return new Uint8Array(0);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i]! < 16 ? "0" : "") + bytes[i]!.toString(16);
  }
  return s;
}

// Web Crypto BufferSource (under TS 5.7+) is generic over the underlying
// ArrayBuffer type. Inputs from TextEncoder.encode, .slice on typed arrays,
// or third parties may be typed as Uint8Array<ArrayBufferLike>, which doesn't
// match. This helper produces a fresh ArrayBuffer copy, suitable for any
// Web Crypto call (BufferSource accepts ArrayBuffer).
export function toBuf(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}
