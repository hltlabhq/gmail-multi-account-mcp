// Tests that GmailApiError carries the HTTP status only — no slice of the
// raw response body. Gmail error responses can echo back addresses,
// message metadata, and headers; embedding them in error.message routes
// them straight into log payloads via callers' `(e as Error).message`
// patterns (audit finding 2).

import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailApiError, gmailFetch } from "../src/gmail/client.js";
import type { Env } from "../src/index.js";
import type { InboxRow } from "../src/db/inboxes.js";
import { makeFakeEnv } from "./_helpers/env.js";
import { createInbox } from "../src/db/inboxes.js";

let fetchSpy: { restore: () => void } | null = null;
afterEach(() => {
  fetchSpy?.restore();
  fetchSpy = null;
});

function installFetchMock(
  responses: { url: RegExp; status: number; body: string }[],
): { restore: () => void } {
  const spy = vi.spyOn(globalThis, "fetch") as unknown as {
    mockImplementation: (fn: (input: unknown, init?: unknown) => Promise<Response>) => void;
    mockRestore: () => void;
  };
  spy.mockImplementation(async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    // Always return a fresh token from /oauth2/token so refresh succeeds.
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    for (const r of responses) {
      if (r.url.test(url)) {
        return new Response(r.body, { status: r.status });
      }
    }
    return new Response("unexpected: " + url, { status: 500 });
  });
  return { restore: () => spy.mockRestore() };
}

describe("GmailApiError carries status only — no response body slice", () => {
  it("the thrown error's message is `gmail api http <status>` with no leaked payload", async () => {
    const env = await makeFakeEnv();
    // Seed a teammate + inbox so gmailFetch has a real row.
    await env._db
      .prepare("INSERT INTO teammates (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("tm_x", "X", Date.now())
      .run();
    const created = await createInbox(env.DB as unknown as D1Database, env.AES_MASTER_KEY, {
      teammateId: "tm_x",
      nickname: "n",
      email: "x@example.com",
      googleSub: "gs",
      refreshToken: "1//rt-test",
      scopes: "openid email",
    });
    const inbox = await env._db
      .prepare("SELECT * FROM inboxes WHERE id = ?")
      .bind(created.id)
      .first<InboxRow>();

    // Gmail returns a 404 with a body that includes an email address and a
    // message id — both forbidden in logs.
    const leakyBody = JSON.stringify({
      error: {
        code: 404,
        message:
          "Requested entity was not found. user=bob@example.com message=msg-secret-id-abc subject='Quarterly review'",
        status: "NOT_FOUND",
      },
    });
    fetchSpy = installFetchMock([
      { url: /gmail\.googleapis\.com\/.*\/messages/, status: 404, body: leakyBody },
    ]);

    const err = await gmailFetch(env as unknown as Env, inbox!, "/users/me/messages/abc")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GmailApiError);
    const ge = err as GmailApiError;
    expect(ge.status).toBe(404);
    expect(ge.message).toBe("gmail api http 404");
    // Critical: none of Gmail's response payload leaks into .message
    expect(ge.message).not.toMatch(/bob@/);
    expect(ge.message).not.toMatch(/Quarterly review/);
    expect(ge.message).not.toMatch(/msg-secret-id-abc/);
    expect(ge.message).not.toMatch(/Requested entity/);
  });
});
