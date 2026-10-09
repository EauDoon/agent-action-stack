#!/usr/bin/env node
/**
 * Syntax gate: parse every tracked JavaScript module with `node --check`.
 *
 * The file list comes from `git ls-files`, so a new module is checked without
 * editing CI. The hand-written list it replaces drifted once already, when it
 * parsed three of nine shipped modules. Outside a Git checkout the gate walks
 * the tree instead, skipping generated and dependency folders.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./bootstrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATTERN = /\.(?:mjs|cjs|js)$/;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "deps", ".out", "test-results", "playwright-report"]);

function walk(projectRoot, directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(projectRoot, path, found);
    } else if (entry.isFile() && MODULE_PATTERN.test(entry.name)) {
      found.push(relative(projectRoot, path).split("\\").join("/"));
    }
  }
  return found;
}

/**
 * Every JavaScript module the repository tracks, as sorted root-relative
 * paths with forward slashes.
 *
 * @param {string} [projectRoot]
 * @param {{command?: typeof spawnSync}} [options]
 * @returns {string[]}
 */
export function listSyntaxTargets(projectRoot = root, { command = spawnSync } = {}) {
  const listed = command("git", ["-C", projectRoot, "ls-files", "-z", "--", "*.mjs", "*.js", "*.cjs"], {
    encoding: "utf8",
    shell: false,
  });
  if (!listed.error && listed.status === 0) {
    return listed.stdout.split("\0").filter(Boolean).sort();
  }
  return walk(projectRoot, projectRoot, []).sort();
}

/**
 * Parse each file with the running Node.js and return the ones that fail.
 *
 * @param {string[]} files Paths relative to `cwd`, or absolute.
 * @param {{cwd?: string}} [options]
 * @returns {Array<{file: string, detail: string}>}
 */
export function checkSyntax(files, { cwd = root } = {}) {
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { cwd, encoding: "utf8", shell: false });
    if (result.error || result.status !== 0) {
      failures.push({ file, detail: (result.error?.message ?? result.stderr ?? "").trim() });
    }
  }
  return failures;
}

export function main() {
  const files = listSyntaxTargets(root);
  if (files.length === 0) {
    process.stderr.write("syntax: no JavaScript modules found; refusing to report a pass\n");
    process.exitCode = 1;
    return;
  }
  const failures = checkSyntax(files, { cwd: root });
  if (failures.length === 0) {
    process.stdout.write(`syntax: ${files.length} modules parsed\n`);
    return;
  }
  for (const failure of failures) process.stderr.write(`syntax: ${failure.file} does not parse\n${failure.detail}\n`);
  process.stderr.write(`syntax: ${failures.length} of ${files.length} modules failed\n`);
  process.exitCode = 1;
}

if (isEntrypoint(import.meta.url)) main();
