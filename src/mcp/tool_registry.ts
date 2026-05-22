// Tool registry.
//
// Tools are declared via defineTool() and collected into TOOLS. The McpAgent
// init() walks TOOLS and registers each one with the MCP server, gating every
// invocation through the session chokepoint.
//
// Invariant: a tool may NEVER accept a teammate id (or any synonym) as input.
// defineTool() enforces this at registration time by inspecting the input
// schema's keys. Attempts to register a tool whose input has an identity-shaped
// field throw — the Worker will fail to boot rather than ship a broken tool.

import type { z } from "zod";
import type { Env } from "../index.js";
import type { TeammateRow } from "../db/teammates.js";

// Names a tool's input must NOT carry. Conservative on purpose: any addition
// here must come with a thought about why some new identity-shaped field would
// even be needed (in our model, it shouldn't).
export const FORBIDDEN_INPUT_KEYS = new Set<string>([
  "teammate_id",
  "teammateId",
  "tm_id",
  "user_id",
  "userId",
  "owner_id",
  "ownerId",
  "operator_token",
  "team_key",
  "teamKey",
]);

export interface ToolCtx {
  teammate: TeammateRow;
  env: Env;
}

export interface ToolDef<Schema extends z.ZodTypeAny> {
  name: string;
  description: string;
  // We accept any Zod schema, but at registration time we walk its shape if
  // it's an object schema to enforce the identity-field ban.
  inputSchema: Schema;
  handler: (input: z.infer<Schema>, ctx: ToolCtx) => Promise<unknown>;
}

export const TOOLS: Record<string, ToolDef<z.ZodTypeAny>> = {};

export function defineTool<Schema extends z.ZodTypeAny>(def: ToolDef<Schema>): ToolDef<Schema> {
  if (TOOLS[def.name]) {
    throw new Error(`tool name collision: ${def.name}`);
  }
  const shape = (def.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  if (shape && typeof shape === "object") {
    for (const key of Object.keys(shape)) {
      if (FORBIDDEN_INPUT_KEYS.has(key)) {
        throw new Error(
          `tool '${def.name}' must not accept an identity-shaped input '${key}'`,
        );
      }
    }
  }
  TOOLS[def.name] = def as unknown as ToolDef<z.ZodTypeAny>;
  return def;
}

// For tests / sanity checks that want a stable list.
export function listToolNames(): string[] {
  return Object.keys(TOOLS).sort();
}

// Drops all tools. Used by tests that want a clean registry between cases.
export function _resetToolsForTest(): void {
  for (const k of Object.keys(TOOLS)) delete TOOLS[k];
}
