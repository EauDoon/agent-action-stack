import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadComponentLock, inspectDependencyDirectory, npmInvocation } from "../scripts/bootstrap.mjs";
import {
  persistRunBundle,
  resolveComponentProvenance,
  runDemo,
  writeAtomicFile,
} from "../bin/aas.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOCK = join(ROOT, "stack-lock.json");
const PROVENANCE = [
  {
    name: "constitutional-agent-testbench",
    repository: "https://github.com/EauDoon/constitutional-agent-testbench.git",
    commit: "a7a51907eaaab68a52b66edef28b3ee0fcb3ff97",
    origin: "https://github.com/EauDoon/constitutional-agent-testbench.git",
    detached: true,
    clean: true,
    entrypoints: ["pyproject.toml", "src/constitutional_agent_testbench/cli.py"],
  },
  {
    name: "consequence-rail",
    repository: "https://github.com/EauDoon/consequence-rail.git",
    commit: "d1bacc66618591231270902b657ffaa752954ee6",
    origin: "https://github.com/EauDoon/consequence-rail.git",
    detached: true,
    clean: true,
    entrypoints: ["package.json", "cmd/crctl.js"],
  },
  {
    name: "mandatebound",
    repository: "https://github.com/EauDoon/mandatebound.git",
    commit: "468fce7e0d4dcc1e86bad07a469b3d9217914bb0",
    origin: "https://github.com/EauDoon/mandatebound.git",
    detached: true,
    clean: true,
    entrypoints: ["package.json", "package-lock.json", "src/cli.ts", "dist/cli.js"],
  },
];

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "agent-action-stack-test-"));
}

function fakeDependency(component, { origin = component.repository, commit = component.commit, detached = true, clean = true } = {}) {
  const target = join(tempRoot(), component.name);
  mkdirSync(join(target, ".git"), { recursive: true });
  for (const entrypoint of component.expected_entrypoints) {
    const path = join(target, entrypoint);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "fixture\n");
  }
  const command = (_command, args) => {
    if (args.includes("config")) return { status: 0, stdout: origin, stderr: "", error: null };
    if (args.includes("rev-parse")) return { status: 0, stdout: commit, stderr: "", error: null };
    if (args.includes("symbolic-ref")) return { status: detached ? 1 : 0, stdout: detached ? "" : "main", stderr: "", error: null };
    if (args.includes("status")) return { status: clean ? 0 : 0, stdout: clean ? "" : " M fixture", stderr: "", error: null };
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
  return { target, command };
}

function stubOptions(outputRoot, overrides = {}) {
  return {
    runId: overrides.runId ?? `run-${Math.random().toString(16).slice(2)}`,
    paths: { outputRoot, fixtures: join(ROOT, "fixtures") },
    componentResolver: () => PROVENANCE,
    runDecideFn: async () => ({ ok: true, raw: { passed: true, policy_id: "refund-v1", rule_results: [] }, status: 0 }),
    runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED", fault: "none", action_id: "act-1" }, status: 0 }),
    runProveFn: async () => ({ ok: true, raw: { ok: true, result: { evidence: true } }, status: 0 }),
    ...overrides,
  };
}

test("reviewed component lock contains the exact public dependencies", () => {
  const components = loadComponentLock(LOCK);
  assert.deepEqual(components.map(({ name, repository, commit }) => ({ name, repository, commit })), PROVENANCE.map(({ name, repository, commit }) => ({ name, repository, commit })));
});

test("lock mismatch rejects substituted or stale pre-existing dependencies", () => {
  const component = loadComponentLock(LOCK)[0];
  for (const mismatch of [
    { origin: "https://github.com/example/substitute.git" },
    { commit: "0000000000000000000000000000000000000000" },
    { detached: false },
    { clean: false },
  ]) {
    const fixture = fakeDependency(component, mismatch);
    assert.throws(
      () => inspectDependencyDirectory(fixture.target, component, { command: fixture.command }),
      /lock|detached|changes|origin|commit/i,
    );
  }
});

test("missing or non-Git pre-existing directories fail closed", () => {
  const component = loadComponentLock(LOCK)[1];
  const target = join(tempRoot(), component.name);
  mkdirSync(target, { recursive: true });
  assert.throws(() => inspectDependencyDirectory(target, component), /Git metadata/);
});

