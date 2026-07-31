#!/usr/bin/env node
/**
 * Clone and prepare the three public stack libraries into ./deps.
 * Does not touch private repositories.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const depsDir = join(root, "deps");

const libs = [
  {
    name: "constitutional-agent-testbench",
    url: "https://github.com/oonyl/constitutional-agent-testbench.git",
    afterClone() {
      // Stdlib-only package. No pip install required; the orchestrator
      // sets PYTHONPATH to deps/.../src and runs the module.
      const src = join(depsDir, "constitutional-agent-testbench", "src");
      if (!existsSync(src)) {
        throw new Error("constitutional-agent-testbench clone is missing src/.");
      }
    },
  },
  {
    name: "consequence-rail",
    url: "https://github.com/oonyl/consequence-rail.git",
    afterClone() {},
  },
  {
    name: "mandatebound",
    url: "https://github.com/oonyl/mandatebound.git",
    afterClone() {
      const dir = join(depsDir, "mandatebound");
      const install = spawnSync("npm", ["install"], {
        cwd: dir,
        stdio: "inherit",
        shell: false,
        env: process.env,
      });
      if (install.status !== 0) {
        // Windows often needs shell to resolve npm.cmd
        const installShell = spawnSync("npm", ["install"], {
          cwd: dir,
          stdio: "inherit",
          shell: true,
          env: process.env,
        });
        if (installShell.status !== 0) {
          throw new Error("Failed to npm install mandatebound.");
        }
      }
      const build = spawnSync("npm", ["run", "build"], {
        cwd: dir,
        stdio: "inherit",
        shell: false,
        env: process.env,
      });
      if (build.status !== 0) {
        const buildShell = spawnSync("npm", ["run", "build"], {
          cwd: dir,
          stdio: "inherit",
          shell: true,
          env: process.env,
        });
        if (buildShell.status !== 0) {
          throw new Error("Failed to build mandatebound.");
        }
      }
    },
  },
];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
}

mkdirSync(depsDir, { recursive: true });

for (const lib of libs) {
  const target = join(depsDir, lib.name);
  if (existsSync(target)) {
    process.stdout.write(`deps/${lib.name}: present\n`);
  } else {
    process.stdout.write(`deps/${lib.name}: cloning…\n`);
    run("git", ["clone", "--depth", "1", lib.url, target], { cwd: root });
  }
  process.stdout.write(`deps/${lib.name}: preparing…\n`);
  lib.afterClone();
}

process.stdout.write("Bootstrap complete.\n");
