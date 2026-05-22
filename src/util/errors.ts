// Uniform error responses for outward-facing surfaces.
//
// Both /oauth/authorize/verify and /admin/* return the same shape for every
// failure mode that an attacker could probe. Internal logs may distinguish
// the reason; the wire response does not.

export function uniformAuthFailure(): Response {
  return jsonResponse(401, { error: "invalid_request" });
}

export function rateLimited(): Response {
  // 429 is the only place we differ from 401 — callers (legitimate browsers
  // and the operator CLI) need to know to back off vs. fix credentials.
  return jsonResponse(429, { error: "rate_limited" });
}

export function notFound(): Response {
  return jsonResponse(404, { error: "not_found" });
}

export function badRequest(detail?: string): Response {
  return jsonResponse(400, { error: "bad_request", ...(detail ? { detail } : {}) });
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
