// `whoami` — smoke tool used as end-to-end proof that the session chokepoint
// is wired up correctly. Returns the resolved teammate's identity exactly as
// it is in D1. Notably:
//
//   * The input schema is EMPTY. The teammate is identified by the chokepoint,
//     never by tool input.
//   * The output is sourced from the live D1 row passed in via ctx.teammate.
//     Stale claims from inside the bearer cannot survive a revoke.
//
// This tool exists primarily to give an isolation-test client one trivial,
// safe operation to call against another teammate's session before any
// Gmail-related tools are wired in.

import { z } from "zod";
import { defineTool } from "../tool_registry.js";

export const whoami = defineTool({
  name: "whoami",
  description:
    "Return the identity of the currently authenticated teammate. Takes no input.",
  inputSchema: z.object({}).strict(),
  async handler(_input, { teammate }) {
    return {
      teammate_id: teammate.id,
      display_name: teammate.display_name,
    };
  },
});
