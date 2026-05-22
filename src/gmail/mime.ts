// MIME helpers — building outgoing RFC 822 messages and decoding incoming
// payloads. We stay deliberately minimal:
//
//   * Outgoing messages we generate are always text/plain UTF-8 (with an
//     optional text/html alternative if the caller passes htmlBody) and
//     7bit-safe via quoted-printable. Most real assistants compose plain
//     prose; a one-line HTML alt is the only complexity we accept.
//   * Incoming messages we read in arbitrary forms. We do best-effort
//     decoding of base64url-encoded parts and prefer text/plain. HTML-only
//     bodies are returned as their raw HTML (cap length); we don't ship a
//     full HTML→text pipeline in v1.

const CRLF = "\r\n";

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;        // plain text
  htmlBody?: string;   // optional HTML alternative
  inReplyTo?: string;  // message-id header value (with angle brackets)
  references?: string[]; // header values
  threadId?: string;   // gmail thread id; not part of MIME, kept here for callers
}

export interface BuiltMessage {
  raw_base64url: string;  // base64url of the full RFC 822 message
  threadId?: string;
}

export function buildMime(msg: OutgoingMessage): BuiltMessage {
  const headers: string[] = [];
  headers.push(`To: ${msg.to.join(", ")}`);
  if (msg.cc && msg.cc.length > 0) headers.push(`Cc: ${msg.cc.join(", ")}`);
  if (msg.bcc && msg.bcc.length > 0) headers.push(`Bcc: ${msg.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  headers.push("MIME-Version: 1.0");
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references && msg.references.length > 0) {
    headers.push(`References: ${msg.references.join(" ")}`);
  }

  let body: string;
  if (msg.htmlBody && msg.htmlBody.length > 0) {
    const boundary = `mp_${Math.random().toString(36).slice(2, 12)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body =
      `--${boundary}${CRLF}` +
      `Content-Type: text/plain; charset="UTF-8"${CRLF}` +
      `Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}` +
      quotedPrintable(msg.body) +
      CRLF +
      `--${boundary}${CRLF}` +
      `Content-Type: text/html; charset="UTF-8"${CRLF}` +
      `Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}` +
      quotedPrintable(msg.htmlBody) +
      CRLF +
      `--${boundary}--${CRLF}`;
  } else {
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    headers.push(`Content-Transfer-Encoding: quoted-printable`);
    body = quotedPrintable(msg.body);
  }

  const full = headers.join(CRLF) + CRLF + CRLF + body;
  return { raw_base64url: base64UrlEncode(new TextEncoder().encode(full)) };
}

// Decode a base64url string as bytes.
export function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Walk a Gmail message payload tree and pick the best body to show. Returns
// {kind: 'text'|'html'|'none', text: string} with `text` truncated to
// `maxChars`. Prefers text/plain; falls back to text/html.
export function pickBestBody(
  payload: GmailPayload | undefined,
  maxChars = 4096,
): { kind: "text" | "html" | "none"; text: string; truncated: boolean } {
  if (!payload) return { kind: "none", text: "", truncated: false };
  const parts = flatten(payload);
  const plain = parts.find((p) => p.mimeType?.startsWith("text/plain"));
  const html = parts.find((p) => p.mimeType?.startsWith("text/html"));
  const pick = plain ?? html;
  if (!pick || !pick.body?.data) return { kind: "none", text: "", truncated: false };
  const bytes = base64UrlDecode(pick.body.data);
  const decoded = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  if (decoded.length <= maxChars) {
    return {
      kind: plain ? "text" : "html",
      text: decoded,
      truncated: false,
    };
  }
  return {
    kind: plain ? "text" : "html",
    text: decoded.slice(0, maxChars),
    truncated: true,
  };
}

function flatten(p: GmailPayload): GmailPayload[] {
  if (!p.parts || p.parts.length === 0) return [p];
  const out: GmailPayload[] = [];
  for (const child of p.parts) out.push(...flatten(child));
  return out;
}

export interface GmailPayload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string };
  parts?: GmailPayload[];
}

export function findHeader(headers: { name: string; value: string }[] | undefined, name: string): string | null {
  if (!headers) return null;
  const ln = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === ln) return h.value;
  }
  return null;
}

// Quoted-printable encoder, RFC 2045 §6.7. Conservative: encodes any byte
// outside the printable-ASCII range (33..126 except '=') and wraps lines at
// 76 chars. Adequate for assistant-composed prose; large attachments aren't
// in scope for v1.
function quotedPrintable(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = "";
  let lineLen = 0;
  const append = (s: string): void => {
    if (s === CRLF) {
      out += s;
      lineLen = 0;
      return;
    }
    if (lineLen + s.length > 75) {
      out += "=" + CRLF;
      lineLen = 0;
    }
    out += s;
    lineLen += s.length;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0d /* CR */ && bytes[i + 1] === 0x0a /* LF */) {
      out += CRLF;
      lineLen = 0;
      i++;
      continue;
    }
    if (b === 0x0a) {
      out += CRLF;
      lineLen = 0;
      continue;
    }
    if (b === 0x09 || b === 0x20) {
      append(String.fromCharCode(b));
      continue;
    }
    if (b >= 33 && b <= 126 && b !== 0x3d /* '=' */) {
      append(String.fromCharCode(b));
      continue;
    }
    append("=" + b.toString(16).toUpperCase().padStart(2, "0"));
  }
  return out;
}

// Encode a header value containing non-ASCII as RFC 2047 encoded-word
// (UTF-8 + base64). Headers stay ASCII; the encoded-word can sit inline.
function encodeHeaderValue(v: string): string {
  // ASCII-clean? leave it.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(v)) return v;
  const b = base64UrlEncode(new TextEncoder().encode(v))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  // RFC 2047: =?charset?B?...?=
  return `=?UTF-8?B?${b}=?=`;
}
