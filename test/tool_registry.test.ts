// Sanity tests on the tool registry. The two invariants we care about:
//
//   1. defineTool refuses any input schema with an identity-shaped field.
//      This is a code-level guarantee, not a test-only convention.
//   2. The shipped `whoami` tool is registered, takes no input, and returns
//      data sourced from the ctx-supplied teammate (never from input).

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  FORBIDDEN_INPUT_KEYS,
  TOOLS,
  _resetToolsForTest,
} from "../src/mcp/tool_registry.js";

// Importing the module registers the whoami tool as a side effect.
import "../src/mcp/tools/whoami.js";

describe("defineTool — identity-field guard", () => {
  it("rejects every name in FORBIDDEN_INPUT_KEYS", () => {
    // The whoami import already ran, so any direct mutation of TOOLS would
    // pollute the registry. We work on a scratch tool name for each case.
    let i = 0;
    for (const forbidden of FORBIDDEN_INPUT_KEYS) {
      const name = `__test_${i++}_${forbidden}`;
      expect(() =>
        defineTool({
          name,
          description: "test",
          inputSchema: z.object({ [forbidden]: z.string() }),
          handler: async () => ({}),
        }),
      ).toThrowError(/must not accept an identity-shaped input/);
    }
  });

  it("accepts non-identity inputs", () => {
    const name = "__test_ok";
    // Clean up any prior accidental registration.
    if (TOOLS[name]) delete TOOLS[name];
    defineTool({
      name,
      description: "ok",
      inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
      handler: async () => ({}),
    });
    expect(TOOLS[name]).toBeDefined();
    delete TOOLS[name];
  });

  it("refuses name collisions", () => {
    const name = "__test_collision";
    defineTool({
      name,
      description: "x",
      inputSchema: z.object({}),
      handler: async () => ({}),
    });
    expect(() =>
      defineTool({
        name,
        description: "y",
        inputSchema: z.object({}),
        handler: async () => ({}),
      }),
    ).toThrow(/name collision/);
    delete TOOLS[name];
  });
});

describe("whoami tool", () => {
  it("is registered with an empty input schema", () => {
    const w = TOOLS["whoami"];
    expect(w).toBeDefined();
    const shape = (w!.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toEqual([]);
  });

  it("returns id+display_name sourced from ctx.teammate, not from input", async () => {
    const w = TOOLS["whoami"]!;
    const fakeCtx = {
      teammate: {
        id: "tm_test",
        display_name: "Test User",
        contact_note: null,
        created_at: 0,
        revoked_at: null,
      },
      env: {} as never,
    };
    const out = (await w.handler({}, fakeCtx)) as {
      teammate_id: string;
      display_name: string;
    };
    expect(out.teammate_id).toBe("tm_test");
    expect(out.display_name).toBe("Test User");
  });

  it("ignores extra input fields (strict schema)", async () => {
    const w = TOOLS["whoami"]!;
    // The handler doesn't read input, so passing junk is harmless here, but
    // .strict() on the schema means the MCP server would reject extras
    // before the handler ever runs. Sanity-check that parse rejects extras.
    const schema = w.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;
    const result = schema.safeParse({ teammate_id: "tm_hacker" });
    expect(result.success).toBe(false);
  });
});

// Force the side-effect import to run before any test in this file.
void _resetToolsForTest;
