// Default handler — everything that isn't an API request and isn't an
// OAuth endpoint owned by the library.
//
// Routes:
//   GET  /healthz                     liveness
//   *    /admin/*                     operator endpoints (operator-bearer-auth)
//   GET  /oauth/authorize             paste-team-key page
//   POST /oauth/authorize/verify      verify + completeAuthorization
//   GET  /                            placeholder
//
// The library invokes this handler via its `defaultHandler` slot, and adds
// `env.OAUTH_PROVIDER` (an OAuthHelpers instance) before calling fetch.

import type { ExportedHandler } from "@cloudflare/workers-types";
import type { Env } from "./index.js";
import { handleAdmin } from "./auth/admin.js";
import {
  handleAuthorize,
  handleAuthorizeVerify,
  type EnvWithOAuth,
} from "./auth/oauth_provider.js";
import { handleGoogleCallback } from "./google/callback.js";

export const defaultHandler: ExportedHandler<EnvWithOAuth> = {
  async fetch(req, env, _ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(req, env as Env, url.pathname);
    }

    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      return handleAuthorize(req, env);
    }
    if (url.pathname === "/oauth/authorize/verify" && req.method === "POST") {
      return handleAuthorizeVerify(req, env);
    }
    if (url.pathname === "/google/callback" && req.method === "GET") {
      return handleGoogleCallback(req, env);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Team Gmail Assistant MCP server. See operator docs to connect.\n",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
