#!/usr/bin/env -S node --experimental-strip-types
// Operator CLI for /admin/* endpoints.
//
// Run from the project root:
//
//   npm run admin -- provision "Alice" --out alice.key [--note "alice@org"]
//   npm run admin -- list
//   npm run admin -- rotate "Alice" --out alice.key
//   npm run admin -- revoke "Alice"
//   npm run admin -- purge "Alice"
//   npm run admin -- clear-block <keyid|ip>      # clears self-expiring block
//
// For `provision` and `rotate`, the recommended form passes --out <path>
// and the CLI writes the team key directly to that file with mode 0600.
// No stdout redirection, no need for `npm run --silent`, no banner
// contamination risk. The legacy stdout-redirect form still works for
// scripts that depend on it, but the documented happy path is --out.
//
// Configuration (read in this priority order):
//
//   1. Environment variables:
//        GMAIL_MCP_BASE_URL   e.g. https://gmail-mcp.your.workers.dev
//        OPERATOR_TOKEN       the operator bearer
//   2. Dotfile:
//        $HOME/.gmail-mcp-admin.env  (chmod 600)
//        Lines of the form NAME=VALUE; '#' comments allowed.
//
// CRITICAL hardening rules enforced by this script:
//   * OPERATOR_TOKEN MUST NOT come from a command-line flag. The CLI rejects
//     any `--operator-token` argument so it never lands in shell history.
//   * The OPERATOR_TOKEN is never printed, never logged, never echoed.
//   * Newly minted team keys go to --out (preferred: mode-0600 file write,
//     no shell involvement) OR, in the legacy stdout path, only when stdout
//     is redirected to a file OR --unsafe-tty is passed. This blocks
//     accidental capture by shell history / scrollback.
//   * No subprocess invocation is used for HTTP, so secrets cannot leak via
//     `ps` argv.

import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

interface Config {
  baseUrl: string;
  operatorToken: string;
}

function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  // Belt-and-braces: warn if the file is world-readable.
  try {
    const st = statSync(path);
    // POSIX permissions; bit 0o077 set means group/other readable.
    if ((st.mode & 0o077) !== 0) {
      process.stderr.write(
        `warning: ${path} has loose permissions (mode ${(st.mode & 0o777).toString(8)}); recommend chmod 600\n`,
      );
    }
  } catch {
    /* ignore */
  }
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function loadConfig(argv: string[]): Config {
  // Refuse a --operator-token=... flag outright.
  for (const a of argv) {
    if (a === "--operator-token" || a.startsWith("--operator-token=")) {
      die(
        "refusing to read OPERATOR_TOKEN from a command-line flag (would leak to shell history). " +
          "Set OPERATOR_TOKEN in $HOME/.gmail-mcp-admin.env (chmod 600) instead.",
      );
    }
  }
  const dotfile = join(homedir(), ".gmail-mcp-admin.env");
  const file = readDotenv(dotfile);
  const baseUrl = process.env.GMAIL_MCP_BASE_URL ?? file.GMAIL_MCP_BASE_URL ?? "";
  const operatorToken = process.env.OPERATOR_TOKEN ?? file.OPERATOR_TOKEN ?? "";
  if (!baseUrl) die("GMAIL_MCP_BASE_URL is not set (env or " + dotfile + ")");
  if (!operatorToken) die("OPERATOR_TOKEN is not set (env or " + dotfile + ")");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), operatorToken };
}

function die(msg: string, code = 2): never {
  process.stderr.write(`admin: ${msg}\n`);
  process.exit(code);
}

