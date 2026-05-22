// Fetch-level mock for Google + Gmail endpoints. Configurable per-test via
// the returned `mocks` object's setters. Common defaults: token refresh
// succeeds, Gmail endpoints return whatever the test wired up.

import { vi } from "vitest";

export interface GmailMock {
  // Called for every mocked URL. Returns the Response to send back.
  setHandler(fn: (url: string, init?: RequestInit) => Response | Promise<Response>): void;
  // Last received Gmail request, for assertions.
  lastRequest(): { url: string; method: string; body?: string } | null;
  // Tear down.
  restore(): void;
}

export function installGmailFetchMock(opts: { refreshAlwaysOk?: boolean } = {}): GmailMock {
  let userHandler:
    | ((url: string, init?: RequestInit) => Response | Promise<Response>)
    | null = null;
  let last: { url: string; method: string; body?: string } | null = null;
  const refreshAlwaysOk = opts.refreshAlwaysOk ?? true;

  const spy = vi.spyOn(globalThis, "fetch") as unknown as {
    mockImplementation: (fn: (input: unknown, init?: unknown) => Promise<Response>) => void;
    mockRestore: () => void;
  };
  spy.mockImplementation(async (input: unknown, init?: unknown) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const reqInit = init as RequestInit | undefined;
    last = {
      url: urlStr,
      method: reqInit?.method ?? "GET",
      body: typeof reqInit?.body === "string" ? reqInit.body : undefined,
    };
    if (urlStr.startsWith("https://oauth2.googleapis.com/token")) {
      if (refreshAlwaysOk) {
        return new Response(
          JSON.stringify({ access_token: "ya29.testaccess", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }
    if (urlStr.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      return new Response(
        JSON.stringify({ sub: "google-sub-default", email: "default@example.com" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.startsWith("https://oauth2.googleapis.com/revoke")) {
      return new Response("", { status: 200 });
    }
    if (userHandler) {
      return userHandler(urlStr, reqInit);
    }
    return new Response("not mocked: " + urlStr, { status: 500 });
  });
  return {
    setHandler(fn) {
      userHandler = fn;
    },
    lastRequest() {
      return last;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

// Build a typical Gmail message resource for tests.
export function fakeMessage(opts: {
  id: string;
  threadId: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  date?: string;
  labelIds?: string[];
  bodyText?: string;
}) {
  const headers = [
    { name: "From", value: opts.from ?? "sender@example.com" },
    { name: "To", value: opts.to ?? "you@example.com" },
    { name: "Subject", value: opts.subject ?? "(no subject)" },
    { name: "Date", value: opts.date ?? "Thu, 01 Jan 2026 00:00:00 +0000" },
  ];
  const bodyText = opts.bodyText ?? "hello\nworld\n";
  const data = btoa(bodyText).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return {
    id: opts.id,
    threadId: opts.threadId,
    labelIds: opts.labelIds ?? ["INBOX"],
    snippet: opts.snippet ?? bodyText.slice(0, 80),
    internalDate: "1700000000000",
    payload: {
      mimeType: "text/plain",
      headers,
      body: { size: bodyText.length, data },
    },
  };
}
