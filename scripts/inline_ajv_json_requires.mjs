#!/usr/bin/env node
// Inlines every `require("./*.json")` in ajv's dist/ tree as a literal JS
// object. Required because workerd's bundler cannot resolve dynamic JSON
// requires from CJS-via-ESM-shimmed modules; both wrangler dev and
// `wrangler deploy`'s bundle hit the same error.
//
// This is run via patch-package's snapshot mechanism: we modify
// node_modules/ajv in place, then `npx patch-package ajv` captures the
// resulting diff into patches/ajv+*.patch, which is reapplied on each
// `npm install` via the postinstall hook in package.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ajvDist = join(root, "node_modules", "ajv", "dist");

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      walk(p);
      continue;
    }
    if (!p.endsWith(".js")) continue;
    processFile(p);
  }
}

const RE = /require\(\s*"(\.\/[^"]+\.json)"\s*\)/g;

function processFile(file) {
  let src = readFileSync(file, "utf8");
  let modified = false;
  src = src.replace(RE, (match, rel) => {
    const absJson = resolve(dirname(file), rel);
    try {
      const json = readFileSync(absJson, "utf8");
      // Validate parseability; throw if not.
      const parsed = JSON.parse(json);
      modified = true;
      // Use stable string form (no whitespace) to keep the patch small.
      return JSON.stringify(parsed);
    } catch (e) {
      console.warn(`could not inline ${rel} from ${file}: ${e.message}`);
      return match;
    }
  });
  if (modified) {
    writeFileSync(file, src);
    console.log("inlined JSON requires in", file.replace(root + "/", ""));
  }
}

walk(ajvDist);