test("Windows npm commands run through the npm JavaScript entrypoint", () => {
  assert.deepEqual(
    npmInvocation(["ci", "--ignore-scripts"], {
      platform: "win32",
      npmExecPath: "C:\\npm\\npm-cli.js",
      nodeExecPath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      args: ["C:\\npm\\npm-cli.js", "ci", "--ignore-scripts"],
    },
  );
  assert.throws(
    () => npmInvocation(["ci"], { platform: "win32", npmExecPath: "" }),
    /npm CLI/,
  );
  assert.deepEqual(
    npmInvocation(["ci"], { platform: "linux" }),
    { command: "npm", args: ["ci"] },
  );
});

test("pass bundle contains stage status, provenance, and only current artifacts", async () => {
  const outputRoot = tempRoot();
  const result = await runDemo(["--response", "pass"], stubOptions(outputRoot, { runId: "pass-run" }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.manifest.stages.decide.status, "passed");
  assert.equal(result.manifest.stages.act.status, "passed");
  assert.equal(result.manifest.stages.prove.status, "skipped");
  assert.equal(result.manifest.component_provenance[0].commit, PROVENANCE[0].commit);
  assert.deepEqual(readdirSync(join(result.bundleDir, "stages")).sort(), ["act.json", "decide.json"]);
  assert.equal(JSON.parse(readFileSync(join(outputRoot, "latest.json"), "utf8")).run_id, "pass-run");
});

test("policy failure records skipped markers and does not reuse prior stage artifacts", async () => {
  const outputRoot = tempRoot();
  const base = stubOptions(outputRoot, { runId: "fail-base" });
  await runDemo(["--response", "pass"], base);
  const result = await runDemo(["--response", "fail"], stubOptions(outputRoot, {
    runId: "fail-run",
    runDecideFn: async () => ({ ok: false, raw: { passed: false, policy_id: "refund-v1", error: "blocked" }, status: 0 }),
  }));
  assert.equal(result.manifest.stages.decide.status, "failed");
  assert.equal(result.manifest.stages.act.status, "skipped");
  assert.equal(result.manifest.stages.act.reason, "policy_failed");
  assert.equal(result.manifest.stages.prove.reason, "policy_failed");
  assert.equal(readdirSync(join(result.bundleDir, "stages")).length, 1);
  assert.equal(result.manifest.run_id, "fail-run");
});

test("dispute bundle runs prove and records its trigger", async () => {
  const outputRoot = tempRoot();
  const result = await runDemo(["--response", "pass", "--fault", "duplicate"], stubOptions(outputRoot, {
    runId: "dispute-run",
    runActFn: async () => ({ ok: true, raw: { outcome: "disputed", state: "CLOSED", fault: "duplicate" }, status: 0 }),
  }));
  assert.equal(result.manifest.stages.prove.status, "passed");
  assert.equal(result.report.stages.prove.triggered_by, "act_outcome=disputed");
  assert.deepEqual(readdirSync(join(result.bundleDir, "stages")).sort(), ["act.json", "decide.json", "prove.json"]);
});

test("an unresolved act outcome is sent to proof", async () => {
  const outputRoot = tempRoot();
  let proveCalls = 0;
  const result = await runDemo(["--response", "pass"], stubOptions(outputRoot, {
    runId: "unresolved-run",
    runActFn: async () => ({ ok: true, raw: { outcome: null, state: "UNKNOWN", fault: "lost-response-before-commit" }, status: 0 }),
    runProveFn: async () => {
      proveCalls += 1;
      return { ok: true, raw: { ok: true, result: { evidence: true } }, status: 0 };
    },
  }));
  assert.equal(proveCalls, 1);
  assert.equal(result.manifest.stages.prove.status, "passed");
  assert.equal(result.report.stages.prove.triggered_by, "act_outcome=null");
});

test("an unsuccessful proof fails the run", async () => {
  const outputRoot = tempRoot();
  const result = await runDemo(["--response", "pass", "--dispute"], stubOptions(outputRoot, {
    runId: "failed-proof-run",
    runProveFn: async () => ({ ok: false, raw: { ok: false, result: {} }, status: 0 }),
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.manifest.exit_code, 1);
  assert.equal(result.manifest.stages.prove.status, "failed");
});

test("child-process errors are visible as safe stage errors and downstream skips", async () => {
  const outputRoot = tempRoot();
  const result = await runDemo(["--response", "pass"], stubOptions(outputRoot, {
    runId: "child-error-run",
    runDecideFn: async () => { throw new Error("decide child process error (ENOENT)"); },
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.manifest.stages.decide.status, "error");
  assert.match(result.report.stages.decide.reason, /child process error/);
  assert.equal(result.manifest.stages.act.reason, "decide_error");
  assert.equal(result.manifest.stages.prove.reason, "decide_error");
});

test("act and prove child-process errors keep the run isolated", async () => {
  const actOutputRoot = tempRoot();
  const actError = await runDemo(["--response", "pass"], stubOptions(actOutputRoot, {
    runId: "act-error-run",
    runActFn: async () => { throw new Error("act child process exited with status 7"); },
  }));
  assert.equal(actError.exitCode, 1);
  assert.equal(actError.manifest.stages.act.status, "error");
  assert.equal(actError.manifest.stages.prove.reason, "act_error");

  const proveOutputRoot = tempRoot();
  const proveError = await runDemo(["--response", "pass", "--dispute"], stubOptions(proveOutputRoot, {
    runId: "prove-error-run",
    runProveFn: async () => { throw new Error("prove child process error (EPIPE)"); },
  }));
  assert.equal(proveError.exitCode, 1);
  assert.equal(proveError.manifest.stages.prove.status, "error");
  assert.match(proveError.report.stages.prove.reason, /EPIPE/);
});

test("atomic writes leave no partial target or temporary file after a write failure", () => {
  const outputRoot = tempRoot();
  const target = join(outputRoot, "atomic", "manifest.json");
  assert.throws(() => writeAtomicFile(target, "payload", {
    writeFile: () => { throw new Error("simulated partial write"); },
  }), /partial write/);
  assert.equal(readdirSync(join(outputRoot, "atomic")).length, 0);
});

test("persistRunBundle refuses a final-directory collision", () => {
  const outputRoot = tempRoot();
  mkdirSync(join(outputRoot, "runs", "collision"), { recursive: true });
  assert.throws(() => persistRunBundle({
    outputRoot,
    runId: "collision",
    report: { run_id: "collision" },
    stages: {},
    componentProvenance: [],
    exitCode: 0,
  }), /already exists/);
});

test("component provenance resolver rejects a missing dependency", () => {
  assert.throws(() => resolveComponentProvenance(tempRoot(), LOCK), /Missing deps/);
});

test("demo arguments reject unknown, duplicate, and missing-value options", async () => {
  await assert.rejects(() => runDemo(["--unknown"], stubOptions(tempRoot())), /Unsupported/);
  await assert.rejects(() => runDemo(["--response"], stubOptions(tempRoot())), /Missing value/);
  await assert.rejects(
    () => runDemo(["--response", "pass", "--response", "fail"], stubOptions(tempRoot())),
    /Duplicate/,
  );
});
