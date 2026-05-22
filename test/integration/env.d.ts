// Ambient declarations for `cloudflare:test` — picks up the env binding
// shape so test code is typed.

declare module "cloudflare:test" {
  export const env: {
    DB: D1Database;
    OAUTH_KV: KVNamespace;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    AES_MASTER_KEY: string;
    HMAC_PEPPER: string;
    OPERATOR_TOKEN_HMAC: string;
    PUBLIC_BASE_URL: string;
    TEST_MIGRATIONS: unknown[];
  };
  export const SELF: { fetch: (url: string, init?: RequestInit) => Promise<Response> };

  // fetchMock is an undici MockAgent — surface only the methods the test
  // suite uses. Anything wider can be re-imported from undici if needed.
  export const fetchMock: {
    activate(): void;
    deactivate(): void;
    disableNetConnect(): void;
    enableNetConnect(): void;
    assertNoPendingInterceptors(): void;
    get(origin: string): {
      intercept(opts: {
        path: string | RegExp | ((p: string) => boolean);
        method?: string;
      }): {
        reply(
          status: number,
          body?: string | object,
          opts?: { headers?: Record<string, string> },
        ): {
          persist(): unknown;
        };
      };
    };
  };
}