async function call(
  cfg: Config,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(cfg.baseUrl + path, {
    method,
    headers: {
      authorization: `Bearer ${cfg.operatorToken}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

// Emit a minted team key safely. Two modes:
//
//   * --out <path> (preferred): write the BEGIN/END-wrapped key directly
//     to that file with mode 0600. No shell involved → no chance of
//     npm's run-banner or any other byte slipping in alongside the key.
//     Refuses to overwrite an existing file by default; pass --force to
//     overwrite (the operator does this knowingly).
//
//   * Legacy stdout (when --out is not given): same TTY-refusal behavior
//     as before, with the same `--unsafe-tty` opt-out. Documented happy
//     path is --out; this mode is kept for scripts that depend on it.
function emitTeamKey(
  plaintext: string,
  opts: { unsafeTty: boolean; outFile?: string; force?: boolean },
): void {
  const body = `--- BEGIN TEAM KEY ---\n${plaintext}\n--- END TEAM KEY ---\n`;

  if (opts.outFile) {
    const abs = resolvePath(opts.outFile);
    // `wx` = exclusive create — fails if the file already exists, so a
    // typo can't silently overwrite an earlier teammate's still-needed key.
    const flag = opts.force ? "w" : "wx";
    try {
      writeFileSync(abs, body, { mode: 0o600, flag });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        die(
          `refusing to overwrite existing file '${abs}'. ` +
            "Delete the existing file first, or pass --force to overwrite knowingly.",
          5,
        );
      }
      die(`failed to write key to '${abs}': ${err.message}`, 5);
    }
    process.stderr.write(
      `Team key written to ${abs} (chmod 600). Send it to the teammate via a ` +
        "one-time-secret link (see docs/operator.md), then delete the file.\n",
    );
    return;
  }

  const isTty = process.stdout.isTTY;
  if (isTty && !opts.unsafeTty) {
    process.stderr.write(
      "refusing to print a team key to an interactive terminal. Re-run with " +
        "--out <path> to write the key directly to a file:\n" +
        "    npm run admin -- provision 'Alice' --out alice.key\n" +
        "Or pass --unsafe-tty if you understand the risks " +
        "(shell scrollback / history may capture it).\n",
    );
    process.exit(3);
  }
  // Stdout mode (intentional pipe / redirect): wrap with sentinels so the
  // operator can grep deterministically without mistaking other output
  // for the key.
  process.stdout.write(body);
}

function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        flags[a.slice(2)] = argv[++i]!;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usage(): never {
  process.stderr.write(
    [
      "usage:",
      "  admin provision <name> --out <path> [--note <text>] [--force] [--unsafe-tty]",
      "  admin list",
      "  admin rotate <name> --out <path> [--force] [--unsafe-tty]",
      "  admin revoke <name>",
      "  admin purge <name>",
      "  admin clear-block <ip:<ip> | keyid:<keyid> | op:<fp>>",
      "",
      "For provision/rotate, --out writes the team key directly to the named",
      "file with mode 0600 (refuses to overwrite unless --force). The legacy",
      "stdout-redirect form (without --out) still works.",
      "",
      "Reads OPERATOR_TOKEN from env or $HOME/.gmail-mcp-admin.env (chmod 600).",
      "Never accepts OPERATOR_TOKEN on the command line.",
    ].join("\n") + "\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  const cmd = args[0]!;
  const rest = args.slice(1);
  const { positional, flags } = parseFlags(rest);
  const cfg = loadConfig(args);
  const unsafeTty = flags["unsafe-tty"] === true;

  switch (cmd) {
    case "provision": {
      const name = positional[0];
      const note = typeof flags.note === "string" ? flags.note : undefined;
      const outFile = typeof flags.out === "string" ? flags.out : undefined;
      const force = flags.force === true;
      if (!name) usage();
      const { status, json } = await call(cfg, "POST", "/admin/provision", {
        display_name: name,
        contact_note: note,
      });
      if (status !== 200) {
        die(`provision failed: HTTP ${status} ${JSON.stringify(json)}`, 1);
      }
      const j = json as { teammate_id: string; keyid: string; team_key: string };
      process.stderr.write(
        `provisioned teammate ${j.teammate_id} (keyid ${j.keyid}). ` +
          `Send the team key to the teammate; it is NOT shown again.\n`,
      );
      emitTeamKey(j.team_key, { unsafeTty, outFile, force });
      return;
    }
    case "list": {
      const { status, json } = await call(cfg, "GET", "/admin/list");
      if (status !== 200) die(`list failed: HTTP ${status}`, 1);
      process.stdout.write(JSON.stringify(json, null, 2) + "\n");
      return;
    }
    case "rotate": {
      const name = positional[0];
      const outFile = typeof flags.out === "string" ? flags.out : undefined;
      const force = flags.force === true;
      if (!name) usage();
      const { status, json } = await call(cfg, "POST", "/admin/rotate", {
        display_name: name,
      });
      if (status !== 200) die(`rotate failed: HTTP ${status} ${JSON.stringify(json)}`, 1);
      const j = json as { teammate_id: string; keyid: string; team_key: string };
      process.stderr.write(
        `rotated keys for ${j.teammate_id} (new keyid ${j.keyid}). Old key is revoked.\n`,
      );
      emitTeamKey(j.team_key, { unsafeTty, outFile, force });
      return;
    }
    case "revoke": {
      const name = positional[0];
      if (!name) usage();
      const { status, json } = await call(cfg, "POST", "/admin/revoke", {
        display_name: name,
      });
      if (status !== 200) die(`revoke failed: HTTP ${status} ${JSON.stringify(json)}`, 1);
      process.stdout.write(JSON.stringify(json) + "\n");
      return;
    }
    case "purge": {
      const name = positional[0];
      if (!name) usage();
      const { status, json } = await call(cfg, "POST", "/admin/purge", {
        display_name: name,
      });
      const j = json as {
        ok?: boolean;
        partial?: boolean;
        teammate_row_deleted?: boolean;
        inboxes?: {
          nickname: string;
          inbox_id: string;
          status: "purged" | "revoke_failed";
          message?: string;
        }[];
        message?: string;
      };
      if (status === 404) {
        die(`purge failed: no teammate named '${name}'`, 1);
      }
      // Itemize per inbox.
      if (j.inboxes && j.inboxes.length > 0) {
        for (const r of j.inboxes) {
          if (r.status === "purged") {
            process.stdout.write(`  ok       ${r.nickname}\n`);
          } else {
            process.stderr.write(`  FAIL     ${r.nickname}: ${r.message ?? "revoke_failed"}\n`);
          }
        }
      } else {
        process.stdout.write(`  (no inboxes connected)\n`);
      }
      if (j.ok && !j.partial) {
        process.stdout.write(
          `purged teammate ${name}; row deleted=${j.teammate_row_deleted ? "yes" : "no"}.\n`,
        );
        return;
      }
      // Partial failure — surface the operator-facing message and exit non-zero.
      if (j.message) process.stderr.write("\n" + j.message + "\n");
      process.exit(4);
    }
    case "clear-block": {
      const target = positional[0];
      if (!target) usage();
      const { status, json } = await call(cfg, "POST", "/admin/clear-block", {
        target,
      });
      if (status !== 200) die(`clear-block failed: HTTP ${status}`, 1);
      process.stdout.write(JSON.stringify(json) + "\n");
      return;
    }
    default:
      usage();
  }
}

main().catch((e) => die((e as Error).message ?? String(e), 1));
