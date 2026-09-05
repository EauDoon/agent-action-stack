import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadComponentLock, inspectDependencyDirectory, npmInvocation } from "../scripts/bootstrap.mjs";
import {
  CHILD_JSON_LIMIT,
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
  runDecide,
  runDemo,
  runProve,
  selectPython,
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

async function captureMain(argv) {
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
    await main(argv);
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
