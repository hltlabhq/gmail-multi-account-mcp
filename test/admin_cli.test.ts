// Process-level test of bin/admin.ts: covers the things that can't be unit-
// tested as functions because they're guards around argv / stdout / env.
//
// What we verify here:
//   * The CLI refuses --operator-token=... outright (would leak to history).
//   * --out writes the key directly to a mode-0600 file with BEGIN/END
//     sentinels; refuses to overwrite without --force.
//   * When stdout is a file (not a TTY), provisioning writes the key wrapped
//     in BEGIN/END sentinels — and stderr does NOT contain the team key.
//   * When config is missing, the CLI dies with code 2 and does not crash.
//
// We mock the Worker by pointing the CLI at a local http server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const CLI = new URL("../bin/admin.ts", import.meta.url).pathname;

let server: Server;
let port = 0;
const requests: { path: string; auth: string | undefined; body: string }[] = [];

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          requests.push({
            path: req.url ?? "",
            auth: req.headers.authorization,
            body,
          });
          // Canned responses by path.
          if (req.url === "/admin/provision") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                teammate_id: "tm_test",
                keyid: "TESTKEY1",
                team_key: "tk_TESTKEY1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              }),
            );
            return;
          }
          if (req.url === "/admin/list") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ teammates: [] }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
  opts: { stdoutToFile?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", CLI, ...args],
      {
        env: {
          PATH: process.env.PATH,
          HOME: mkdtempSync(join(tmpdir(), "gmcp-home-")),
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => {
      if (opts.stdoutToFile) writeFileSync(opts.stdoutToFile, stdout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("bin/admin.ts argv hardening", () => {
  it("refuses --operator-token flag", async () => {
    const r = await runCli(
      ["provision", "Alice", "--operator-token=anything"],
      { GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}`, OPERATOR_TOKEN: "x" },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/command-line flag/);
    expect(r.stderr).not.toMatch(/anything/); // the flag value never echoed back
  });

  it("dies cleanly when OPERATOR_TOKEN is unset", async () => {
    const r = await runCli(["list"], { GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}` });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/OPERATOR_TOKEN/);
  });

  it("dies cleanly when GMAIL_MCP_BASE_URL is unset", async () => {
    const r = await runCli(["list"], { OPERATOR_TOKEN: "x" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/GMAIL_MCP_BASE_URL/);
  });
});

describe("bin/admin.ts provision output", () => {
  it("emits the team key to stdout wrapped in sentinels; not to stderr", async () => {
    const r = await runCli(
      ["provision", "Alice"],
      { GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}`, OPERATOR_TOKEN: "test-op-token" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--- BEGIN TEAM KEY ---/);
    expect(r.stdout).toMatch(/tk_TESTKEY1_/);
    expect(r.stdout).toMatch(/--- END TEAM KEY ---/);
    // Stderr carries human-readable context but NOT the key itself.
    expect(r.stderr).not.toMatch(/tk_TESTKEY1_/);
    // The bearer header was sent.
    const last = requests[requests.length - 1]!;
    expect(last.auth).toBe("Bearer test-op-token");
  });

  it("never writes the OPERATOR_TOKEN to any output stream", async () => {
    const r = await runCli(
      ["list"],
      {
        GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}`,
        OPERATOR_TOKEN: "extremely-secret-operator-token-1234",
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/extremely-secret/);
    expect(r.stderr).not.toMatch(/extremely-secret/);
  });
});

describe("bin/admin.ts provision --out file path", () => {
  it("--out writes the wrapped team key to the file with mode 0600 and nothing to stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmcp-out-"));
    const outPath = join(dir, "alice.key");
    const r = await runCli(
      ["provision", "Alice", "--out", outPath],
      { GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}`, OPERATOR_TOKEN: "test-op-token" },
    );
    expect(r.code).toBe(0);
    // CLI wrote the file itself; stdout is empty (no shell redirection involved).
    expect(r.stdout).toBe("");
    // Stderr gets the human-readable "Team key written to ..." line, but
    // never the key body itself.
    expect(r.stderr).toMatch(/Team key written to/);
    expect(r.stderr).not.toMatch(/tk_TESTKEY1_/);
    // The file has the BEGIN/END-wrapped key and mode 0600.
    const body = readFileSync(outPath, "utf8");
    expect(body).toMatch(/^--- BEGIN TEAM KEY ---\ntk_TESTKEY1_/);
    expect(body).toMatch(/--- END TEAM KEY ---\n$/);
    const mode = statSync(outPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("--out refuses to overwrite an existing file (exit 5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmcp-out-"));
    const outPath = join(dir, "alice.key");
    writeFileSync(outPath, "preexisting content\n", { mode: 0o600 });
    const r = await runCli(
      ["provision", "Alice", "--out", outPath],
      { GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}`, OPERATOR_TOKEN: "test-op-token" },
    );
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/refusing to overwrite/);
    // The original content is intact.
    expect(readFileSync(outPath, "utf8")).toBe("preexisting content\n");
  });

  it("--out --force overwrites an existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmcp-out-"));
    const outPath = join(dir, "alice.key");
    writeFileSync(outPath, "preexisting content\n", { mode: 0o600 });
    const r = await runCli(
      ["provision", "Alice", "--out", outPath, "--force"],
      { GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}`, OPERATOR_TOKEN: "test-op-token" },
    );
    expect(r.code).toBe(0);
    const body = readFileSync(outPath, "utf8");
    expect(body).toMatch(/^--- BEGIN TEAM KEY ---\ntk_TESTKEY1_/);
    expect(body).toMatch(/--- END TEAM KEY ---\n$/);
    expect(body).not.toMatch(/preexisting/);
  });
});

describe("npm run admin (package.json script tripwire)", () => {
  // Regression guard for the v1.0 deploy-time bug where the admin script
  // ended in a trailing '--', so `npm run admin -- provision Alice` reached
  // the CLI as `[--, provision, Alice]` and the first arg ("--") wasn't a
  // known command. This test invokes the package script through npm so it
  // breaks if the trailing-`--` slips back in.
  it("`npm run admin -- list` reaches a known command", async () => {
    // We provide a bad OPERATOR_TOKEN so the CLI exits before actually
    // hitting the network — the assertion is "the CLI parsed 'list' as
    // the command", not whether the request succeeded.
    const homeDir = mkdtempSync(join(tmpdir(), "gmcp-home-"));
    const result = await new Promise<RunResult>((resolve) => {
      const child = spawn(
        "npm",
        ["run", "--silent", "admin", "--", "list"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: homeDir,
            GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}`,
            OPERATOR_TOKEN: "tripwire",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    // If the trailing `--` regresses, args[0] is "--" which falls through
    // to usage() and the CLI exits 2 with a "usage:" message on stderr.
    expect(result.stderr).not.toMatch(/^usage:/m);
    // `list` reaches the network layer; with our fake URL it returns
    // HTTP 200 (from the mock server above) so the CLI prints JSON to
    // stdout and exits 0.
    expect(result.code).toBe(0);
  });

  it("`npm run --silent admin` suppresses npm's banner so stdout is just the CLI's output", async () => {
    // Legacy stdout-redirect path (kept for backward compat alongside the
    // recommended --out form): if an operator pipes provision/rotate's
    // stdout to a file, npm's `> name@version admin` banner would corrupt
    // it. Confirm `--silent` does drop those banner lines.
    const homeDir = mkdtempSync(join(tmpdir(), "gmcp-home-"));
    const result = await new Promise<RunResult>((resolve) => {
      const child = spawn(
        "npm",
        ["run", "--silent", "admin", "--", "list"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: homeDir,
            GMAIL_MCP_BASE_URL: `http://127.0.0.1:${port}`,
            OPERATOR_TOKEN: "tripwire",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.stdout).not.toMatch(/^> /m); // no `> name@version admin` banner lines
  });
});

