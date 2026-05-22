// Hand-rolled Streamable HTTP MCP transport, mounted at /mcp.
//
// Why not McpAgent (the agents package's Durable Object): three independent
// upstream issues (ajv JSON-via-require; double server.connect; partyserver
// pulling cloudflare:email at module-load) made the agents path unworkable
// in workerd. We don't need McpAgent's value props — per-session DO state
// or WebSocket hibernation — for this server's scope, so the pivot to this
// stateless hand-rolled transport was the lower-risk path.
//
// What this file does:
//   * Uses @modelcontextprotocol/sdk's McpServer for the JSON-RPC protocol
//     (initialize/tools/list/tools/call dispatch, capability negotiation).
//   * Uses WebStandardStreamableHTTPServerTransport for the HTTP I/O
//     (POST in, JSON-RPC out, no Durable Object).
//   * Constructs a fresh McpServer + Transport per request — stateless,
//     workerd-friendly, no shared state to race on. Each construction is
//     ~microseconds and well under any Workers CPU budget.
//   * Tool dispatch routes through src/auth/session.ts (chokepoint) and the
//     tool registry — those files are UNCHANGED by the transport swap.
//
// The chokepoint and tool registry are byte-for-byte unchanged by the
// transport swap. The only file that changed under src/mcp/ is this one.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";

import type { Env } from "../index.js";
import { resolveTeammate, SessionError, type McpGrantPropsShape } from "../auth/session.js";
import { TOOLS } from "./tool_registry.js";
import { log } from "../util/log.js";

// Side-effect imports so defineTool() runs at module load.
import "./tools/whoami.js";
import "./tools/inboxes.js";
import "./tools/messages.js";
import "./tools/drafts.js";
import "./tools/send.js";
import "./tools/labels.js";
import "./tools/cross_inbox.js";

// Build an McpServer wired with our tool registry. Called per request; the
// SDK's server is light to instantiate. Stateless is acceptable for our
// usage — the SDK keeps no per-session state we depend on, and the OAuth
// library handles identity per request.
function buildServer(env: Env, props: McpGrantPropsShape): McpServer {
  const server = new McpServer(
    {
      name: "gmail-multi-account-mcp",
      version: "0.1.0",
    },
    {
      // Workerd-compatible JSON-schema validator (no ajv at instantiation
      // time — though we still need the ajv build patch because the SDK
      // imports the ajv provider module eagerly).
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  for (const tool of Object.values(TOOLS)) {
    const shape =
      (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    server.tool(
      tool.name,
      tool.description,
      shape as Parameters<typeof server.tool>[2],
      async (input: unknown) => {
        try {
          const teammate = await resolveTeammate(env, props);
          const result = await tool.handler(input, { teammate, env });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result) },
            ],
          };
        } catch (e) {
          if (e instanceof SessionError) {
            log.warn("mcp.session_refused", { tool: tool.name, reason: e.reason });
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "session unavailable; ask your operator to check your team key.",
                },
              ],
            };
          }
          log.error("mcp.tool_error", {
            tool: tool.name,
            msg: (e as Error).message,
          });
          return {
            isError: true,
            content: [{ type: "text" as const, text: "internal error" }],
          };
        }
      },
    );
  }

  return server;
}

// The OAuth provider library invokes apiHandler.fetch with a Request, the
// Env (extended with OAUTH_PROVIDER), and an ExecutionContext whose `props`
// is the decrypted grant props.
//
// We don't need to inspect req beyond passing it to the SDK transport. The
// transport reads JSON-RPC out of the POST body, dispatches to our McpServer,
// and returns a JSON-RPC response.
//
// Sessions: enableJsonResponse=true selects single-shot JSON-RPC responses
// (instead of SSE streams) and sessionIdGenerator=undefined puts the
// transport in stateless mode. Claude.ai's MCP connector handles both
// shapes; stateless is simpler and avoids any cross-request state on this
// stateless Worker.
export const mcpApiHandler = {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext & { props?: McpGrantPropsShape },
  ): Promise<Response> {
    const props = ctx.props;
    if (!props) {
      // Defense in depth: the OAuth library should not invoke us without
      // populating ctx.props. If something ever bypasses the gate, refuse.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "missing authorization context" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    const server = buildServer(env, props);
    await server.connect(transport);
    return transport.handleRequest(req);
  },
};
