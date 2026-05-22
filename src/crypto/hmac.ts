// Peppered HMAC-SHA-256 used to:
//   * Hash team-key secrets at rest (one row per teammate).
//   * Hash the OPERATOR_TOKEN that admin endpoints compare against.
//   * Hash MCP access/refresh tokens at rest in the OAuth provider tables.
//
// The pepper is a high-entropy server secret (HMAC_PEPPER) loaded from
// Worker Secrets. We use the pepper as the HMAC key — same construction as
// "HMAC under a server-side pepper" — so a DB read alone cannot impersonate
// anyone.

import { bytesToHex, toBuf } from "./ct.js";

let cachedKeyMaterial: ArrayBuffer | null = null;
let cachedPepperHash: string | null = null;

async function importPepper(pepperBase64: string): Promise<CryptoKey> {
  // Cache the imported key by hash to avoid re-importing on every call.
  // Pepper rotation requires a Worker restart, which is acceptable for v1.
  const raw = base64ToBytes(pepperBase64);
  const digest = await crypto.subtle.digest("SHA-256", toBuf(raw));
  const fp = bytesToHex(new Uint8Array(digest));
  if (cachedKeyMaterial && cachedPepperHash === fp) {
    return crypto.subtle.importKey(
      "raw",
      cachedKeyMaterial,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  // Copy into a fresh ArrayBuffer so the cached key material is independent
  // of the input slice.
  const copy = new Uint8Array(raw.length);
  copy.set(raw);
  cachedKeyMaterial = copy.buffer;
  cachedPepperHash = fp;
  return crypto.subtle.importKey(
    "raw",
    cachedKeyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmacSha256(
  pepperBase64: string,
  message: string | Uint8Array,
): Promise<Uint8Array> {
  const key = await importPepper(pepperBase64);
  const data = typeof message === "string"
    ? new TextEncoder().encode(message)
    : message;
  const sig = await crypto.subtle.sign("HMAC", key, toBuf(data));
  return new Uint8Array(sig);
}

export async function hmacSha256Hex(
  pepperBase64: string,
  message: string | Uint8Array,
): Promise<string> {
  return bytesToHex(await hmacSha256(pepperBase64, message));
}

export function base64ToBytes(b64: string): Uint8Array {
  // Accept both standard and base64url; pad as needed.
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
