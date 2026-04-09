#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cli = path.join(root, "src", "cli.ts");

// Use tsx to run TypeScript source directly — no build needed
execFileSync(
  path.join(root, "node_modules", ".bin", "tsx"),
  [cli, ...process.argv.slice(2)],
  { stdio: "inherit", cwd: root },
);
