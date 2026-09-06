#!/usr/bin/env node
/**
 * Full-stack integration proof for the committed component pins.
 *
 * From a clean checkout: install the root package, bootstrap the locked
 * dependencies, then exercise the pass, policy-refusal, and
 * compensated/dispute demo paths while asserting exact dependency SHAs,
 * clean tracked files, structured outcomes, stage gating, and
 * stale-artifact isolation.
 *
 * The prove stage runs the synthetic MandateBound operator simulation only;
 * a passing prove stage does not verify the rail case and claims no evidence
 * handoff or binding to the rail bundle.
 *
 * Run through `npm run integration`: the npm runner locates the npm CLI on
 * every platform (required for the install step on Windows).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFullStackNodeVersion,
  loadComponentLock,
  npmInvocation,
} from "./bootstrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
  return Boolean(condition);
}

function run(command, args, { cwd = root } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

function runNpm(args) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args);
}

function git(target, args) {
  return run("git", ["-C", target, ...args]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function latestBundle() {
  const pointer = readJson(join(root, ".out", "latest.json"));
  const bundleDir = join(root, ".out", pointer.manifest.split("/manifest.json")[0]);
  return { pointer, bundleDir, manifest: readJson(join(bundleDir, "manifest.json")) };
}

function stageFiles(bundleDir) {
  return readdirSync(join(bundleDir, "stages")).sort();
}

function runDemo(args) {
  const result = run(process.execPath, ["./bin/aas.mjs", "demo", ...args, "--json"]);
  check(result.status === 0, `demo ${args.join(" ") || "(pass)"} exited ${result.status}: ${result.stderr.slice(-400)}`);
  return result;
}

function main() {
  assertFullStackNodeVersion();

  const install = runNpm(["ci", "--ignore-scripts"]);
  check(install.status === 0, `npm ci failed: ${install.stderr.slice(-400)}`);

  const bootstrap = run(process.execPath, ["./scripts/bootstrap.mjs"]);
  check(bootstrap.status === 0, `bootstrap failed: ${bootstrap.stderr.slice(-400)}`);

  const components = loadComponentLock(join(root, "stack-lock.json"));
  for (const component of components) {
    const target = join(root, "deps", component.name);
    const head = git(target, ["rev-parse", "HEAD"]);
    check(
      head.status === 0 && head.stdout.trim() === component.commit,
      `deps/${component.name} HEAD ${head.stdout.trim()} does not match pin ${component.commit}`,
    );
    const origin = git(target, ["config", "--get", "remote.origin.url"]);
    check(
      origin.stdout.trim().replace(/\.git$/, "") === component.repository.replace(/\.git$/, ""),
      `deps/${component.name} origin ${origin.stdout.trim()} does not match ${component.repository}`,
    );
    const status = git(target, ["status", "--porcelain", "--untracked-files=no"]);
    check(status.stdout.trim() === "", `deps/${component.name} has tracked modifications`);
    for (const entrypoint of [...component.expected_entrypoints, ...(component.post_build_entrypoints ?? [])]) {
      check(existsSync(join(target, entrypoint)), `deps/${component.name} is missing ${entrypoint}`);
    }
  }

  runDemo([]);
  {
    const { manifest } = latestBundle();
    check(manifest.stages.decide?.status === "passed", "pass path: decide did not pass");
    check(manifest.stages.act?.status === "passed", "pass path: act did not pass");
    check(manifest.stages.prove?.status === "skipped", "pass path: prove was not skipped");
    check(
      JSON.stringify(stageFiles(latestBundle().bundleDir)) === JSON.stringify(["act.json", "decide.json"]),
      "pass path: stale or missing stage artifacts",
    );
    const provenance = Object.fromEntries(
      (manifest.component_provenance ?? []).map((entry) => [entry.name, entry]),
    );
    for (const component of components) {
      const entry = provenance[component.name];
      check(entry?.commit === component.commit, `pass path: provenance for ${component.name} is not the pin`);
      check(entry?.detached === true && entry?.clean === true, `pass path: ${component.name} provenance is not detached clean`);
    }
  }

  runDemo(["--response", "fail"]);
  {
    const { manifest } = latestBundle();
    check(manifest.stages.decide?.status === "failed", "refusal path: decide did not fail");
    check(manifest.stages.act?.status === "skipped", "refusal path: act was not skipped");
    check(manifest.stages.prove?.status === "skipped", "refusal path: prove was not skipped");
    check(
      JSON.stringify(stageFiles(latestBundle().bundleDir)) === JSON.stringify(["decide.json"]),
      "refusal path: bundle reuses artifacts from another run",
    );
  }

  runDemo(["--fault", "duplicate"]);
  {
    const { bundleDir, manifest } = latestBundle();
    check(manifest.stages.decide?.status === "passed", "dispute path: decide did not pass");
    check(manifest.stages.act?.status === "passed", "dispute path: act did not pass");
    check(manifest.stages.prove?.status === "passed", "dispute path: prove did not pass");
    const report = readJson(join(bundleDir, "report.json"));
    check(report.flow === "decide -> act -> prove", `dispute path: unexpected flow ${report.flow}`);
    const act = readJson(join(bundleDir, "stages", "act.json"));
    check(act.outcome === "compensated" || act.fault === "duplicate", "dispute path: act is not the compensated outcome");
    const prove = readJson(join(bundleDir, "stages", "prove.json"));
    check(prove.ok === true, "dispute path: prove payload is not ok");
    check(
      JSON.stringify(stageFiles(bundleDir)) === JSON.stringify(["act.json", "decide.json", "prove.json"]),
      "dispute path: stale or missing stage artifacts",
    );
  }

  const tree = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  check(tree.stdout.trim() === "", `integration runs left tracked modifications: ${tree.stdout.trim().slice(0, 200)}`);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`integration check failed: ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `integration check: ${components.length} pinned dependencies verified across pass, refusal, and dispute paths\n`,
  );
}

main();
