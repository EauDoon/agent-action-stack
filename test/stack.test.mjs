import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertFullStackNodeVersion, compareVersionTuples, loadComponentLock, inspectDependencyDirectory, MIN_FULL_STACK_NODE, npmInvocation, parseNodeVersion, prepareDependencies } from "../scripts/bootstrap.mjs";
import {
  buildRailReviewRequest,
  CHILD_JSON_LIMIT,
  exportRunBundle,
  CHILD_TIMEOUT_MAX_MS,
  DEFAULT_CHILD_TIMEOUT_MS,
  DEFAULT_GUI_PORT,
  DIAGNOSTIC,
  clipChildStderr,
  helpText,
  main,
  MIN_PYTHON,
  parseJsonOutput,
  parsePythonVersion,
  persistRunBundle,
  printHuman,
  resolveChildTimeoutMs,
  resolveComponentProvenance,
  resolveGuiPort,
  runAct,
  runCapture,
  pythonCandidates,
  replayBundle,
  runDecide,
  runDemo,
  runProve,
  runProveRail,
  selectPython,
  listRuns,
  pruneRuns,
  validateRailReview,
  writeAtomicFile,
} from "../bin/aas.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOCK = join(ROOT, "stack-lock.json");
const PROVENANCE = [
  {
    name: "constitutional-agent-testbench",
    repository: "https://github.com/EauDoon/constitutional-agent-testbench.git",
    commit: "16b2faa71b0f92b9afa15b13afad8c48da8132f4",
    origin: "https://github.com/EauDoon/constitutional-agent-testbench.git",
    detached: true,
    clean: true,
    entrypoints: ["pyproject.toml", "src/constitutional_agent_testbench/cli.py"],
  },
  {
    name: "consequence-rail",
    repository: "https://github.com/EauDoon/consequence-rail.git",
    commit: "89811e423a1a41bad3ecb77e18ebf557615219f8",
    origin: "https://github.com/EauDoon/consequence-rail.git",
    detached: true,
    clean: true,
    entrypoints: ["package.json", "cmd/crctl.js"],
  },
  {
    name: "mandatebound",
    repository: "https://github.com/EauDoon/mandatebound.git",
    commit: "e526c4c32ac61571757a98ca1a69189821c3dce7",
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

test("act rejects a zero-exit payload without a valid outcome", () => {
  assert.throws(
    () => runAct("none", {
      depsDir: tempRoot(),
      runner: () => ({ status: 0, stdout: "{}\n", stderr: "crctl: missing outcome\n", error: null }),
    }),
    (error) => {
      assert.match(error.message, /valid outcome/);
      assert.equal(error.code, DIAGNOSTIC.CHILD_JSON);
      assert.equal(error.stage, "act");
      assert.match(error.stderr, /missing outcome/);
      return true;
    },
  );
});

test("decide and prove reject non-boolean success fields", () => {
  const runner = () => ({
    status: 0,
    stdout: '{"passed":"false","ok":"false"}\n',
    stderr: "child: coerced success flag\n",
    error: null,
  });
  assert.throws(
    () => runDecide("unused", { runner }),
    (error) => {
      assert.match(error.message, /boolean passed field/);
      assert.equal(error.code, DIAGNOSTIC.CHILD_JSON);
      assert.equal(error.stage, "decide");
      assert.match(error.stderr, /coerced success flag/);
      return true;
    },
  );
  assert.throws(
    () => runProve("operator", { runner }),
    (error) => {
      assert.match(error.message, /boolean ok field/);
      assert.equal(error.code, DIAGNOSTIC.CHILD_JSON);
      assert.equal(error.stage, "prove");
      return true;
    },
  );
});

test("decide reads logged JSON on a nonzero exit", () => {
  const result = runDecide("unused", {
    runner: () => ({
      status: 1,
      stdout: 'evaluating policy\n{\n  "passed": false,\n  "policy_id": "refund-v1"\n}\n',
      stderr: "",
      error: null,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.raw.policy_id, "refund-v1");
});

test("prove treats nonzero JSON as an unsuccessful proof", () => {
  const result = runProve("operator", {
    runner: () => ({
      status: 2,
      stdout: '{"ok":false,"error":{"code":"ALB_CLI_USAGE","message":"Simulate accepts one scenario."}}\n',
      stderr: '{"level":"error","code":"ALB_CLI_USAGE"}\n',
      error: null,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 2);
  assert.equal(result.raw.error.code, "ALB_CLI_USAGE");
  assert.match(result.stderr, /ALB_CLI_USAGE/);
});

test("prove fail-closes a nonzero payload that claims success", () => {
  const result = runProve("operator", {
    runner: () => ({
      status: 5,
      stdout: '{"ok":true,"result":{}}\n',
      stderr: "",
      error: null,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 5);
});

test("prove still throws when a nonzero child has no JSON", () => {
  assert.throws(
    () => runProve("operator", {
      runner: () => ({
        status: 2,
        stdout: "simulate failed\n",
        stderr: "fatal: simulate accepts one scenario\n",
        error: null,
      }),
    }),
    (error) => {
      assert.match(error.message, /exited with status 2/);
      assert.match(error.message, /simulate accepts one scenario/);
      assert.equal(error.code, DIAGNOSTIC.CHILD_EXIT);
      assert.equal(error.stage, "prove");
      assert.match(error.stderr, /simulate accepts one scenario/);
      return true;
    },
  );
});

async function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("child timeout and GUI port env values default, accept integers, and reject junk", () => {
  assert.equal(DEFAULT_CHILD_TIMEOUT_MS, 30_000);
  assert.equal(DEFAULT_GUI_PORT, 8787);
  assert.equal(resolveChildTimeoutMs({}), DEFAULT_CHILD_TIMEOUT_MS);
  assert.equal(resolveChildTimeoutMs({ AAS_CHILD_TIMEOUT_MS: "" }), DEFAULT_CHILD_TIMEOUT_MS);
  assert.equal(resolveChildTimeoutMs({ AAS_CHILD_TIMEOUT_MS: " 5000 " }), 5000);
  assert.equal(resolveGuiPort({}), DEFAULT_GUI_PORT);
  assert.equal(resolveGuiPort({ AAS_GUI_PORT: "" }), DEFAULT_GUI_PORT);
  assert.equal(resolveGuiPort({ AAS_GUI_PORT: "9090" }), 9090);
  for (const raw of ["nope", "30.5", "-1", "0", String(CHILD_TIMEOUT_MAX_MS + 1)]) {
    assert.throws(() => resolveChildTimeoutMs({ AAS_CHILD_TIMEOUT_MS: raw }), /AAS_CHILD_TIMEOUT_MS/);
  }
  for (const raw of ["abc", "8787.5", "0", "65536", "-8787"]) {
    assert.throws(() => resolveGuiPort({ AAS_GUI_PORT: raw }), /AAS_GUI_PORT/);
  }
});

test("invalid AAS_CHILD_TIMEOUT_MS fails closed before a demo run", async () => {
  await withEnv("AAS_CHILD_TIMEOUT_MS", "nope", async () => {
    await assert.rejects(
      () => runDemo(["--response", "pass"], stubOptions(tempRoot())),
      /AAS_CHILD_TIMEOUT_MS/,
    );
  });
});

test("runCapture applies a timeout to a hung child", () => {
  const result = runCapture(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 80 });
  assert.equal(result.error?.code, "ETIMEDOUT");
});

test("timed-out children fail closed with AAS_CHILD_TIMEOUT", () => {
  const runner = () => ({
    status: null,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
  });
  assert.throws(
    () => runAct("none", { runner }),
    (error) => {
      assert.match(error.message, /act child process timed out/);
      assert.equal(error.code, DIAGNOSTIC.CHILD_TIMEOUT);
      assert.equal(error.stage, "act");
      return true;
    },
  );
});

test("decide does not try another Python after a child timeout", () => {
  let calls = 0;
  assert.throws(
    () => runDecide("unused", {
      runner: () => {
        calls += 1;
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
        };
      },
    }),
    (error) => {
      assert.equal(error.code, DIAGNOSTIC.CHILD_TIMEOUT);
      assert.equal(error.stage, "decide");
      assert.match(error.message, /decide child process timed out/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("act names the child and preserves stderr on a spawn failure", () => {
  assert.throws(
    () => runAct("none", {
      runner: () => ({
        status: 1,
        stdout: "",
        stderr: "node: cannot find crctl.js\n",
        error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
      }),
    }),
    (error) => {
      assert.match(error.message, /act child process error \(ENOENT\)/);
      assert.match(error.message, /cannot find crctl\.js/);
      assert.equal(error.code, DIAGNOSTIC.CHILD_SPAWN);
      assert.equal(error.stage, "act");
      assert.match(error.stderr, /cannot find crctl\.js/);
      return true;
    },
  );
});

test("child stderr clipper strips ANSI and keeps the tail", () => {
  assert.equal(clipChildStderr("  \u001b[31mboom\u001b[0m \n"), "boom");
  assert.equal(clipChildStderr(""), "");
  assert.equal(clipChildStderr(null), "");
  const long = `${"a".repeat(900)}END`;
  const clipped = clipChildStderr(long);
  assert.equal(clipped.length, 800);
  assert.equal(clipped.endsWith("END"), true);
  assert.equal(clipped.startsWith("a"), true);
});

test("child output parser accepts logged pretty-printed JSON", () => {
  assert.deepEqual(
    parseJsonOutput('starting child\n{\n  "ok": true,\n  "result": { "count": 2 }\n}\n', "fixture"),
    { ok: true, result: { count: 2 } },
  );
});

test("child output parser accepts JSON before a trailing log", () => {
  assert.deepEqual(
    parseJsonOutput('{"ok":true}\nchild complete\n', "fixture"),
    { ok: true },
  );
});

test("child JSON larger than the defensive limit is rejected", () => {
  assert.throws(
    () => parseJsonOutput('{"ok":true}', "fixture", 4),
    /fixture JSON output exceeds 4 characters/,
  );
  assert.deepEqual(parseJsonOutput('{"ok":true}', "fixture", 20), { ok: true });
  const oversized = `{"passed":true,"pad":"${"x".repeat(CHILD_JSON_LIMIT)}"}`;
  assert.throws(
    () => runDecide("unused", {
      runner: () => ({ status: 0, stdout: oversized, stderr: "child: huge json\n", error: null }),
    }),
    (error) => {
      assert.match(error.message, new RegExp(`exceeds ${CHILD_JSON_LIMIT} characters`));
      assert.equal(error.code, DIAGNOSTIC.CHILD_JSON);
      assert.equal(error.stage, "decide");
      return true;
    },
  );
});

test("decide and act reject mistyped remaining payload fields", () => {
  assert.throws(
    () => runDecide("unused", {
      runner: () => ({
        status: 0,
        stdout: '{"passed":true,"policy_id":["refund-v1"]}\n',
        stderr: "child: bad policy id\n",
        error: null,
      }),
    }),
    (error) => {
      assert.match(error.message, /valid policy_id field/);
      assert.equal(error.code, DIAGNOSTIC.CHILD_JSON);
      assert.equal(error.stage, "decide");
      return true;
    },
  );
  assert.throws(
    () => runDecide("unused", {
      runner: () => ({
        status: 0,
        stdout: '{"passed":true,"rule_results":{}}\n',
        stderr: "",
        error: null,
      }),
    }),
    /valid rule_results field/,
  );
  assert.throws(
    () => runAct("none", {
      runner: () => ({
        status: 0,
        stdout: '{"outcome":"settled","state":{"name":"CLOSED"}}\n',
        stderr: "crctl: nested state\n",
        error: null,
      }),
    }),
    (error) => {
      assert.match(error.message, /valid state field/);
      assert.equal(error.code, DIAGNOSTIC.CHILD_JSON);
      assert.equal(error.stage, "act");
      return true;
    },
  );
  assert.throws(
    () => runProve("operator", {
      runner: () => ({
        status: 0,
        stdout: '{"ok":true,"result":["evidence"]}\n',
        stderr: "",
        error: null,
      }),
    }),
    /valid result field/,
  );
});

test("README pass-path sample matches printHuman field order", async () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8").replaceAll("\r\n", "\n");
  const match = readme.match(/Expected human output \(pass path, no fault\):\n\n```text\n([\s\S]*?)```/);
  assert.ok(match, "README is missing the pass-path human output sample");
  const outputRoot = tempRoot();
  const result = await runDemo(["--response", "pass"], stubOptions(outputRoot, { runId: "pass-run" }));
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(String(chunk));
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  try {
    printHuman(result.report, result.bundleDir);
  } finally {
    process.stdout.write = originalWrite;
  }
  const actual = chunks.join("").replaceAll(result.bundleDir, ".out/runs/<run-id>");
  assert.equal(actual, match[1]);
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

test("nonzero prove JSON is recorded as a failed proof, not a child-process error", async () => {
  const outputRoot = tempRoot();
  const options = stubOptions(outputRoot, { runId: "prove-json-fail-run" });
  delete options.runProveFn;
  options.runner = () => ({
    status: 2,
    stdout: '{"ok":false,"error":{"code":"ALB_CLI_USAGE","message":"Simulate accepts one scenario."}}\n',
    stderr: '{"level":"error","code":"ALB_CLI_USAGE"}\n',
    error: null,
  });
  const result = await runDemo(["--response", "pass", "--dispute"], options);
  assert.equal(result.exitCode, 1);
  assert.equal(result.manifest.stages.prove.status, "failed");
  assert.equal(result.report.stages.prove.ok, false);
  assert.match(result.report.stages.prove.stderr, /ALB_CLI_USAGE/);
  assert.equal(result.manifest.stages.prove.stderr, result.report.stages.prove.stderr);
  assert.equal(result.manifest.stages.prove.code, null);
  assert.deepEqual(
    JSON.parse(readFileSync(join(result.bundleDir, "stages", "prove.json"), "utf8")).error,
    { code: "ALB_CLI_USAGE", message: "Simulate accepts one scenario." },
  );
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

test("child-process failures record a diagnostic code and stderr in the bundle", async () => {
  const outputRoot = tempRoot();
  const options = stubOptions(outputRoot, { runId: "stderr-run" });
  delete options.runDecideFn;
  options.runner = () => ({
    status: 1,
    stdout: "",
    stderr: "\u001b[31mconstitutional_agent_testbench: policy schema invalid\u001b[0m\n",
    error: null,
  });
  const result = await runDemo(["--response", "pass"], options);
  assert.equal(result.exitCode, 1);
  assert.equal(result.manifest.stages.decide.status, "error");
  assert.equal(result.manifest.stages.decide.code, DIAGNOSTIC.CHILD_EXIT);
  assert.match(result.report.stages.decide.reason, /decide child process exited with status 1/);
  assert.match(result.report.stages.decide.reason, /policy schema invalid/);
  assert.equal(result.report.stages.decide.code, DIAGNOSTIC.CHILD_EXIT);
  assert.equal(result.report.stages.decide.stderr, "constitutional_agent_testbench: policy schema invalid");
  assert.equal(result.manifest.stages.decide.stderr, result.report.stages.decide.stderr);

  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(String(chunk));
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  try {
    printHuman(result.report, result.bundleDir);
  } finally {
    process.stdout.write = originalWrite;
  }
  const human = chunks.join("");
  assert.match(human, /decide_code: AAS_CHILD_EXIT/);
  assert.match(human, /decide_reason: decide child process exited with status 1/);
  assert.match(human, /decide_stderr: constitutional_agent_testbench: policy schema invalid/);
  assert.match(human, new RegExp(`bundle: ${result.bundleDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
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

test("demo arguments reject unknown, duplicate, missing-value, and empty options", async () => {
  await assert.rejects(() => runDemo(["--unknown"], stubOptions(tempRoot())), /Unsupported/);
  await assert.rejects(() => runDemo(["extra"], stubOptions(tempRoot())), /Unexpected argument/);
  await assert.rejects(() => runDemo(["--response"], stubOptions(tempRoot())), /Missing value/);
  await assert.rejects(() => runDemo(["--fault", ""], stubOptions(tempRoot())), /Empty value/);
  await assert.rejects(() => runDemo(["--response", "   "], stubOptions(tempRoot())), /Empty value/);
  await assert.rejects(
    () => runDemo(["--response", "pass", "--response", "fail"], stubOptions(tempRoot())),
    /Duplicate/,
  );
  await assert.rejects(() => runDemo(["--response", "maybe"], stubOptions(tempRoot())), /must be pass or fail/);
  await assert.rejects(() => runDemo(["--fault", "explode"], stubOptions(tempRoot())), /must be none or duplicate/);
});

test("prove rejects an empty or unknown scenario before spawning a child", () => {
  const runner = () => {
    throw new Error("should not spawn");
  };
  assert.throws(() => runProve("", { runner }), /non-empty scenario/);
  assert.throws(() => runProve("   ", { runner }), /non-empty scenario/);
  assert.throws(() => runProve("all", { runner }), /not supported: all/);
  assert.throws(() => runProve("../operator", { runner }), /not supported/);
  assert.throws(() => runProve("operator;id", { runner }), /not supported/);
});

test("missing child tools fail closed with a bootstrap hint", () => {
  const depsDir = tempRoot();
  assert.throws(
    () => runDecide("unused", { depsDir }),
    /Missing decide CLI \(deps\/constitutional-agent-testbench\/src\/constitutional_agent_testbench\/cli.py\)/,
  );
  assert.throws(
    () => runAct("none", { depsDir }),
    /Missing act CLI \(deps\/consequence-rail\/cmd\/crctl.js\)/,
  );
  assert.throws(
    () => runProve("operator", { depsDir }),
    /Missing prove CLI \(deps\/mandatebound\/dist\/cli.js\)/,
  );
});

async function captureMain(argv, options) {
  const stdout = [];
  const stderr = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalExitCode = process.exitCode;
  process.stdout.write = (chunk, encoding, callback) => {
    stdout.push(String(chunk));
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  process.stderr.write = (chunk, encoding, callback) => {
    stderr.push(String(chunk));
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  process.exitCode = undefined;
  try {
    await main(argv, options);
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode ?? 0 };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = originalExitCode;
  }
}

test("CLI help covers usage, help flags, and exit codes", () => {
  const text = helpText();
  assert.match(text, /aas demo \[--response pass\|fail\]/);
  assert.match(text, /-h, --help/);
  assert.match(text, /simulate --scenario operator/);
  assert.match(text, /AAS_CHILD_TIMEOUT_MS/);
  assert.match(text, /AAS_GUI_PORT/);
  assert.match(text, /Exit codes:/);
});

test("CLI prints help for help tokens and demo --help", async () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"], ["demo", "--help"], ["demo", "-h"]]) {
    const result = await captureMain(argv);
    assert.equal(result.exitCode, 0, `expected help exit 0 for ${JSON.stringify(argv)}`);
    assert.equal(result.stdout, helpText());
    assert.equal(result.stderr, "");
  }
});

test("CLI reports unknown commands, flags, and empty values as usage errors", async () => {
  const unknown = await captureMain(["nope"]);
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown command: nope/);
  assert.match(unknown.stderr, /Try `aas help` for usage/);
  assert.match(unknown.stderr, /Usage:/);

  const flag = await captureMain(["demo", "--wat"]);
  assert.equal(flag.exitCode, 2);
  assert.match(flag.stderr, /Unsupported demo option: --wat/);
  assert.match(flag.stderr, /Try `aas help` for usage/);
  assert.equal(flag.stdout, "");

  const empty = await captureMain(["demo", "--fault", ""]);
  assert.equal(empty.exitCode, 2);
  assert.match(empty.stderr, /Empty value for demo option: --fault/);

  const jsonUsage = await captureMain(["demo", "--unknown", "--json"]);
  assert.equal(jsonUsage.exitCode, 2);
  assert.deepEqual(JSON.parse(jsonUsage.stderr), {
    error: { message: "Unsupported demo option: --unknown" },
  });

  const helpAsValue = await captureMain(["demo", "--response", "--help"]);
  assert.equal(helpAsValue.exitCode, 2);
  assert.match(helpAsValue.stderr, /Missing value for demo option: --response/);

  const badFault = await captureMain(["demo", "--fault", "explode"]);
  assert.equal(badFault.exitCode, 2);
  assert.match(badFault.stderr, /--fault must be none or duplicate/);
  assert.match(badFault.stderr, /Try `aas help` for usage/);
});

test("parsePythonVersion reads a major.minor probe and rejects anything else", () => {
  assert.deepEqual(parsePythonVersion("3.13\n"), [3, 13]);
  assert.deepEqual(parsePythonVersion("  3.11  "), [3, 11]);
  assert.deepEqual(parsePythonVersion("3.9"), [3, 9]);
  assert.equal(parsePythonVersion("3"), null);
  assert.equal(parsePythonVersion("3.11.4"), null);
  assert.equal(parsePythonVersion("Python 3.13.0"), null);
  assert.equal(parsePythonVersion(""), null);
  assert.equal(parsePythonVersion(undefined), null);
  assert.equal(parsePythonVersion("{\"passed\":true}"), null);
});

test("AAS_PYTHON leads the interpreter candidates", () => {
  const candidates = pythonCandidates({ AAS_PYTHON: "  /opt/py/bin/python3.13  " });
  assert.deepEqual(candidates[0], ["/opt/py/bin/python3.13", []]);
  const blank = pythonCandidates({ AAS_PYTHON: "   " });
  assert.equal(blank.some(([bin]) => bin === "   "), false);
});

test("selectPython picks the first interpreter that meets the minimum", () => {
  const selected = selectPython({
    candidates: [["python3", []], ["python3.13", []]],
    runner: (bin) => ({ status: 0, stdout: bin === "python3.13" ? "3.13\n" : "3.9\n", stderr: "", error: null }),
  });
  assert.deepEqual(selected, { bin: "python3.13", prefix: [], version: [3, 13] });
});

test("selectPython skips unavailable and unreadable interpreters", () => {
  const selected = selectPython({
    candidates: [["python3.14", []], ["python3.13", []], ["python3.12", []]],
    runner: (bin) => {
      if (bin === "python3.14") return { status: 0, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
      if (bin === "python3.13") return { status: 1, stdout: "", stderr: "boom", error: null };
      return { status: 0, stdout: "not a version", stderr: "", error: null };
    },
  });
  assert.equal(selected, null);
});

test("selectPython reports an actionable error when every interpreter is too old", () => {
  assert.throws(
    () => selectPython({
      candidates: [["python3", []], ["python", []]],
      runner: () => ({ status: 0, stdout: "3.9\n", stderr: "", error: null }),
    }),
    (error) => {
      assert.match(error.message, new RegExp(`decide stage requires Python ${MIN_PYTHON.join("\\.")}\\+`));
      assert.match(error.message, /found python3 is Python 3\.9, python is Python 3\.9/);
      assert.match(error.message, /set AAS_PYTHON to its interpreter/);
      return true;
    },
  );
});

test("runDecide uses a preselected interpreter instead of probing candidates", () => {
  const calls = [];
  const result = runDecide("unused", {
    python: { bin: "python3.13", prefix: [] },
    runner: (bin, args) => {
      calls.push([bin, args]);
      return { status: 0, stdout: '{"passed": true, "policy_id": "refund-v1", "rule_results": []}\n', stderr: "", error: null };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "python3.13");
  assert.deepEqual(calls[0][1].slice(0, 3), ["-m", "constitutional_agent_testbench.cli", "evaluate"]);
  assert.match(calls[0][1][3], /policy\.json$/u);
  assert.equal(calls[0][1].at(-1), "unused");
});

test("AAS_PYTHON is honored or rejected instead of silently bypassed", () => {
  const selected = selectPython({
    env: { AAS_PYTHON: "/opt/py/bin/python3.13" },
    runner: () => ({ status: 0, stdout: "3.13\n", stderr: "", error: null }),
  });
  assert.deepEqual(selected, { bin: "/opt/py/bin/python3.13", prefix: [], version: [3, 13] });
});

test("AAS_PYTHON rejects an interpreter below the minimum", () => {
  assert.throws(
    () => selectPython({
      env: { AAS_PYTHON: "/usr/bin/python3" },
      candidates: [["python3.13", []]],
      runner: () => ({ status: 0, stdout: "3.9\n", stderr: "", error: null }),
    }),
    (error) => {
      assert.match(error.message, /AAS_PYTHON \(\/usr\/bin\/python3\) is Python 3\.9/);
      assert.match(error.message, /requires Python 3\.11\+/);
      return true;
    },
  );
});

test("AAS_PYTHON rejects an interpreter that cannot report a version", () => {
  assert.throws(
    () => selectPython({
      env: { AAS_PYTHON: "/nope/python" },
      runner: () => ({ status: 1, stdout: "", stderr: "", error: null }),
    }),
    /AAS_PYTHON \(\/nope\/python\) did not report a usable Python version/,
  );
});

test("parseNodeVersion reads release triples and rejects anything else", () => {
  assert.deepEqual(parseNodeVersion("22.12.0"), [22, 12, 0]);
  assert.deepEqual(parseNodeVersion("  24.3.1  "), [24, 3, 1]);
  assert.equal(parseNodeVersion("22.12"), null);
  assert.equal(parseNodeVersion("22.12.0.1"), null);
  assert.equal(parseNodeVersion("v22.12.0"), null);
  assert.equal(parseNodeVersion("22.12.0-nightly20240101"), null);
  assert.equal(parseNodeVersion(""), null);
  assert.equal(parseNodeVersion(undefined), null);
  assert.equal(parseNodeVersion("22.x.0"), null);
});

test("compareVersionTuples orders release triples", () => {
  assert.equal(compareVersionTuples([22, 12, 0], [22, 12, 0]), 0);
  assert.equal(compareVersionTuples([20, 19, 0], [22, 12, 0]), -1);
  assert.equal(compareVersionTuples([22, 11, 9], [22, 12, 0]), -1);
  assert.equal(compareVersionTuples([22, 12, 1], [22, 12, 0]), 1);
  assert.equal(compareVersionTuples([24, 0, 0], [22, 12, 0]), 1);
});

test("full-stack node gate accepts the floor and above, rejects below and unreadable", () => {
  assert.deepEqual(assertFullStackNodeVersion({ version: "22.12.0" }), [22, 12, 0]);
  assert.deepEqual(assertFullStackNodeVersion({ version: "24.11.1" }), [24, 11, 1]);
  assert.deepEqual(assertFullStackNodeVersion({}), parseNodeVersion(process.versions.node));
  for (const version of ["20.19.0", "21.7.3", "22.11.9", "22.12", "not-a-version", "", "  "]) {
    assert.throws(
      () => assertFullStackNodeVersion({ version }),
      (error) => {
        assert.match(error.message, /full-stack workflow requires Node\.js 22\.12\.0\+/);
        assert.match(error.message, /pinned mandatebound declares engines >=22\.12\.0/);
        return true;
      },
      `version ${version} should be rejected`,
    );
  }
});

test("bootstrap refuses an old runtime before creating any dependency directory", () => {
  const root = join(tmpdir(), `agent-action-stack-node-floor-${process.pid}`);
  assert.throws(
    () => prepareDependencies({ root, deps: join(root, "deps"), components: [], nodeVersion: "20.19.0" }),
    /full-stack workflow requires Node\.js 22\.12\.0\+/,
  );
  assert.equal(existsSync(root), false);
});

test("CLI demo rejects an old runtime before selecting Python or running stages", async () => {
  const result = await captureMain(["demo"], { nodeVersion: "20.19.0" });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /full-stack workflow requires Node\.js 22\.12\.0\+/);
  assert.equal(result.stdout, "");
});

function railBundleFixture(overrides = {}) {
  return {
    profile: "audit",
    schema_version: "consequence-rail/settlement-bundle/v0.1",
    action: { action_id: "act_handoff_1", action_digest: `sha256:${"1".repeat(64)}` },
    settlement_receipt: {
      receipt_id: "receipt_handoff_1",
      action_id: "act_handoff_1",
      outcome: "compensated",
      recourse_final_status: "consumed",
      event_chain_head: `sha256:${"2".repeat(64)}`,
      action_digest: `sha256:${"1".repeat(64)}`,
    },
    events: [],
    ...overrides,
  };
}

function railVerificationFixture(overrides = {}) {
  return {
    valid: true,
    action_id: "act_handoff_1",
    outcome: "compensated",
    trusted_key_id: "demo-rail-key",
    trusted_connector_key_id: "demo-connector-key",
    ...overrides,
  };
}

test("buildRailReviewRequest binds bundle bytes, digests, and upstream verdict", () => {
  const bundle = railBundleFixture();
  const { request, digest } = buildRailReviewRequest({ bundle, verification: railVerificationFixture() });
  assert.deepEqual(request.source, { sourceId: "consequence-rail", eventClass: "settlement" });
  assert.equal(request.evidence.mediaType, "application/json");
  assert.equal(request.evidence.digest, digest);
  assert.equal(request.anchors.expectedDigest, digest);
  assert.equal(request.upstream.verifier, "consequence-rail:bundle-verify");
  assert.equal(request.upstream.valid, true);
  assert.equal(request.upstream.actionId, "act_handoff_1");
  assert.equal(request.upstream.outcome, "compensated");
  assert.deepEqual(request.upstream.trustedKeyIds, ["demo-rail-key", "demo-connector-key"]);
});

test("buildRailReviewRequest refuses missing bundles and mismatched verification", () => {
  const bundle = railBundleFixture();
  const verification = railVerificationFixture();
  assert.throws(() => buildRailReviewRequest({ bundle: null, verification }), /act rail bundle/);
  assert.throws(() => buildRailReviewRequest({ bundle: {}, verification }), /act rail bundle with action/);
  assert.throws(() => buildRailReviewRequest({ bundle, verification: { ...verification, valid: false } }), /passing rail bundle verification/);
  assert.throws(
    () => buildRailReviewRequest({ bundle, verification: { ...verification, outcome: "settled" } }),
    /does not match the handed-off rail bundle/,
  );
  assert.throws(
    () => buildRailReviewRequest({ bundle, verification: { ...verification, trusted_key_id: "", trusted_connector_key_id: "" } }),
    /names no trusted keys/,
  );
});

test("validateRailReview accepts bound records and rejects anything else", () => {
  const bundle = railBundleFixture();
  const { digest } = buildRailReviewRequest({ bundle, verification: railVerificationFixture() });
  const review = {
    verdict: "recorded",
    actionId: "act_handoff_1",
    evidenceDigest: digest,
    legalEffect: "not-determined",
  };
  validateRailReview({ review, digest, bundle });
  assert.throws(() => validateRailReview({ review: { ...review, verdict: "conflicting" }, digest, bundle }), /did not record/);
  assert.throws(() => validateRailReview({ review: { ...review, actionId: "act_other" }, digest, bundle }), /not bound/);
  assert.throws(() => validateRailReview({ review: { ...review, evidenceDigest: `sha256:${"0".repeat(64)}` }, digest, bundle }), /not bound/);
  assert.throws(() => validateRailReview({ review: { ...review, legalEffect: "determined" }, digest, bundle }), /legal effect/);
});

test("runProveRail verifies the persisted bytes and binds the review record", () => {
  const bundle = railBundleFixture();
  const { digest } = buildRailReviewRequest({ bundle, verification: railVerificationFixture() });
  const review = {
    verdict: "recorded",
    actionId: "act_handoff_1",
    evidenceDigest: digest,
    legalEffect: "not-determined",
    reviewId: "review-abc",
  };
  const calls = [];
  const runner = (bin, args) => {
    calls.push(args);
    if (args.includes("bundle")) {
      return { status: 0, stdout: `${JSON.stringify(railVerificationFixture())}\n`, stderr: "", error: null };
    }
    return { status: 0, stdout: `${JSON.stringify({ ok: true, result: review })}\n`, stderr: "", error: null };
  };
  const result = runProveRail(bundle, { depsDir: "deps", runner });
  assert.equal(result.ok, true);
  assert.deepEqual(result.raw.result, review);
  assert.ok(calls.some((args) => args.includes("bundle") && args.includes("verify")));
  assert.ok(calls.some((args) => args.includes("review") && args.includes("--input")));
});

test("runProveRail fails closed on verification failure and conflicting reviews", () => {
  const bundle = railBundleFixture();
  const failing = runProveRail(bundle, {
    depsDir: "deps",
    runner: () => ({ status: 1, stdout: '{"valid":false}\n', stderr: "", error: null }),
  });
  assert.equal(failing.ok, false);

  const { digest } = buildRailReviewRequest({ bundle, verification: railVerificationFixture() });
  const conflicting = runProveRail(bundle, {
    depsDir: "deps",
    runner: (bin, args) => {
      if (args.includes("bundle")) {
        return { status: 0, stdout: `${JSON.stringify(railVerificationFixture())}\n`, stderr: "", error: null };
      }
      return { status: 5, stdout: `${JSON.stringify({ ok: false, result: { verdict: "conflicting" } })}\n`, stderr: "", error: null };
    },
  });
  assert.equal(conflicting.ok, false);
  assert.equal(digest.slice(0, 7), "sha256:");

  assert.throws(
    () => runProveRail(null, { depsDir: "deps", runner: () => ({}) }),
    /requires the act stage rail bundle/,
  );
});

test("runAct persists the rail bundle only when asked", () => {
  const bundle = railBundleFixture();
  const calls = [];
  const runner = (bin, args) => {
    calls.push(args);
    const out = args[args.indexOf("--out") + 1];
    if (out) writeFileSync(out, JSON.stringify(bundle));
    return { status: 0, stdout: `${JSON.stringify({ outcome: "compensated", state: "CLOSED", fault: "duplicate" })}\n`, stderr: "", error: null };
  };
  const persisted = runAct("duplicate", { depsDir: "deps", runner, persistRailBundle: true });
  assert.equal(persisted.ok, true);
  assert.deepEqual(persisted.raw.rail_bundle, bundle);
  assert.ok(calls[0].includes("--out"));

  const plain = runAct("duplicate", {
    depsDir: "deps",
    runner: () => ({ status: 0, stdout: `${JSON.stringify({ outcome: "settled", state: "CLOSED" })}\n`, stderr: "", error: null }),
  });
  assert.equal(plain.ok, true);
  assert.equal("rail_bundle" in plain.raw, false);
});

test("demo rail mode records the review binding and fails closed without a bundle", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-action-stack-rail-"));
  const bundle = railBundleFixture();
  const review = {
    verdict: "recorded",
    actionId: "act_handoff_1",
    evidenceDigest: "sha256:bound",
    legalEffect: "not-determined",
    reviewId: "review-abc",
  };
  const bound = await runDemo(["--fault", "duplicate", "--prove", "rail"], {
    ...stubOptions(outputRoot, { runId: "rail-run" }),
    runActFn: async () => ({ ok: true, raw: { outcome: "compensated", state: "CLOSED", fault: "duplicate", action_id: "act_handoff_1", rail_bundle: bundle }, status: 0 }),
    runProveRailFn: async () => ({ ok: true, raw: { ok: true, result: review }, status: 0 }),
  });
  assert.equal(bound.exitCode, 0);
  assert.equal(bound.report.flow, "decide -> act -> prove");
  assert.equal(bound.report.stages.prove.mode, "rail-review");
  assert.equal(bound.report.stages.prove.review_verdict, "recorded");
  assert.equal(bound.report.stages.prove.review_action_id, "act_handoff_1");

  const missing = await runDemo(["--fault", "duplicate", "--prove", "rail"], {
    ...stubOptions(outputRoot, { runId: "rail-missing" }),
    runActFn: async () => ({ ok: true, raw: { outcome: "compensated", state: "CLOSED" }, status: 0 }),
  });
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.report.stages.prove.status, "error");
  assert.match(missing.report.stages.prove.reason, /act stage rail bundle/);
});

test("demo rejects an unknown prove mode", async () => {
  const bad = await captureMain(["demo", "--prove", "canned"]);
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr, /--prove must be simulate or rail/);
});

function replayBundleFixture() {
  const railBundle = {
    profile: "audit",
    action: { action_id: "act_replay_1", action_digest: `sha256:${"1".repeat(64)}` },
    settlement_receipt: {
      receipt_id: "receipt_replay_1",
      action_id: "act_replay_1",
      outcome: "compensated",
      recourse_final_status: "consumed",
      event_chain_head: `sha256:${"2".repeat(64)}`,
      action_digest: `sha256:${"1".repeat(64)}`,
    },
    events: [],
  };
  const bundleBytes = Buffer.from(JSON.stringify(railBundle), "utf8");
  const digest = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;
  return { railBundle, digest };
}

function replayRunnerFixture(verification, review) {
  return (bin, args) => {
    if (args.includes("bundle")) {
      return { status: 0, stdout: `${JSON.stringify(verification)}\n`, stderr: "", error: null };
    }
    return { status: 0, stdout: `${JSON.stringify({ ok: true, result: review })}\n`, stderr: "", error: null };
  };
}

test("export reads the persisted run bundle", async () => {
  const outputRoot = tempRoot();
  const run = await runDemo(["--response", "pass"], stubOptions(outputRoot, { runId: "export-run" }));
  assert.equal(run.exitCode, 0);
  const exported = exportRunBundle("export-run", { outputRoot });
  assert.equal(exported.report.run_id, "export-run");
  assert.deepEqual(Object.keys(exported.stages).sort(), ["act", "decide"]);
  assert.throws(() => exportRunBundle("no-such-run", { outputRoot }), /Invalid run id|ENOENT/);
  assert.throws(() => exportRunBundle("../escape", { outputRoot }), /Invalid run id/);
});

test("replay agrees on an intact export and names every check", () => {
  const { railBundle, digest } = replayBundleFixture();
  const review = {
    verdict: "recorded",
    reviewId: "review-replay-1",
    actionId: "act_replay_1",
    evidenceDigest: digest,
    legalEffect: "not-determined",
    receipt: { outcome: "compensated" },
    upstream: { valid: true, verifier: "consequence-rail:bundle-verify", outcome: "compensated", trustedKeyIds: ["k"] },
    reviewDigest: "sha256:replayed",
  };
  const verification = { valid: true, action_id: "act_replay_1", outcome: "compensated", trusted_key_id: "k", trusted_connector_key_id: "c" };
  const bundleDoc = {
    report: { run_id: "run-replay-1" },
    stages: { act: { action_id: "act_replay_1", rail_bundle: railBundle }, prove: { result: review } },
  };
  const result = replayBundle(bundleDoc, { depsDir: "deps", runner: replayRunnerFixture(verification, { ...review }) });
  assert.equal(result.ok, true);
  assert.equal(result.runId, "run-replay-1");
  assert.deepEqual(result.checks.map((check) => check.name), [
    "evidence-available",
    "identity-binding",
    "digest-binding",
    "rail-verification",
    "review-request",
    "review-replay",
  ]);
  assert.ok(result.checks.every((check) => check.passed));
});

test("replay reports unavailable evidence and conflicts explicitly", () => {
  const { railBundle } = replayBundleFixture();
  const never = () => { throw new Error("must not spawn children"); };
  const simulate = replayBundle({ report: { run_id: "r" }, stages: { act: {}, prove: { status: "skipped" } } }, { runner: never });
  assert.equal(simulate.ok, false);
  assert.match(simulate.reason, /^unavailable:/);

  const noReview = replayBundle(
    { report: { run_id: "r" }, stages: { act: { action_id: "a", rail_bundle: railBundle }, prove: {} } },
    { runner: never },
  );
  assert.equal(noReview.ok, false);
  assert.match(noReview.reason, /^unavailable:/);

  const tampered = JSON.parse(JSON.stringify(railBundle));
  tampered.settlement_receipt.outcome = "settled";
  const review = { verdict: "recorded", actionId: "act_replay_1", evidenceDigest: "sha256:stale", legalEffect: "not-determined", upstream: {} };
  const conflict = replayBundle(
    { report: { run_id: "r" }, stages: { act: { action_id: "act_replay_1", rail_bundle: tampered }, prove: { result: review } } },
    { runner: never },
  );
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /^conflicting:/);

  const badDoc = replayBundle(null, { runner: never });
  assert.equal(badDoc.ok, false);
});

test("replay fails closed when child verification rejects the bytes", () => {
  const { railBundle, digest } = replayBundleFixture();
  const review = { verdict: "recorded", actionId: "act_replay_1", evidenceDigest: digest, legalEffect: "not-determined", upstream: { outcome: "compensated" } };
  const bundleDoc = {
    report: { run_id: "r" },
    stages: { act: { action_id: "act_replay_1", rail_bundle: railBundle }, prove: { result: review } },
  };
  const rejected = replayBundle(bundleDoc, {
    depsDir: "deps",
    runner: () => ({ status: 1, stdout: '{"valid":false}\n', stderr: "", error: null }),
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /unsupported/);
});

test("export and replay CLI validate arguments and missing files", async () => {
  const noRun = await captureMain(["export", "no-such-run"]);
  assert.equal(noRun.exitCode, 1);
  const noArgs = await captureMain(["export"]);
  assert.equal(noArgs.exitCode, 2);
  const twoRuns = await captureMain(["export", "a", "b"]);
  assert.equal(twoRuns.exitCode, 2);
  const missing = await captureMain(["replay", "/tmp/aas-no-such-bundle.json"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /cannot read bundle file/);
  const noSource = await captureMain(["replay"]);
  assert.equal(noSource.exitCode, 2);
  const extra = await captureMain(["replay", "a", "b"]);
  assert.equal(extra.exitCode, 2);
});

async function makeRuns(outputRoot, count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const runId = `2026-09-06T050000000Z-run${String(index).padStart(2, "0")}`;
    const result = await runDemo(["--response", "pass"], stubOptions(outputRoot, { runId }));
    assert.equal(result.exitCode, 0);
    ids.push(runId);
  }
  return ids;
}

test("runs lists persisted runs newest-first", async () => {
  const outputRoot = tempRoot();
  assert.deepEqual(listRuns({ outputRoot }), []);
  const ids = await makeRuns(outputRoot, 3);
  const listed = listRuns({ outputRoot });
  assert.deepEqual(listed.map((run) => run.run_id), [...ids].reverse());
  assert.equal(listed[0].stages.decide, "passed");
  assert.equal(listed[0].exit_code, 0);
});

test("prune keeps the newest runs and never the latest pointer target", async () => {
  const outputRoot = tempRoot();
  const ids = await makeRuns(outputRoot, 5);
  const preview = pruneRuns({ outputRoot, keep: 2, dryRun: true });
  assert.deepEqual(preview.removed.sort(), [ids[0], ids[1], ids[2]].sort());
  assert.equal(listRuns({ outputRoot }).length, 5);
  const done = pruneRuns({ outputRoot, keep: 2 });
  assert.deepEqual(done.removed.sort(), [ids[0], ids[1], ids[2]].sort());
  assert.deepEqual(listRuns({ outputRoot }).map((run) => run.run_id).sort(), [ids[3], ids[4]].sort());
  const exported = exportRunBundle(ids[4], { outputRoot });
  assert.equal(exported.report.run_id, ids[4]);
});

test("prune protects the latest pointer target beyond the keep window", async () => {
  const outputRoot = tempRoot();
  const ids = await makeRuns(outputRoot, 3);
  writeFileSync(join(outputRoot, "latest.json"), `${JSON.stringify({ run_id: ids[0], manifest: `runs/${ids[0]}/manifest.json` })}\n`);
  const done = pruneRuns({ outputRoot, keep: 1 });
  assert.deepEqual(done.removed, [ids[1]]);
  assert.deepEqual(listRuns({ outputRoot }).map((run) => run.run_id).sort(), [ids[0], ids[2]].sort());
});

test("prune validates input and handles empty stores", async () => {
  const outputRoot = tempRoot();
  assert.throws(() => pruneRuns({ outputRoot }), /positive integer/);
  assert.throws(() => pruneRuns({ outputRoot, keep: 0 }), /positive integer/);
  assert.throws(() => pruneRuns({ outputRoot, keep: -2 }), /positive integer/);
  assert.throws(() => pruneRuns({ outputRoot, keep: 1.5 }), /positive integer/);
  assert.deepEqual(pruneRuns({ outputRoot, keep: 5 }), { kept: [], removed: [], latest: null, dryRun: false });
});

test("runs and prune CLI commands validate arguments", async () => {
  const listed = await captureMain(["runs"]);
  assert.equal(listed.exitCode, 0);
  const junk = await captureMain(["runs", "--bogus"]);
  assert.equal(junk.exitCode, 2);
  const missing = await captureMain(["prune"]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /Usage: aas prune/);
  const zero = await captureMain(["prune", "--keep", "0"]);
  assert.equal(zero.exitCode, 2);
  const words = await captureMain(["prune", "--keep", "many"]);
  assert.equal(words.exitCode, 2);
});

test("replay reads piped bundles from stdin without touching the filesystem", async () => {
  const doc = {
    report: { run_id: "stdin-run" },
    stages: { act: { action_id: "a" }, prove: { status: "skipped" } },
  };
  const piped = await captureMain(["replay", "-"], { stdin: Readable.from([JSON.stringify(doc)]) });
  assert.equal(piped.exitCode, 1);
  assert.match(piped.stdout, /replay: failed/);
  assert.match(piped.stdout, /unavailable: this run persisted no rail bundle/);

  const tty = await captureMain(["replay", "-"], { stdin: Object.assign(Readable.from(["{}"]), { isTTY: true }) });
  assert.equal(tty.exitCode, 2);
  assert.match(tty.stderr, /reads stdin only from a pipe/);

  const big = await captureMain(["replay", "-"], { stdin: Readable.from([`{"pad":"${"x".repeat(2 * 1024 * 1024)}"}`]) });
  assert.equal(big.exitCode, 1);
  assert.match(big.stderr, /exceeds the .* byte limit/);
});
