// Per-suite setup for the workers-runtime tests: apply D1 migrations
// before the first test runs. vitest-pool-workers does not do this
// automatically; we read the migration list at config time (see
// vitest.workers.config.ts) and apply it here.
//
// We DON'T use applyD1Migrations directly because wrangler's
// unstable_splitSqlQuery emits empty-string statements for leading
// comment blocks in our migration, which D1's batch() rejects.

import { beforeAll } from "vitest";
import { env } from "cloudflare:test";

interface Migration {
  name: string;
  queries: string[];
}

let applied = false;

beforeAll(async () => {
  if (applied) return;
  const migrations = (env as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS;
  for (const m of migrations) {
    for (const q of m.queries) {
      const trimmed = q.trim();
      if (!trimmed) continue;
      // Skip lines that are entirely comments after wrangler's split.
      const stripped = trimmed
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (!stripped) continue;
      await env.DB.prepare(stripped).run();
    }
  }
  applied = true;
});
