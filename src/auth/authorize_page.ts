// "Paste your team key" authorization page (Gate 1).
//
// This is the only outward-facing HTML in the server. Hardening:
//
//   * Strict Content-Security-Policy:
//       - default-src 'self'          (no off-origin loads of anything)
//       - script-src 'none'           (no JS at all — the form is pure HTML)
//       - style-src 'unsafe-inline'   (tiny inline <style>; safe because
//         script-src is 'none' so XSS would have nothing to execute)
//       - form-action 'self'          (the team key POST cannot be redirected
//         to any other origin even if the page is XSS'd)
//       - frame-ancestors 'none'      (cannot be embedded; defeats clickjack)
//       - base-uri 'none'             (no <base> rewrite of form action)
//       - connect-src 'none'          (no fetch/XHR from the page; pointless
//         here since script-src is none, but cheap belt-and-braces)
//   * Referrer-Policy: no-referrer    (team key never leaks via Referer)
//   * Cache-Control: no-store         (nothing intermediated)
//   * autocomplete="off" on the input (browsers shouldn't save the key)
//   * No external resources — the page is wholly inline.
//
// The page renders a single form that POSTs `team_key` + the OAuth
// AuthRequest carrier blob to /oauth/authorize/verify. The verify handler
// re-parses the AuthRequest from the hidden field; we do NOT rely on the
// browser to retain any OAuth state across the round trip.

export interface AuthorizePageContext {
  // The serialized AuthRequest as a JSON-then-base64url blob, carried in a
  // hidden form field. The verify handler decodes and re-validates it.
  authRequestBlob: string;
  // The client name to render to the user, if known. Plain text only.
  clientName?: string;
  // Optional error message from a previous failed attempt. Plain text only;
  // never includes secret material.
  errorBanner?: string;
}

const PAGE_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  p.lead { color: #555; margin-top: 0; }
  label { display: block; margin: 1.25rem 0 0.25rem; font-weight: 600; }
  input[type="text"] { width: 100%; padding: 0.55rem; font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                       border: 1px solid #999; border-radius: 4px; box-sizing: border-box; }
  button { margin-top: 1rem; padding: 0.55rem 1rem; font: inherit; cursor: pointer;
           background: #111; color: #fff; border: 0; border-radius: 4px; }
  .err { color: #b00020; margin-top: 1rem; }
  .hint { color: #666; font-size: 0.9rem; margin-top: 1.5rem; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAuthorizePage(ctx: AuthorizePageContext): Response {
  const errorHtml = ctx.errorBanner
    ? `<p class="err">${escapeHtml(ctx.errorBanner)}</p>`
    : "";
  const clientLine = ctx.clientName
    ? `<p class="lead">${escapeHtml(ctx.clientName)} would like to connect to your inboxes.</p>`
    : `<p class="lead">An assistant client would like to connect to your inboxes.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Team Gmail Assistant — Sign in</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>Sign in to Team Gmail Assistant</h1>
${clientLine}
${errorHtml}
<form method="POST" action="/oauth/authorize/verify" autocomplete="off">
  <label for="team_key">Team key</label>
  <input id="team_key" name="team_key" type="text" inputmode="text"
         autocomplete="off" spellcheck="false" autocapitalize="off"
         autofocus required
         pattern="tk_[A-Z2-7]{8}_[A-Z2-7]{32}"
         placeholder="tk_XXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX">
  <input type="hidden" name="ar" value="${escapeHtml(ctx.authRequestBlob)}">
  <button type="submit">Continue</button>
</form>
<p class="hint">Your team key was issued to you by your operator. Keep it — you may need it again if your assistant ever asks you to re-authorize.</p>
</body>
</html>
`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": [
        "default-src 'self'",
        "script-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "connect-src 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      // HSTS for browser sessions hitting the authorize page. 180 days,
      // subdomain-inclusive. Not preloaded — operators may legitimately
      // serve via http://localhost for `wrangler dev`, and the preload
      // commitment would lock that out.
      "strict-transport-security": "max-age=15552000; includeSubDomains",
    },
  });
}
