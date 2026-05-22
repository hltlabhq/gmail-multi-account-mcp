// Worker entry. The exported handler is @cloudflare/workers-oauth-provider's
// OAuthProvider, which routes:
//
//   * /.well-known/oauth-authorization-server, /oauth/token, /oauth/register
//       → library-internal (handled by OAuthProvider directly)
//   * /mcp/*
//       → API route (library validates bearer, calls our apiHandler with
//         ctx.props set to the grant's decrypted props). The transport is
//         hand-rolled Streamable HTTP — no Durable Object — and lives in
//         src/mcp/transport.ts.
//   * everything else
//       → defaultHandler (src/default_handler.ts): /healthz, /admin/*,
//         /oauth/authorize, /oauth/authorize/verify, /

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { defaultHandler } from "./default_handler.js";
import { mcpApiHandler } from "./mcp/transport.js";
import { log } from "./util/log.js";

export interface Env {
  DB: D1Database;
  // Used by @cloudflare/workers-oauth-provider (binding name fixed by lib).
  OAUTH_KV: KVNamespace;

  // Secrets — see wrangler.toml for the list.
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  AES_MASTER_KEY: string;
  HMAC_PEPPER: string;
  OPERATOR_TOKEN_HMAC: string;
  PUBLIC_BASE_URL: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = any;

export default new OAuthProvider({
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiHandlers: {
    "/mcp": mcpApiHandler as AnyHandler,
  },
  defaultHandler: defaultHandler as AnyHandler,
  // The library's default onError does `console.warn` directly, bypassing
  // our scrub layer. Route it through log.warn so any error_description
  // material the library surfaces is scrubbed for known secret shapes
  // (Bearer tokens, ya29 access tokens, 1// refresh tokens, email
  // addresses, team keys) before it reaches wrangler tail.
  onError: ({ status, code, description }) => {
    log.warn("oauth.library_error", { status, code, description });
  },
});
