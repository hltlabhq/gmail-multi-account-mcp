// Random ID helpers. All generators use crypto.getRandomValues — never
// Math.random.
//
// Encoding choices:
//   * base32 (Crockford-ish, no padding) for human-paste-friendly tokens —
//     used for team-key keyids and secrets. We use the RFC 4648 alphabet
//     ("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") so it round-trips through any
//     standard base32 library if we ever need one.
//   * base64url (no padding) for opaque internal ids (teammate_id, inbox_id,
//     OAuth state values, etc.).

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function randomBase32(chars: number): string {
  // Each base32 char encodes 5 bits. Pull ceil(chars * 5 / 8) random bytes,
  // then map.
  const byteCount = Math.ceil((chars * 5) / 8);
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length && out.length < chars; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      bits -= 5;
      out += B32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  return out;
}

export function randomBase64Url(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newTeammateId(): string {
  return `tm_${randomBase64Url(16)}`;
}

export function newInboxId(): string {
  return `ib_${randomBase64Url(16)}`;
}

export function newOauthState(): string {
  return randomBase64Url(32);
}
