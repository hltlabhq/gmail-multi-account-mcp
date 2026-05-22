// Tests for src/google/oauth.ts: URL builder, classifyTokenError, and the
// refreshAccessToken path with mocked fetch. exchangeCode is exercised
// indirectly by callback tests; we cover the classification matrix here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  classifyTokenError,
  InboxConfigError,
  InboxNeedsReconnectError,
  refreshAccessToken,
  TransientError,
} from "../src/google/oauth.js";
import type { Env } from "../src/index.js";

const fakeEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  PUBLIC_BASE_URL: "https://example.test",
} as unknown as Env;

describe("buildAuthorizeUrl", () => {
  it("includes all required params and our minimum scopes", () => {
    const url = new URL(
      buildAuthorizeUrl(fakeEnv, {
        state: "STATE_XYZ",
        redirectUri: "https://example.test/google/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.test/google/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("state")).toBe("STATE_XYZ");
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toMatch(/gmail\.readonly/);
    expect(scope).toMatch(/gmail\.send/);
    expect(scope).toMatch(/gmail\.modify/);
    expect(scope).toMatch(/\bopenid\b/);
    expect(scope).toMatch(/\bemail\b/);
    // Never request the things we don't need.
    expect(scope).not.toMatch(/gmail\.settings/);
    expect(scope).not.toMatch(/gmail\.full/);
    expect(url.searchParams.get("login_hint")).toBeNull();
  });

  it("passes login_hint when given", () => {
    const url = new URL(
      buildAuthorizeUrl(fakeEnv, {
        state: "S",
        redirectUri: "https://example.test/google/callback",
        loginHint: "alice@example.com",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("alice@example.com");
  });
});

describe("classifyTokenError", () => {
  it("400 invalid_grant -> InboxNeedsReconnectError", () => {
    const e = classifyTokenError(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }, "");
    expect(e).toBeInstanceOf(InboxNeedsReconnectError);
  });

  it("does NOT echo Google's error_description into the error message (audit: free-form descriptions can include app-identifying detail)", () => {
    const e = classifyTokenError(
      400,
      {
        error: "invalid_grant",
        error_description:
          "Token has been expired or revoked. user=alice@example.com client_id=abc.apps.googleusercontent.com",
      },
      "",
    );
    expect(e.message).not.toMatch(/alice@/);
    expect(e.message).not.toMatch(/expired or revoked/);
    expect(e.message).not.toMatch(/abc\.apps/);
    // The message carries only the code class.
    expect(e.message).toBe("inbox needs reconnect: invalid_grant");
  });

  it("does NOT slice the raw response body into the error message (audit: raw bodies leak)", () => {
    const rawText =
      '{"error":"invalid_request","error_description":"Missing required parameter: code","user":"alice@example.com"}';
    const e = classifyTokenError(400, { error: "invalid_request" }, rawText);
    expect(e.message).not.toMatch(/alice@/);
    expect(e.message).not.toMatch(/Missing required parameter/);
    // Allowlisted codes pass through; everything else is dropped to "http <status>".
    expect(e.message).toBe("inbox config error: http 400 invalid_request");
  });

  it("non-allowlisted error codes are stripped from the message", () => {
    const e = classifyTokenError(
      400,
      { error: "totally_made_up_code_with_user_alice@example.com" },
      "",
    );
    // The code is not allowlisted, so we drop it; only the status reaches the message.
    expect(e.message).toBe("inbox config error: http 400");
    expect(e.message).not.toMatch(/alice@/);
    expect(e.message).not.toMatch(/totally_made_up/);
  });

  it("400 with other allowlisted error -> InboxConfigError carrying the code", () => {
    expect(classifyTokenError(400, { error: "invalid_client" }, "")).toBeInstanceOf(
      InboxConfigError,
    );
    expect(classifyTokenError(401, {}, "")).toBeInstanceOf(InboxConfigError);
    expect(classifyTokenError(403, {}, "")).toBeInstanceOf(InboxConfigError);
  });

  it("500 / 502 / 503 / 504 / 408 / 429 -> TransientError", () => {
    for (const s of [500, 502, 503, 504, 408, 429]) {
      expect(classifyTokenError(s, {}, "")).toBeInstanceOf(TransientError);
    }
  });

  it("other 4xx codes -> InboxConfigError (catch-all)", () => {
    expect(classifyTokenError(404, {}, "")).toBeInstanceOf(InboxConfigError);
    expect(classifyTokenError(418, {}, "")).toBeInstanceOf(InboxConfigError);
  });
});

describe("refreshAccessToken", () => {
  // Vitest's spyOn types collide with the Cloudflare worker-types' overloaded
  // fetch signature. Cast through unknown to a minimal mock-like shape — the
  // runtime behavior is unaffected.
  let fetchSpy: {
    mockResolvedValueOnce: (r: Response) => void;
    mockRestore: () => void;
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as typeof fetchSpy;
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockResponse(status: number, body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("returns access_token on 200, derives expires_at_ms", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { access_token: "ya29.test", expires_in: 3600 }),
    );
    const r = await refreshAccessToken(fakeEnv, "old-refresh");
    expect(r.access_token).toBe("ya29.test");
    expect(r.expires_at_ms).toBeGreaterThan(Date.now() + 3000_000);
    expect(r.new_refresh_token).toBeNull();
  });

  it("captures rotated refresh_token if Google returns one", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, {
        access_token: "ya29.test",
        expires_in: 3600,
        refresh_token: "new-refresh-xyz",
      }),
    );
    const r = await refreshAccessToken(fakeEnv, "old-refresh");
    expect(r.new_refresh_token).toBe("new-refresh-xyz");
  });

  it("throws InboxNeedsReconnectError on 400 invalid_grant", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }),
    );
    await expect(refreshAccessToken(fakeEnv, "stale")).rejects.toBeInstanceOf(
      InboxNeedsReconnectError,
    );
  });

  it("throws TransientError on 503", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(503, { error: "service_unavailable" }));
    await expect(refreshAccessToken(fakeEnv, "x")).rejects.toBeInstanceOf(TransientError);
  });

  it("throws InboxConfigError if access_token missing on 200", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { expires_in: 3600 }));
    await expect(refreshAccessToken(fakeEnv, "x")).rejects.toBeInstanceOf(InboxConfigError);
  });
});
