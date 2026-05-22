// AES-256-GCM authenticated encryption for at-rest secrets.
//
// Used to wrap Gmail OAuth refresh tokens before they're written to the
// inboxes table. We never persist Gmail access tokens — those are
// refresh-and-discard within a single request.
//
// Format on disk: per-row 12-byte IV stored alongside the ciphertext column.
// AAD binds the ciphertext to its row id, so an attacker who swaps row blobs
// gets an auth-tag failure rather than silent acceptance.
//
// Master key (AES_MASTER_KEY) is a 32-byte value loaded from Worker Secrets,
// base64-encoded.

import { toBuf } from "./ct.js";
import { base64ToBytes } from "./hmac.js";

let cachedMasterKey: CryptoKey | null = null;
let cachedMasterKeyFingerprint: string | null = null;

async function importMasterKey(masterKeyBase64: string): Promise<CryptoKey> {
  // Fingerprint the key material so a key swap forces re-import.
  const raw = base64ToBytes(masterKeyBase64);
  if (raw.length !== 32) {
    throw new Error("AES_MASTER_KEY must be 32 bytes (AES-256)");
  }
  const fp = await crypto.subtle.digest("SHA-256", toBuf(raw));
  const fpHex = Array.from(new Uint8Array(fp))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (cachedMasterKey && cachedMasterKeyFingerprint === fpHex) {
    return cachedMasterKey;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toBuf(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  cachedMasterKey = key;
  cachedMasterKeyFingerprint = fpHex;
  return key;
}

export interface Sealed {
  iv: Uint8Array;        // 12 bytes
  ciphertext: Uint8Array; // includes 16-byte GCM tag at end
}

export async function seal(
  masterKeyBase64: string,
  plaintext: Uint8Array | string,
  aad?: Uint8Array | string,
): Promise<Sealed> {
  const key = await importMasterKey(masterKeyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = typeof plaintext === "string"
    ? new TextEncoder().encode(plaintext)
    : plaintext;
  const additionalData = aad === undefined
    ? undefined
    : typeof aad === "string"
      ? new TextEncoder().encode(aad)
      : aad;
  const algo = additionalData
    ? { name: "AES-GCM", iv: toBuf(iv), additionalData: toBuf(additionalData) }
    : { name: "AES-GCM", iv: toBuf(iv) };
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(algo, key, toBuf(data)),
  );
  return { iv, ciphertext };
}

export async function open(
  masterKeyBase64: string,
  sealed: Sealed,
  aad?: Uint8Array | string,
): Promise<Uint8Array> {
  const key = await importMasterKey(masterKeyBase64);
  const additionalData = aad === undefined
    ? undefined
    : typeof aad === "string"
      ? new TextEncoder().encode(aad)
      : aad;
  const algo = additionalData
    ? { name: "AES-GCM", iv: toBuf(sealed.iv), additionalData: toBuf(additionalData) }
    : { name: "AES-GCM", iv: toBuf(sealed.iv) };
  const pt = await crypto.subtle.decrypt(algo, key, toBuf(sealed.ciphertext));
  return new Uint8Array(pt);
}

export async function openToString(
  masterKeyBase64: string,
  sealed: Sealed,
  aad?: Uint8Array | string,
): Promise<string> {
  return new TextDecoder().decode(await open(masterKeyBase64, sealed, aad));
}

// Cache reset for tests; not exported in non-test code paths.
export function _resetMasterKeyCacheForTest(): void {
  cachedMasterKey = null;
  cachedMasterKeyFingerprint = null;
}
