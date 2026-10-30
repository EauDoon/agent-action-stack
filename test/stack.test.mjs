import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFullStackNodeVersion, classifyDependency, compareVersionTuples, isEntrypoint, loadComponentLock, inspectDependencyDirectory, main as bootstrapMain, parseBootstrapArgs, readCheckoutCommit, MIN_FULL_STACK_NODE, moveIntoPlace, npmInvocation, parseNodeVersion, prepareDependencies } from "../scripts/bootstrap.mjs";
import { checkSyntax, listSyntaxTargets } from "../scripts/check-syntax.mjs";
import { verifierRevisions, verifyCasePage } from "../bin/case-review.mjs";
import { checkReleaseConsistency, loadReleaseInputs, parseChangelog, releaseNotes } from "../scripts/check-version.mjs";
import {
  buildRailReviewRequest,
  DEMO_FAULTS_BY_DOMAIN,
  NO_RECEIPT_FAULTS,
  parseDemoOptions,
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
  stackVersion,
  compareRuns,
  listRunSummaries,
  listRuns,
  pruneRuns,
  summarizeRun,
  validateRailReview,
  writeAtomicFile,
} from "../bin/aas.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOCK = join(ROOT, "stack-lock.json");
const PROVENANCE = [
  {
    name: "constitutional-agent-testbench",
    repository: "https://github.com/EauDoon/constitutional-agent-testbench.git",
    commit: "ed46f0cb9af400560aa9a9e73bbb9864ed5678a0",
    origin: "https://github.com/EauDoon/constitutional-agent-testbench.git",
    detached: true,
    clean: true,
    entrypoints: ["pyproject.toml", "src/constitutional_agent_testbench/cli.py"],
  },
  {
    name: "consequence-rail",
    repository: "https://github.com/EauDoon/consequence-rail.git",
    commit: "78d6f8a23dbce69bb443b453c8d471645f67daac",
    origin: "https://github.com/EauDoon/consequence-rail.git",
    detached: true,
    clean: true,
    entrypoints: ["package.json", "cmd/crctl.js"],
  },
  {
    name: "mandatebound",
    repository: "https://github.com/EauDoon/mandatebound.git",
    commit: "32d525618e23678f86c754e4a536e4d094988a1b",
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

test("lock rejects install and build steps prepareDependencies cannot dispatch", () => {
  const base = JSON.parse(readFileSync(LOCK, "utf8"));
  const write = (mutate) => {
    const copy = structuredClone(base);
    mutate(copy);
    const path = join(tempRoot(), "stack-lock.json");
    writeFileSync(path, `${JSON.stringify(copy)}\n`);
    return path;
  };
  for (const [field, value] of [["install", "npm ci"], ["install", "npm-CI"], ["build", "npm run build"], ["build", "tsc"]]) {
    assert.throws(
      () => loadComponentLock(write((copy) => { copy.components[2][field] = value; })),
      new RegExp(`unsupported ${field} step: ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  }
  // The shipped lock must keep loading, and the supported spellings must still
  // be accepted.
  assert.equal(loadComponentLock(LOCK)[2].install, "npm-ci");
  assert.equal(loadComponentLock(write((copy) => { copy.components[2].build = "npm-run-build"; }))[2].build, "npm-run-build");
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

/**
 * A fake git that clones into whatever directory `init` names. `failOn` makes
 * that subcommand exit 128, as a dropped network or Ctrl+C during fetch would.
 */
function fakeGit(component, { failOn = null } = {}) {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, ...args]);
    assert.equal(name, "git", `bootstrap must not spawn ${name} for a component without install or build`);
    const sub = args[0] === "-C" ? args[2] : args[0];
    if (sub === failOn) return { status: 128, stdout: "", stderr: "fatal: unable to access", error: null };
    if (sub === "init") {
      mkdirSync(join(args.at(-1), ".git"), { recursive: true });
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    if (sub === "remote" || sub === "fetch") return { status: 0, stdout: "", stderr: "", error: null };
    if (sub === "checkout") {
      for (const entrypoint of component.expected_entrypoints) {
        mkdirSync(join(args[1], entrypoint, ".."), { recursive: true });
        writeFileSync(join(args[1], entrypoint), "fixture\n");
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    if (sub === "config") return { status: 0, stdout: `${component.repository}\n`, stderr: "", error: null };
    if (sub === "rev-parse") return { status: 0, stdout: `${component.commit}\n`, stderr: "", error: null };
    if (sub === "symbolic-ref") return { status: 1, stdout: "", stderr: "", error: null };
    if (sub === "status") return { status: 0, stdout: "", stderr: "", error: null };
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
  return { command, calls };
}

test("bootstrap stages a clone so a failed fetch leaves nothing in deps", () => {
  // The testbench has no install or build step, so no npm runs.
  const component = loadComponentLock(LOCK).find((entry) => entry.name === "constitutional-agent-testbench");
  const deps = tempRoot();
  const failing = fakeGit(component, { failOn: "fetch" });
  assert.throws(
    () => prepareDependencies({ deps, components: [component], command: failing.command }),
    new RegExp(`^Error: Could not prepare constitutional-agent-testbench at ${component.commit}: Command failed: git .* fetch .*\\(exit 128\\): fatal: unable to access\\. Nothing was left in deps/; rerun npm run bootstrap\\.$`),
  );
  assert.equal(existsSync(join(deps, component.name)), false);
  assert.deepEqual(readdirSync(deps), []);
  // The clone ran in a hidden staging directory, never in the final target.
  // Its name is shorter than every component name, so the clone never needs
  // a longer path than the final checkout (Git for Windows stops at 260).
  const init = failing.calls.find((call) => call[1] === "init");
  assert.match(init.at(-1), /[\\/]\.tmp-[A-Za-z0-9]{6}$/);
  const stagingName = init.at(-1).split(/[\\/]/).at(-1);
  for (const entry of loadComponentLock(LOCK)) assert.ok(stagingName.length < entry.name.length, entry.name);

  // The next run is not wedged by the failure.
  const working = fakeGit(component);
  const prepared = prepareDependencies({ deps, components: [component], command: working.command });
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].commit, component.commit);
  assert.equal(prepared[0].detached, true);
  assert.equal(prepared[0].clean, true);
  assert.ok(existsSync(join(deps, component.name, ".git")));
  assert.ok(existsSync(join(deps, component.name, "src", "constitutional_agent_testbench", "cli.py")));
  assert.deepEqual(readdirSync(deps), [component.name]);
});

test("bootstrap retries a briefly locked rename and reports failures without a stack trace", () => {
  let attempts = 0;
  moveIntoPlace("staging", "target", {
    delayMs: 1,
    rename: () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
    },
  });
  assert.equal(attempts, 3);
  attempts = 0;
  assert.throws(() => moveIntoPlace("staging", "target", {
    delayMs: 1,
    rename: () => { attempts += 1; throw Object.assign(new Error("denied"), { code: "EPERM" }); },
  }), /denied/);
  assert.equal(attempts, 4, "one attempt plus three retries");
  attempts = 0;
  assert.throws(() => moveIntoPlace("staging", "target", {
    rename: () => { attempts += 1; throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" }); },
  }), /not empty/);
  assert.equal(attempts, 1, "other errors are not retried");

  // A half-initialized checkout left by an older bootstrap names the fix.
  const component = loadComponentLock(LOCK)[0];
  const target = join(tempRoot(), component.name);
  mkdirSync(join(target, ".git"), { recursive: true });
  const broken = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository", error: null });
  assert.throws(() => inspectDependencyDirectory(target, component, { command: broken }),
    new RegExp(`Refusing unusable pre-existing dependency: ${component.name}\\. Remove deps/${component.name} and rerun npm run bootstrap\\.`));

  const stderr = [];
  const originalStderr = process.stderr.write;
  const originalExitCode = process.exitCode;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  let exitCode;
  try {
    bootstrapMain({ deps: tempRoot(), components: [component], command: fakeGit(component, { failOn: "fetch" }).command });
    exitCode = process.exitCode;
  } finally {
    process.stderr.write = originalStderr;
    process.exitCode = originalExitCode;
  }
  assert.equal(exitCode, 1);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /^bootstrap failed: Could not prepare constitutional-agent-testbench at [0-9a-f]{40}: .*rerun npm run bootstrap\.\n$/);
  assert.doesNotMatch(stderr[0], /\n\s+at /);
});

// Windows only permits symlink creation for elevated or Developer Mode
// processes. Where the platform refuses, skip rather than report a false
// failure; the Linux CI runners still exercise these paths.
function linkOrSkip(t, target, path, type) {
  try {
    symlinkSync(target, path, type);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("symlinks are unavailable on this platform");
      return false;
    }
    throw error;
  }
  return true;
}

test("pre-existing dependency symlinks are rejected", (t) => {
  const component = loadComponentLock(LOCK)[1];
  const fixture = fakeDependency(component);
  const link = join(tempRoot(), component.name);
  if (!linkOrSkip(t, fixture.target, link)) return;
  assert.throws(
    () => inspectDependencyDirectory(link, component, { command: fixture.command }),
    /regular directory/,
  );
});

test("a symlinked dependency directory is not used as the checkout root", (t) => {
  const outside = tempRoot();
  const marker = join(outside, "keep.txt");
  writeFileSync(marker, "keep");
  const project = tempRoot();
  const link = join(project, "deps");
  if (!linkOrSkip(t, outside, link)) return;
  assert.throws(
    () => prepareDependencies({ root: project, deps: link, components: [] }),
    /regular directory/,
  );
  assert.throws(
    () => resolveComponentProvenance(link, LOCK),
    /regular directory/,
  );
  assert.equal(readFileSync(marker, "utf8"), "keep");
  assert.equal(existsSync(join(outside, ".git")), false);
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

test("act removes its rail scratch directory even when the runner throws", () => {
  const countScratch = () => readdirSync(tmpdir()).filter((name) => name.startsWith("aas-act-")).length;
  const before = countScratch();
  assert.throws(
    () => runAct("duplicate", {
      depsDir: tempRoot(),
      persistRailBundle: true,
      runner: () => { throw new Error("runner exploded before returning"); },
    }),
    /runner exploded/,
  );
  assert.equal(countScratch(), before);
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

test("runCapture keeps shell disabled and the stdout cap caller options cannot override", () => {
  const shelled = runCapture("echo ok", [], { shell: true, timeout: 5000 });
  assert.notEqual(shelled.status, 0);
  assert.ok(shelled.error);
  const capped = runCapture(process.execPath, ["-e", "process.stdout.write('x'.repeat(80))"], { maxBuffer: 20, timeout: 5000 });
  assert.equal(capped.error, undefined);
  assert.equal(capped.status, 0);
  assert.equal(capped.stdout, "x".repeat(80));
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

test("structured act failure (ok:false with parseable JSON) records the act stage as failed and skips prove", async () => {
  const outputRoot = tempRoot();
  const options = stubOptions(outputRoot, { runId: "act-fail-run" });
  options.runActFn = async () => ({
    ok: false,
    raw: { outcome: null, state: "UNKNOWN", error: { code: "RECEIPT_FAILED", message: "rail failed" } },
    status: 1,
    stderr: "rail: failure",
  });
  const result = await runDemo(["--response", "pass", "--fault", "duplicate"], options);
  assert.equal(result.exitCode, 1);
  assert.equal(result.manifest.stages.act.status, "failed");
  assert.equal(result.report.stages.act.status, "failed");
  assert.equal(result.manifest.exit_code, 1);
  assert.equal(result.manifest.stages.prove.status, "skipped");
  assert.equal(result.report.stages.prove.reason, "act_failed");
  assert.equal(result.report.flow, "decide -> act -> stop (act failed)");
  // A structured act failure still carries the child's stderr. Dropping it
  // makes the report and the human output look successful-but-silent.
  assert.equal(result.report.stages.act.stderr, "rail: failure");
  assert.equal(result.manifest.stages.act.stderr, result.report.stages.act.stderr);
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
  // report.json and manifest.json must give the same reason for one run.
  assert.equal(actError.report.stages.prove.status, "skipped");
  assert.equal(actError.report.stages.prove.reason, "act_error");
  const persistedReport = JSON.parse(readFileSync(join(actError.bundleDir, "report.json"), "utf8"));
  assert.equal(persistedReport.stages.prove.reason, actError.manifest.stages.prove.reason);
  assert.ok(!("raw" in persistedReport.stages.prove));

  const proveOutputRoot = tempRoot();
  const proveError = await runDemo(["--response", "pass", "--dispute"], stubOptions(proveOutputRoot, {
    runId: "prove-error-run",
    runProveFn: async () => { throw new Error("prove child process error (EPIPE)"); },
  }));
  assert.equal(proveError.exitCode, 1);
  assert.equal(proveError.manifest.stages.prove.status, "error");
  assert.match(proveError.report.stages.prove.reason, /EPIPE/);
  // A prove failure must not erase the act result the report already holds.
  assert.equal(proveError.report.stages.act.status, "passed");
  assert.equal(proveError.report.stages.act.outcome, "settled");
  assert.equal(proveError.report.stages.act.action_id, "act-1");
  assert.ok(!("raw" in proveError.report.stages.act));
});

test("atomic writes leave no partial target or temporary file after a write failure", () => {
  const outputRoot = tempRoot();
  const target = join(outputRoot, "atomic", "manifest.json");
  mkdirSync(join(outputRoot, "atomic"));
  writeFileSync(target, "original evidence");
  assert.throws(() => writeAtomicFile(target, "payload", {
    writeFile: (fd) => {
      writeFileSync(fd, "partial evidence");
      throw new Error("simulated partial write");
    },
  }), /partial write/);
  assert.equal(readFileSync(target, "utf8"), "original evidence");
  assert.deepEqual(readdirSync(join(outputRoot, "atomic")), ["manifest.json"]);
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
  await assert.rejects(() => runDemo(["--fault", "explode"], stubOptions(tempRoot())), /--fault must be one of the refund faults: none, duplicate, /);
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

test("CLI help documents every command and every option the usage block names", () => {
  const text = helpText();
  const usage = text.split("Usage:")[1].split("Commands:")[0];
  const commands = text.split("Commands:")[1].split("Options:")[0];
  const options = text.split("Options:")[1].split("Flow:")[0];
  for (const command of ["demo", "export", "replay", "verify", "latest", "runs", "cases", "compare", "prune", "help"]) {
    assert.match(usage, new RegExp(`^ {2}aas ${command}(?: |$)`, "m"), `usage block is missing ${command}`);
    assert.match(commands, new RegExp(`^ {2}${command} +\\S`, "m"), `command list is missing ${command}`);
  }
  // Every long option a usage line accepts must also appear in the reference
  // block, so a flag cannot be usable but undocumented.
  for (const [, option] of usage.matchAll(/(--[a-z][a-z-]*)/g)) {
    assert.ok(options.includes(option), `option block does not document ${option}`);
  }
  // Every saved-case command accepts --root through parseRootArgs or
  // parseInspectArgs, so its usage line and the --root reference say so.
  const rootReference = options.split("--root output-dir")[1].split(/\n {2}--/)[0];
  for (const command of ["latest", "verify", "inspect", "runs", "cases", "compare", "export", "prune"]) {
    assert.match(usage, new RegExp(`^ {2}aas ${command} .*\\[--root output-dir\\]`, "m"), `${command} usage omits --root`);
    assert.match(rootReference, new RegExp(`\\b${command}\\b`), `--root reference omits ${command}`);
  }
  const flow = text.split("Flow:")[1].split("First-time setup:")[0];
  assert.match(flow, /on pass -> consequence-rail demo <domain>/);
});

test("export and prune usage errors name the --root option", async () => {
  const exportUsage = await captureMain(["export"]);
  assert.equal(exportUsage.exitCode, 2);
  assert.match(exportUsage.stderr, /Usage: aas export <run-id> \[--root output-dir\]/);
  const pruneUsage = await captureMain(["prune"]);
  assert.equal(pruneUsage.exitCode, 2);
  assert.match(pruneUsage.stderr, /Usage: aas prune --keep <positive integer> \[--root output-dir\]/);
  const pruneOption = await captureMain(["prune", "--keep", "1", "--bogus"]);
  assert.equal(pruneOption.exitCode, 2);
  assert.match(pruneOption.stderr, /expected --keep <n> \[--root output-dir\] \[--dry-run\] \[--json\]/);
});

test("CLI prints help for help tokens and demo --help", async () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"], ["demo", "--help"], ["demo", "-h"]]) {
    const result = await captureMain(argv);
    assert.equal(result.exitCode, 0, `expected help exit 0 for ${JSON.stringify(argv)}`);
    assert.equal(result.stdout, helpText());
    assert.equal(result.stderr, "");
  }
});

test("entrypoints run when launched through a linked directory", (t) => {
  // npm installs `bin.aas` as a symlink, and `npm link`, a macOS /tmp checkout,
  // or a Windows junction all reach the scripts through a link. A junction
  // needs no privilege on Windows; POSIX ignores the type and makes a
  // directory symlink.
  const link = join(tempRoot(), "linked-bin");
  if (!linkOrSkip(t, join(ROOT, "bin"), link, "junction")) return;
  const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });

  const help = run([join(link, "aas.mjs"), "help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout, helpText());

  const unknown = run([join(link, "aas.mjs"), "no-such-command"]);
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /Unknown command: no-such-command/);

  const smoke = run([join(link, "aas-gui.mjs"), "--smoke-test"]);
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.match(smoke.stdout, /GUI smoke test passed/);
});

test("isEntrypoint compares resolved paths and fails closed", () => {
  const script = join(ROOT, "bin", "aas.mjs");
  const url = pathToFileURL(script).href;
  assert.equal(isEntrypoint(url, script), true);
  assert.equal(isEntrypoint(url, undefined), false);
  assert.equal(isEntrypoint(url, ""), false);
  assert.equal(isEntrypoint(url, join(ROOT, "package.json")), false);
  assert.equal(isEntrypoint(url, join(tempRoot(), "missing.mjs")), false);
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
  assert.match(badFault.stderr, /--fault must be one of the refund faults: none, duplicate, /);
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

test("runAct rejects a rail bundle file past the child output cap", () => {
  const runner = (_bin, args) => {
    const out = args[args.indexOf("--out") + 1];
    writeFileSync(out, Buffer.alloc(CHILD_JSON_LIMIT + 1, 0x78));
    return { status: 0, stdout: '{"outcome":"settled","state":"CLOSED","fault":"none","action_id":"a"}\n', stderr: "", error: null };
  };
  assert.throws(
    () => runAct("none", { depsDir: "deps", runner, persistRailBundle: true }),
    /byte limit/,
  );
});

test("runAct does not follow a symlinked rail bundle file", (t) => {
  const probe = tempRoot();
  if (!linkOrSkip(t, join(probe, "missing"), join(probe, "link"))) return;
  const runner = (_bin, args) => {
    const out = args[args.indexOf("--out") + 1];
    const target = join(out, "..", "target.json");
    writeFileSync(target, JSON.stringify({ action: { action_id: "leaked" }, settlement_receipt: { outcome: "settled" } }));
    symlinkSync(target, out);
    return { status: 0, stdout: '{"outcome":"settled","state":"CLOSED","fault":"none","action_id":"a"}\n', stderr: "", error: null };
  };
  assert.throws(
    () => runAct("none", { depsDir: "deps", runner, persistRailBundle: true }),
    /symbolic link/,
  );
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
  assert.throws(() => exportRunBundle("no-such-run", { outputRoot }), (error) => {
    assert.equal(error.message, "Saved case not found: no-such-run");
    assert.equal(error.code, "ENOENT");
    return true;
  });
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

test("replay binds every recorded review field, not just its copied digest", async (t) => {
  const { railBundle, digest } = replayBundleFixture();
  const review = {
    format: "MandateBoundExternalEvidenceReview/v1",
    verdict: "recorded",
    reviewId: "review-replay-1",
    source: { sourceId: "consequence-rail", eventClass: "settlement" },
    actionId: "act_replay_1",
    evidenceDigest: digest,
    legalEffect: "not-determined",
    receipt: { receiptId: "receipt_replay_1", outcome: "compensated", recourseStatus: "consumed" },
    upstream: { valid: true, verifier: "consequence-rail:bundle-verify", outcome: "compensated", trustedKeyIds: ["k", "c"] },
    reviewDigest: "sha256:replayed",
  };
  const verification = { valid: true, action_id: "act_replay_1", outcome: "compensated", trusted_key_id: "k", trusted_connector_key_id: "c" };
  const replay = (recorded) => replayBundle({
    report: { run_id: "run-replay-1" },
    stages: { act: { action_id: "act_replay_1", rail_bundle: railBundle }, prove: { result: recorded } },
  }, { runner: replayRunnerFixture(verification, review) });
  const mutations = {
    "legal effect": (value) => { value.legalEffect = "legally-binding"; },
    "receipt outcome": (value) => { value.receipt.outcome = "settled"; },
    "receipt identity": (value) => { value.receipt.receiptId = "substituted"; },
    "recourse status": (value) => { value.receipt.recourseStatus = "released"; },
    "trust keys": (value) => { value.upstream.trustedKeyIds = ["substituted"]; },
    "trust key order": (value) => { value.upstream.trustedKeyIds.reverse(); },
    "verifier": (value) => { value.upstream.verifier = "substituted"; },
    "upstream verdict": (value) => { value.upstream.valid = false; },
    "source": (value) => { value.source.sourceId = "substituted"; },
    "review identity": (value) => { value.reviewId = "substituted"; },
    "format": (value) => { value.format = "unsupported"; },
    "missing field": (value) => { delete value.receipt; },
    "extra field": (value) => { value.sourceTruth = "verified"; },
    "extra nested field": (value) => { value.receipt.realWorldReversal = true; },
    "digest": (value) => { value.reviewDigest = "sha256:substituted"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const recorded = structuredClone(review);
      mutate(recorded);
      const result = replay(recorded);
      assert.equal(result.ok, false);
      assert.match(result.reason, /^conflicting:/);
      assert.equal(result.checks.at(-1).name, "review-replay");
      assert.equal(result.checks.at(-1).passed, false);
      assert.ok(result.checks.slice(0, -1).every((check) => check.passed));
    });
  }
  const reordered = JSON.parse(JSON.stringify(review, null, 4));
  reordered.upstream = Object.fromEntries(Object.entries(reordered.upstream).reverse());
  assert.equal(replay(Object.fromEntries(Object.entries(reordered).reverse())).ok, true,
    "JSON formatting and object property order do not change a review");
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

test("demo usage errors exit 2 before any runtime probing", async () => {
  // A broken interpreter override used to win: main probed Node.js and every
  // Python candidate first, so a typo exited 1 with an AAS_PYTHON message.
  await withEnv("AAS_PYTHON", "aas-synthetic-missing-python", async () => {
    const bogus = await captureMain(["demo", "--bogus"]);
    assert.equal(bogus.exitCode, 2);
    assert.match(bogus.stderr, /Unsupported demo option: --bogus/);
    assert.doesNotMatch(bogus.stderr, /AAS_PYTHON/);

    const value = await captureMain(["demo", "--response", "maybe"]);
    assert.equal(value.exitCode, 2);
    assert.match(value.stderr, /--response must be pass or fail/);
    assert.doesNotMatch(value.stderr, /AAS_PYTHON/);

    const domain = await captureMain(["demo", "--domain", "payroll", "--json"]);
    assert.equal(domain.exitCode, 2);
    assert.deepEqual(JSON.parse(domain.stderr), { error: { message: "--domain must be refund or inventory" } });

    // Valid arguments still reach the interpreter check and fail there.
    const valid = await captureMain(["demo", "--response", "fail"]);
    assert.equal(valid.exitCode, 1);
    assert.match(valid.stderr, /AAS_PYTHON \(aas-synthetic-missing-python\)/);
  });
});

test("saved-case commands name a missing case without the local path", async () => {
  const outputRoot = tempRoot();
  mkdirSync(join(outputRoot, "runs"));
  for (const argv of [
    ["export", "missing-id", "--json", "--root", outputRoot],
    ["verify", "missing-id", "--json", "--root", outputRoot],
    ["inspect", "missing-id", "--json", "--root", outputRoot],
  ]) {
    const result = await captureMain(argv);
    assert.equal(result.exitCode, 1, `${argv[0]} exit code`);
    assert.deepEqual(JSON.parse(result.stderr), { error: { message: "Saved case not found: missing-id", code: "ENOENT" } }, argv[0]);
    assert.ok(!result.stderr.includes(outputRoot), `${argv[0]} printed the local path`);
  }

  // A case directory that lost its manifest is reported by name, not by path.
  mkdirSync(join(outputRoot, "runs", "torn-run"));
  const torn = await captureMain(["export", "torn-run", "--root", outputRoot]);
  assert.equal(torn.exitCode, 1);
  assert.match(torn.stderr, /^Saved case torn-run is missing manifest\.json\.\ncode: ENOENT\n$/);
  assert.ok(!torn.stderr.includes(outputRoot));
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

test("case summaries stay summary-only and expose supported identities", async () => {
  const outputRoot = tempRoot();
  const ids = await makeRuns(outputRoot, 1);
  const summary = summarizeRun(ids[0], { outputRoot });
  assert.equal(summary.run_id, ids[0]);
  assert.equal(summary.schema_version, "agent-action-stack.run/v1");
  assert.equal(summary.outcome, "settled");
  assert.equal(summary.policy_id, "refund-v1");
  assert.ok(Array.isArray(summary.components) && summary.components.length > 0);
  assert.equal(summary.review_verdict, null);
  assert.equal(summary.evidence_digest, null);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /rule_results|rail_bundle|"events"/);
  assert.throws(() => summarizeRun("../escape", { outputRoot }), /Invalid run id/);
});

test("history is bounded and skips unreadable cases", async () => {
  const outputRoot = tempRoot();
  const ids = await makeRuns(outputRoot, 3);
  const runsDir = join(outputRoot, "runs");
  mkdirSync(join(runsDir, "2026-09-06T050000000Z-broken"), { recursive: true });
  writeFileSync(join(runsDir, "2026-09-06T050000000Z-broken", "manifest.json"), "{not json");
  const all = listRunSummaries({ outputRoot });
  assert.deepEqual(all.map((entry) => entry.run_id), [...ids].reverse());
  assert.equal(listRunSummaries({ outputRoot, limit: 2 }).length, 2);
});

test("compare reports unsupported manifest schemas instead of guessing", async () => {
  const outputRoot = tempRoot();
  const dir = join(outputRoot, "runs", "2026-09-06T050000000Z-old");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema_version: "agent-action-stack.run/v0", report: "report.json", stages: {} }));
  writeFileSync(join(dir, "report.json"), JSON.stringify({ run_id: "old" }));
  assert.throws(() => summarizeRun("2026-09-06T050000000Z-old", { outputRoot }), /unsupported manifest schema/);
  const compared = compareRuns("2026-09-06T050000000Z-old", "2026-09-06T050000000Z-old", { outputRoot });
  assert.equal(compared.classification, "not-comparable");
});

test("cases and compare CLI commands validate arguments and print classifications", async () => {
  const outputRoot = tempRoot();
  void outputRoot;
  const listed = await captureMain(["cases"]);
  assert.equal(listed.exitCode, 0);
  const junkCases = await captureMain(["cases", "--bogus"]);
  assert.equal(junkCases.exitCode, 2);
  const oneArg = await captureMain(["compare", "only-one"]);
  assert.equal(oneArg.exitCode, 2);
  assert.match(oneArg.stderr, /Usage: aas compare/);
  const badFlag = await captureMain(["compare", "a", "--bogus"]);
  assert.equal(badFlag.exitCode, 2);
});

test("persistRunBundle rejects run ids readers already refuse", () => {
  const outputRoot = tempRoot();
  const marker = join(outputRoot, "marker.json");
  writeFileSync(marker, "keep");
  for (const bad of [".", "..", "...", 12]) {
    assert.throws(() => persistRunBundle({
      outputRoot,
      runId: bad,
      report: { run_id: "x" },
      stages: {},
      componentProvenance: [],
      exitCode: 0,
    }), /Invalid run id/, `expected ${String(bad)} to be rejected`);
  }
  assert.equal(readFileSync(marker, "utf8"), "keep");
  assert.equal(existsSync(join(outputRoot, "runs", "...")), false);
});

test("a symlinked runs directory is not used as the case store", (t) => {
  const outputRoot = tempRoot();
  const outsideParent = tempRoot();
  const runId = "2026-09-06T050000000Z-outside";
  writeCase(outsideParent, runId);
  if (!linkOrSkip(t, join(outsideParent, "runs"), join(outputRoot, "runs"))) return;
  assert.throws(() => listRuns({ outputRoot }), /regular directory/);
  assert.throws(() => pruneRuns({ outputRoot, keep: 1 }), /regular directory/);
  assert.throws(() => exportRunBundle(runId, { outputRoot }), /regular directory/);
  assert.throws(() => summarizeRun(runId, { outputRoot }), /regular directory/);
  assert.throws(() => compareRuns(runId, runId, { outputRoot }), /regular directory/);
  assert.equal(existsSync(join(outsideParent, "runs", runId, "manifest.json")), true);
});

test("run ids cannot escape the runs directory", async () => {
  const outputRoot = tempRoot();
  const ids = await makeRuns(outputRoot, 1);
  writeFileSync(join(outputRoot, "manifest.json"), JSON.stringify({ schema_version: "agent-action-stack.run/v1", report: "canary.json", stages: {} }));
  writeFileSync(join(outputRoot, "canary.json"), JSON.stringify({ run_id: "canary", flow: "ESCAPED" }));
  for (const bad of [".", "..", "...", "../..", "/etc/passwd", "..\\", "a/b"]) {
    assert.throws(() => summarizeRun(bad, { outputRoot }), /Invalid run id/, `expected ${bad} to be rejected`);
    assert.throws(() => exportRunBundle(bad, { outputRoot }), /Invalid run id/, `expected export of ${bad} to be rejected`);
  }
  assert.equal(summarizeRun(ids[0], { outputRoot }).run_id, ids[0]);
});

test("compare CLI exits nonzero when a pair is not comparable", async () => {
  const outputRoot = tempRoot();
  void outputRoot;
  const missing = await captureMain(["compare", "2026-09-06T050000000Z-absent", "2026-09-06T050000000Z-absent"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stdout, /not-comparable/);
  assert.match(missing.stdout, /matching metadata does not prove matching evidence/);
  assert.doesNotMatch(missing.stdout, /\/(Users|home)\//);
});

function writeCase(outputRoot, runId, { schema = "agent-action-stack.run/v1", stageStatus = { decide: "passed", act: "passed", prove: "passed" }, report, prove, corruptProve = false } = {}) {
  const dir = join(outputRoot, "runs", runId);
  mkdirSync(join(dir, "stages"), { recursive: true });
  const stages = {};
  for (const name of ["decide", "act", "prove"]) {
    stages[name] = { status: stageStatus[name] ?? "skipped", reason: null, code: null, stderr: null, artifact: `stages/${name}.json` };
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schema_version: schema,
    run_id: runId,
    created_at: "2026-09-06T00:00:00.000Z",
    exit_code: 0,
    component_provenance: [{ name: "consequence-rail", commit: "abc", detached: true, clean: true }],
    stages,
    report: "report.json",
  }));
  writeFileSync(join(dir, "report.json"), JSON.stringify(report ?? {
    run_id: runId,
    flow: "decide -> act -> prove",
    component_provenance: [{ name: "consequence-rail", commit: "abc" }],
    stages: {
      decide: { status: "passed", policy_id: "p1" },
      act: { status: "passed", outcome: "compensated", state: "CLOSED", fault: "duplicate", action_id: `act_${runId}` },
      prove: { status: "passed", mode: "rail-review" },
    },
  }));
  writeFileSync(join(dir, "stages", "prove.json"), corruptProve ? "{corrupted" : JSON.stringify(prove ?? {
    ok: true,
    result: { verdict: "recorded", reviewId: `review_${runId}`, actionId: `act_${runId}`, evidenceDigest: "sha256:abc", legalEffect: "not-determined" },
  }));
  return dir;
}

test("compare classifies identical, different, and not-comparable pairs", () => {
  const outputRoot = tempRoot();
  writeCase(outputRoot, "case-a");
  writeCase(outputRoot, "case-b", {
    stageStatus: { decide: "passed", act: "passed", prove: "skipped" },
    report: {
      run_id: "case-b",
      flow: "decide -> act",
      component_provenance: [{ name: "consequence-rail", commit: "def" }],
      stages: {
        decide: { status: "passed", policy_id: "p1" },
        act: { status: "passed", outcome: "settled", state: "CLOSED", fault: "none", action_id: "act_b" },
        prove: { status: "skipped", mode: null },
      },
    },
    prove: {},
  });

  const same = compareRuns("case-a", "case-a", { outputRoot });
  assert.equal(same.classification, "identical");
  assert.deepEqual(same.differences, []);

  const different = compareRuns("case-a", "case-b", { outputRoot });
  assert.equal(different.classification, "different");
  const fields = different.differences.map((entry) => entry.field);
  for (const field of ["outcome", "stages", "components"]) {
    assert.ok(fields.includes(field), `expected ${field} to differ, saw ${fields.join(", ")}`);
  }
  assert.deepEqual(different.notes, [
    "differences do not establish causation",
    "matching metadata does not prove matching evidence",
    "only the listed compared fields are checked; raw evidence is never loaded into this view",
  ]);

  const absent = compareRuns("case-a", "2026-09-06T050000000Z-absent", { outputRoot });
  assert.equal(absent.classification, "not-comparable");
  assert.match(absent.errors.join(" "), /Cannot read run/);
  assert.doesNotMatch(absent.errors.join(" "), /\/runs\//);
});

test("unreadable stage artifacts fail closed instead of reading as absent", () => {
  const outputRoot = tempRoot();
  writeCase(outputRoot, "case-ok");
  writeCase(outputRoot, "case-broken", { corruptProve: true });
  assert.deepEqual(summarizeRun("case-broken", { outputRoot }).artifacts_unreadable, ["prove"]);
  assert.equal(summarizeRun("case-ok", { outputRoot }).review_verdict, "recorded");
  const compared = compareRuns("case-ok", "case-broken", { outputRoot });
  assert.equal(compared.classification, "not-comparable");
  assert.ok(compared.errors.some((entry) => /prove artifact is unreadable/.test(entry)));
});

test("comparison never implies causation or equivalence of evidence", () => {
  const outputRoot = tempRoot();
  writeCase(outputRoot, "case-one", { prove: { ok: true, result: { verdict: "recorded", reviewId: "r1", actionId: "act_case-one", evidenceDigest: "sha256:one", legalEffect: "not-determined" } } });
  const summary = summarizeRun("case-one", { outputRoot });
  assert.equal(summary.evidence_digest, "sha256:one");
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /rule_results|rail_bundle/);
});

test("demo accepts a synthetic action domain and threads it through decide and act", async () => {
  const outputRoot = tempRoot();
  const calls = [];
  const result = await runDemo(["--domain", "inventory"], {
    ...stubOptions(outputRoot, { runId: "inventory-run" }),
    runDecideFn: async (responsePath, options) => {
      calls.push(["decide", responsePath, options.domain]);
      return { ok: true, raw: { passed: true, policy_id: "aas-inventory-gate-v1", rule_results: [] }, status: 0 };
    },
    runActFn: async (fault, options) => {
      calls.push(["act", options.domain]);
      return { ok: true, raw: { outcome: "settled", state: "CLOSED", fault: "none", action_id: "act_inv" }, status: 0 };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls[0][2], "inventory");
  assert.match(String(calls[0][1]), /inventory\.response\.pass\.json$/);
  assert.equal(calls[1][1], "inventory");
});

test("demo rejects an unknown domain before running any stage", async () => {
  const outputRoot = tempRoot();
  await assert.rejects(
    () => runDemo(["--domain", "payments"], stubOptions(outputRoot)),
    (error) => /--domain must be refund or inventory/.test(error.message),
  );
  const rejected = await captureMain(["demo", "--domain", "payments"]);
  assert.match(rejected.stderr, /--domain must be refund or inventory/);
  assert.equal(rejected.exitCode, 2);
});

test("an explicit null act fault stays null instead of becoming the requested fault", async () => {
  const outputRoot = tempRoot();
  const cleared = await runDemo(["--fault", "duplicate"], stubOptions(outputRoot, {
    runId: "null-fault",
    runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED", fault: null, action_id: "act-null" }, status: 0 }),
  }));
  assert.equal(cleared.report.stages.act.fault, null);
  const omitted = await runDemo(["--fault", "duplicate"], stubOptions(outputRoot, {
    runId: "omitted-fault",
    runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED", action_id: "act-omit" }, status: 0 }),
  }));
  assert.equal(omitted.report.stages.act.fault, "duplicate");
});

test("runAct targets the requested rail demo domain", () => {
  const seen = [];
  const runner = (bin, args) => {
    seen.push(args);
    return { status: 0, stdout: '{"outcome":"settled","state":"CLOSED","fault":"none","action_id":"a"}\n', stderr: "", error: null };
  };
  runAct("none", { depsDir: "deps", runner, domain: "inventory" });
  assert.equal(seen[0][1], "demo");
  assert.equal(seen[0][2], "inventory");
});

test("runAct rejects an unknown domain before spawning the rail CLI", () => {
  let called = false;
  assert.throws(() => runAct("none", {
    depsDir: "deps",
    domain: "payments",
    runner: () => {
      called = true;
      return { status: 0, stdout: '{"outcome":"settled","state":"CLOSED","fault":"none","action_id":"a"}\n', stderr: "", error: null };
    },
  }), /act domain must be refund or inventory/);
  assert.equal(called, false);
});

test("runDecide rejects an unknown domain instead of loading the refund policy", () => {
  let called = false;
  assert.throws(() => runDecide("unused", {
    fixturesDir: join(ROOT, "fixtures"),
    domain: "payments",
    runner: () => {
      called = true;
      return { status: 0, stdout: '{"passed":true,"policy_id":"p","rule_results":[]}\n', stderr: "", error: null };
    },
  }), /decide domain must be refund or inventory/);
  assert.equal(called, false);
});

test("runDecide uses the domain policy fixture", () => {
  const seen = [];
  const runner = (bin, args) => {
    seen.push(args);
    return { status: 0, stdout: '{"passed":true,"policy_id":"p","rule_results":[]}\n', stderr: "", error: null };
  };
  runDecide("unused", { depsDir: "deps", fixturesDir: "fixtures", runner, domain: "inventory" });
  assert.ok(
    seen[0].some((arg) => String(arg).includes("inventory.policy.json")),
    `policy fixture missing: ${seen[0].join(" ")}`,
  );
});

test('case exports reject mismatched identities and oversized persisted reports', async()=>{
  const outputRoot=tempRoot();
  const result=await runDemo([], {paths:{outputRoot},runId:'bounded-export',componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false},status:0})});
  const reportPath=join(result.bundleDir,'report.json');
  const report=JSON.parse(readFileSync(reportPath,'utf8'));
  writeFileSync(reportPath,JSON.stringify({...report,run_id:'other-run'}));
  assert.throws(()=>exportRunBundle('bounded-export',{outputRoot}),/identity/i);
  writeFileSync(reportPath,JSON.stringify({...report,pad:'x'.repeat(CHILD_JSON_LIMIT)}));
  assert.throws(()=>exportRunBundle('bounded-export',{outputRoot}),/limit|large/i);
});

test('export byte budget includes the actual formatted download representation',async()=>{
  const outputRoot=tempRoot();
  const result = await runDemo([],{paths:{outputRoot},runId:'formatted-budget',componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false},status:0})});
  // Preserve the reader's guard against externally modified historical cases.
  writeFileSync(join(result.bundleDir, 'stages/decide.json'), JSON.stringify({passed:false,rows:Array(30000).fill({x:0})}));
  assert.throws(()=>exportRunBundle('formatted-budget',{outputRoot}),/byte limit/);
});

test('saved case readers reject invalid UTF-8 without replacing evidence bytes',async()=>{
  const outputRoot=tempRoot();
  const result=await runDemo([],{paths:{outputRoot},runId:'invalid-utf8',componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false},status:0})});
  writeFileSync(join(result.bundleDir,'report.json'),Buffer.concat([Buffer.from('{"run_id":"invalid-utf8","field":"'),Buffer.from([0xc0]),Buffer.from('"}')]));
  assert.throws(()=>exportRunBundle('invalid-utf8',{outputRoot}),/encoded data|encoding/i);
});

test('history and comparison reject mismatched saved identities',async()=>{
  const {listCasePage}=await import('../bin/case-review.mjs');
  const outputRoot=tempRoot();
  const result=await runDemo([],{paths:{outputRoot},runId:'identity-case',componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false},status:0})});
  for(const name of ['manifest.json','report.json']) {
    const path=join(result.bundleDir,name), original=readFileSync(path,'utf8');
    writeFileSync(path,JSON.stringify({...JSON.parse(original),run_id:'different-case'}));
    assert.deepEqual(listCasePage({outputRoot}).unavailable,['identity-case']);
    assert.equal(listCasePage({outputRoot}).cases.length,0);
    assert.equal(compareRuns('identity-case','identity-case',{outputRoot}).classification,'not-comparable');
    writeFileSync(path,original);
  }
});

test('inspect parsing diagnostics never include malformed saved evidence bytes',async()=>{
  const outputRoot=tempRoot();
  const result=await runDemo([],{paths:{outputRoot},runId:'private-json',componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false},status:0})});
  const manifest=JSON.parse(readFileSync(join(result.bundleDir,'manifest.json'),'utf8'));
  for(const name of ['manifest.json','report.json',manifest.stages.decide.artifact]) {
    const path=join(result.bundleDir,name), original=readFileSync(path,'utf8');
    writeFileSync(path,'{"PROBE123":INVALID}');
    for(const format of ['--json','--markdown']) {
      const child=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/aas.mjs',import.meta.url)),'inspect','private-json','--root',outputRoot,format],{encoding:'utf8',timeout:5000});
      assert.notEqual(child.status,0);assert.match(child.stderr,/invalid JSON/);assert.doesNotMatch(child.stderr,/PROBE123|INVALID/);
    }
    writeFileSync(path,original);
  }
});

test('saved case FIFO cannot block the shared reader', {skip:process.platform==='win32'},()=>{
  const outputRoot=tempRoot(),dir=join(outputRoot,'runs','fifo-case');mkdirSync(dir,{recursive:true});
  execFileSync('mkfifo',[join(dir,'manifest.json')]);
  const url=new URL('../bin/aas.mjs',import.meta.url).href;
  const reviewUrl=new URL('../bin/case-review.mjs',import.meta.url).href;
  const script='import {listCasePage} from '+JSON.stringify(reviewUrl)+';import {exportRunBundle} from '+JSON.stringify(url)+';try{exportRunBundle("fifo-case",{outputRoot:'+JSON.stringify(outputRoot)+'});process.exitCode=1;}catch(error){if(!/regular file/.test(error.message))throw error;process.stdout.write("rejected");}if(listCasePage({outputRoot:'+JSON.stringify(outputRoot)+'}).unavailable[0]!=="fifo-case")throw new Error("FIFO history entry must be unavailable");';
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:2000});
  assert.equal(child.error,undefined,'reader must not block until child timeout');assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'rejected');
});

test('saved manifests reject missing records arrays and invalid artifact fields consistently',async()=>{
  const {listCasePage,inspectCase}=await import('../bin/case-review.mjs');
  const outputRoot=tempRoot(),runId='stage-shapes';
  const {bundleDir,manifest}=persistRunBundle({outputRoot,runId,report:{run_id:runId,stages:{}},stages:{decide:{status:'failed',raw:{passed:false}}},componentProvenance:[],exitCode:1});
  assert.deepEqual(Object.keys(manifest.stages),['decide','act','prove']);
  assert.equal(manifest.stages.act.artifact,null);
  assert.equal(exportRunBundle(runId,{outputRoot}).manifest.stages.prove.status,'skipped');
  assert.equal(listCasePage({outputRoot}).cases.length,1);
  const malformed=[{},[],{...manifest.stages,other:{}},...['decide','act','prove'].map(name=>{const stages=structuredClone(manifest.stages);delete stages[name];return stages;})];
  for(const value of [[],null,false]) malformed.push({...manifest.stages,act:value});
  for(const value of [undefined,false,0,{},[],'','../escape.json']) malformed.push({...manifest.stages,act:{...manifest.stages.act,artifact:value}});
  for(const stages of malformed){
    writeFileSync(join(bundleDir,'manifest.json'),JSON.stringify({...manifest,stages}));
    assert.throws(()=>exportRunBundle(runId,{outputRoot}),/stage|artifact/i);
    assert.throws(()=>inspectCase(runId,{outputRoot}),/stage|artifact/i);
    assert.deepEqual(listCasePage({outputRoot}).unavailable,[runId]);
    assert.equal(compareRuns(runId,runId,{outputRoot}).classification,'not-comparable');
  }
  const full=persistRunBundle({outputRoot,runId:'complete-stages',report:{run_id:'complete-stages',stages:{}},stages:Object.fromEntries(['decide','act','prove'].map(name=>[name,{status:'passed',raw:{ok:true}}])),componentProvenance:[],exitCode:0});
  assert.equal(Object.keys(exportRunBundle('complete-stages',{outputRoot}).stages).length,3);
  assert.equal(full.manifest.stages.prove.artifact,'stages/prove.json');
});

test('replay bounds UTF-8 bytes and redacts malformed JSON for files and streams', async () => {
  const root = tempRoot(), path = join(root, 'replay.json');
  const sources = [Buffer.from(JSON.stringify({pad: 'é'.repeat(CHILD_JSON_LIMIT / 2)})), Buffer.from('{"SYNTHETIC_PARSE_MARKER":invalid}'), Buffer.from([0xff])];
  for (const input of sources) {
    writeFileSync(path, input);
    for (const source of [path, '-']) {
      const result = await captureMain(['replay', source, '--json'], {stdin: Readable.from([input])});
      assert.equal(result.exitCode, 1);
      assert.doesNotMatch(result.stderr, /SYNTHETIC_PARSE_MARKER/);
      assert.match(result.stderr, input.length > CHILD_JSON_LIMIT ? /byte limit/ : /invalid JSON|UTF-8/);
    }
  }
  let consumed = 0;
  async function* oversized() { consumed++; yield Buffer.alloc(CHILD_JSON_LIMIT + 1); consumed++; yield Buffer.from('{}'); }
  const bounded = await captureMain(['replay', '-', '--json'], {stdin: oversized()});
  assert.equal(bounded.exitCode, 1); assert.equal(consumed, 1);
});

test('handoff export preserves existing files unless replacement is explicit', () => {
  const root = tempRoot(), target = join(root, 'case.json');
  writeAtomicFile(target, 'original');
  assert.throws(() => writeAtomicFile(target, 'replacement', {replace: false}), /exist|EEXIST/);
  assert.equal(readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(readdirSync(root), ['case.json']);
  writeAtomicFile(join(root, 'new.json'), 'new', {replace: false});
  assert.equal(readFileSync(join(root, 'new.json'), 'utf8'), 'new');
  writeAtomicFile(target, 'replacement', {replace: true});
  assert.equal(readFileSync(target, 'utf8'), 'replacement');
});

test('saved-case commands use an explicit output root without component setup', async () => {
  const outputRoot = tempRoot();
  for (const runId of ['root-a', 'root-b']) await runDemo([], {paths:{outputRoot},runId,componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false},status:0})});
  for (const command of [['runs'], ['cases'], ['compare', 'root-a', 'root-b'], ['export', 'root-a'], ['prune', '--keep', '1', '--dry-run']]) {
    const result = await captureMain([...command, '--root', outputRoot, '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout));
  }
  const target = join(outputRoot, 'handoff.json');
  assert.equal((await captureMain(['export','root-a','--root',outputRoot,'--out',target,'--json'])).exitCode, 0);
  assert.equal((await captureMain(['export','root-b','--root',outputRoot,'--out',target,'--json'])).exitCode, 1);
  assert.equal(JSON.parse(readFileSync(target,'utf8')).report.run_id, 'root-a');
  for (const args of [['--root'], ['--root',''], ['--root',outputRoot,'--root',outputRoot]]) {
    assert.equal((await captureMain(['cases',...args,'--json'])).exitCode, 2);
  }
});

test("inspect rejects a blank output root", async () => {
  for (const root of ["   ", "\t"]) {
    const result = await captureMain(["inspect", "case-a", "--root", root]);
    assert.equal(result.exitCode, 2, result.stderr);
    assert.match(result.stderr, /output root/);
  }
});

test('human history reports damaged entries and continuation even on empty pages', async () => {
  const outputRoot = tempRoot(); writeCase(outputRoot, 'case-a');
  mkdirSync(join(outputRoot, 'runs', 'case-z'), {recursive:true});
  const first = await captureMain(['cases','--root',outputRoot,'--limit','1']);
  assert.equal(first.exitCode, 0); assert.doesNotMatch(first.stdout, /no cases yet/);
  assert.match(first.stdout, /unavailable: case-z/); assert.match(first.stdout, /next_cursor: case-z/);
  const next = await captureMain(['cases','--root',outputRoot,'--limit','1','--before','case-z']);
  assert.match(next.stdout, /case-a outcome=/); assert.match(next.stdout, /next_cursor: none/);
});

test('a filtered empty history page is not reported as unreadable cases', async () => {
  const outputRoot = tempRoot(); writeCase(outputRoot, 'case-a'); writeCase(outputRoot, 'case-b');
  const filtered = await captureMain(['cases','--root',outputRoot,'--search','no-such-case']);
  assert.equal(filtered.exitCode, 0, filtered.stderr);
  assert.match(filtered.stdout, /^no cases in this page match the filters$/m);
  assert.doesNotMatch(filtered.stdout, /no readable cases/);
  assert.doesNotMatch(filtered.stdout, /unavailable:/);
  assert.match(filtered.stdout, /scanned: 2/);
  // Every scanned entry damaged: that, and only that, is "no readable cases".
  const damaged = tempRoot(); mkdirSync(join(damaged, 'runs', 'case-z'), {recursive:true});
  const unreadable = await captureMain(['cases','--root',damaged,'--search','case']);
  assert.match(unreadable.stdout, /^no readable cases in this page$/m);
  assert.match(unreadable.stdout, /unavailable: case-z/);
  const empty = await captureMain(['cases','--root',tempRoot()]);
  assert.match(empty.stdout, /^no cases in this page$/m);
});

test('comparison handoffs support Markdown and fail machine callers on unavailable cases', async () => {
  const outputRoot = tempRoot(); writeCase(outputRoot, 'compare-a'); writeCase(outputRoot, 'compare-b');
  const good = await captureMain(['compare','compare-a','compare-b','--root',outputRoot,'--markdown']);
  assert.equal(good.exitCode, 0, good.stderr); assert.match(good.stdout, /# Saved case comparison/);
  assert.match(good.stdout, /do not establish causation/);
  for (const format of ['--json','--markdown']) {
    const bad = await captureMain(['compare','compare-a','missing','--root',outputRoot,format]);
    assert.equal(bad.exitCode, 1);
    if (format === '--json') assert.equal(JSON.parse(bad.stdout).ok, false);
  }
  assert.equal((await captureMain(['compare','compare-a','compare-b','--markdown','--json'])).exitCode, 2);
});

test('verify reads a saved case without executing actions or changing its files', async () => {
  const outputRoot=tempRoot(), runId='verify-refused';
  const result=await runDemo([], {paths:{outputRoot},runId,componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false},status:0})});
  const before=readFileSync(join(result.bundleDir,'manifest.json'),'utf8');
  const verified=await captureMain(['verify',runId,'--root',outputRoot,'--json']);
  assert.equal(verified.exitCode,1); const report=JSON.parse(verified.stdout);
  assert.equal(report.ok,false); assert.match(report.reason,/unavailable/);
  assert.equal(readFileSync(join(result.bundleDir,'manifest.json'),'utf8'),before);
  assert.deepEqual(readdirSync(join(outputRoot,'runs')),[runId]);
  assert.equal((await captureMain(['verify',runId,'--root',outputRoot,'--json'],{nodeVersion:'20.19.0'})).exitCode,1);
  for(const args of [[],['a','b'],['a','--markdown']]) assert.equal((await captureMain(['verify',...args])).exitCode,2);
});

test('latest resolves the persisted pointer and fails closed on unavailable identities', async () => {
  const outputRoot=tempRoot();
  for(const runId of ['z-case','a-case']) await runDemo([], {paths:{outputRoot},runId,componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false},status:0})});
  const latest=await captureMain(['latest','--root',outputRoot]);
  assert.equal(latest.exitCode,0); assert.equal(latest.stdout.trim(),'a-case');
  assert.equal(JSON.parse((await captureMain(['latest','--root',outputRoot,'--json'])).stdout).run_id,'a-case');
  for(const pointer of [{run_id:'missing'},{run_id:'../escape'},{run_id:'z-case',manifest:'runs/a-case/manifest.json'}]) {
    writeFileSync(join(outputRoot,'latest.json'),JSON.stringify(pointer));
    assert.equal((await captureMain(['latest','--root',outputRoot,'--json'])).exitCode,1);
  }
  assert.equal((await captureMain(['latest','extra'])).exitCode,2);
});

test('case review handoffs include requested settings and bounded policy failures', async () => {
  const {inspectCase,renderCaseMarkdown}=await import('../bin/case-review.mjs');
  const outputRoot=tempRoot(), runId='policy-review';
  const rules=[{rule_id:'allowed',passed:true},...Array.from({length:55},(_,index)=>({rule_id:'failed-'+index,path:'decision',kind:'equals',passed:false,reason_code:'not_equal',raw:'OMIT_RAW'}))];
  await runDemo(['--response','fail','--domain','inventory'],{paths:{outputRoot},runId,componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false,rule_results:rules},status:0})});
  const review=inspectCase(runId,{outputRoot});
  assert.equal(review.policy_failures.total,55);assert.equal(review.policy_failures.rules.length,50);assert.equal(review.policy_failures.omitted,5);
  const markdown=renderCaseMarkdown(review);assert.match(markdown,/## Requested settings/);assert.match(markdown,/domain: inventory/);assert.match(markdown,/not\\_equal/);assert.match(markdown,/5 additional failures omitted/);assert.doesNotMatch(markdown,/OMIT_RAW/);
});

test("case review includes persisted stage stderr", async () => {
  const { inspectCase, renderCaseMarkdown } = await import("../bin/case-review.mjs");
  const outputRoot = tempRoot();
  const runId = "stderr-review";
  persistRunBundle({
    outputRoot,
    runId,
    report: { run_id: runId, stages: {} },
    stages: {
      act: { status: "failed", stderr: "crctl: <boom>", raw: { outcome: null } },
    },
    componentProvenance: [],
    exitCode: 1,
  });
  const review = inspectCase(runId, { outputRoot });
  const act = review.stages.find((stage) => stage.name === "act");
  assert.equal(act.stderr, "crctl: <boom>");
  const markdown = renderCaseMarkdown(review);
  assert.match(markdown, /stderr crctl: &lt;boom&gt;/);
  assert.doesNotMatch(markdown, /<boom>/);
  assert.equal(review.stages.find((stage) => stage.name === "decide").stderr, null);
});

test('case reviews explain verification readiness without claiming receipt verification', async () => {
  const {inspectCase,renderCaseMarkdown}=await import('../bin/case-review.mjs');
  const outputRoot=tempRoot(),rail={synthetic:true},digest='sha256:'+createHash('sha256').update(JSON.stringify(rail)).digest('hex');
  const variants=[['no-rail',{},null,'unavailable'],['no-review',{action_id:'a',rail_bundle:rail},null,'unavailable'],['conflict',{action_id:'a',rail_bundle:rail},{verdict:'recorded',actionId:'a',evidenceDigest:'wrong'},'conflicting'],['ready',{action_id:'a',rail_bundle:rail},{verdict:'recorded',actionId:'a',evidenceDigest:digest},'ready']];
  for(const [runId,act,review,state] of variants){
    persistRunBundle({outputRoot,runId,report:{run_id:runId,stages:{}},stages:{act:{status:'passed',raw:act},prove:{status:'passed',raw:{result:review}}},componentProvenance:[],exitCode:0});
    const report=inspectCase(runId,{outputRoot});assert.equal(report.verification_readiness.state,state);
    const md=renderCaseMarkdown(report);assert.match(md,/## Verification next step/);assert.match(md,/Receipt verification was not performed/);
    if(state==='ready') assert.match(md,/aas verify ready/);
  }
});

test('filtered case pages preserve scan bounds and continuation across nonmatches', async () => {
  const {listCasePage}=await import('../bin/case-review.mjs');
  const outputRoot=tempRoot();
  for(const [runId,domain] of [['case-z','refund'],['case-a','inventory']]) await runDemo(['--domain',domain],{paths:{outputRoot},runId,componentResolver:()=>[],runDecideFn:async()=>({ok:false,raw:{passed:false,policy_id:'bounded-policy'},status:0})});
  const first=listCasePage({outputRoot,limit:1,domain:'inventory'});
  assert.deepEqual(first.cases,[]);assert.equal(first.next_cursor,'case-z');assert.equal(first.scanned,1);
  const next=listCasePage({outputRoot,limit:1,before:first.next_cursor,domain:'inventory',outcome:'none',search:'BOUNDED-POLICY'});
  assert.equal(next.cases[0].run_id,'case-a');assert.equal(next.next_cursor,null);
  const cli=await captureMain(['cases','--root',outputRoot,'--domain','inventory','--outcome','none','--search','bounded-policy','--json']);
  assert.equal(cli.exitCode,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).cases.length,1);
  for(const args of [['--domain','real'],['--outcome','paid'],['--search',''],['--search','x'.repeat(201)],['--domain','refund','--domain','inventory']]) assert.equal((await captureMain(['cases',...args,'--json'])).exitCode,2);
});

test("review handoff removes its scratch directory when decide cannot start", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-handoff-scratch-"));
  const preload = join(dir, "preload.cjs");
  writeFileSync(preload, [
    "if (typeof process.argv[1] === 'string' && process.argv[1].includes('sys.version_info')) {",
    "  process.stdout.write('3.13\\n');",
    "  process.exit(0);",
    "}",
    "",
  ].join("\n"));
  const result = spawnSync(process.execPath, [join(ROOT, "examples/review-handoff.mjs"), "--response", "fail"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      TMPDIR: dir,
      TMP: dir,
      TEMP: dir,
      AAS_PYTHON: process.execPath,
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    },
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("aas-integrator-")), []);
});

test('review handoff example honors the explicit interpreter override', () => {
  const child=spawnSync(process.execPath,[join(ROOT,'examples/review-handoff.mjs')],{cwd:ROOT,encoding:'utf8',timeout:5000,env:{...process.env,AAS_PYTHON:'aas-synthetic-missing-python'}});
  assert.equal(child.status,1);assert.match(child.stderr,/AAS_PYTHON/);assert.match(child.stderr,/did not report a usable Python version/);
});

test("syntax gate lists every tracked module and reports a parse failure", () => {
  const targets = listSyntaxTargets(ROOT);
  for (const file of [
    "bin/aas.mjs",
    "bin/aas-gui.mjs",
    "bin/aas-gui-worker.mjs",
    "bin/case-review.mjs",
    "examples/connector-conformance.mjs",
    "examples/review-handoff.mjs",
    "playwright.config.mjs",
    "scripts/bootstrap.mjs",
    "scripts/check-syntax.mjs",
    "scripts/integration-check.mjs",
    "test/browser/workbench.spec.mjs",
    "test/component-compatibility.test.mjs",
    "test/gui.test.mjs",
    "test/stack.test.mjs",
  ]) {
    assert.ok(targets.includes(file), `syntax gate does not list ${file}`);
  }
  assert.ok(targets.every((file) => /\.(?:mjs|cjs|js)$/.test(file) && !file.includes("\\")));
  assert.ok(!targets.some((file) => /^(?:deps|node_modules|\.out)\//.test(file)));

  // Without Git the gate walks the tree and still skips generated folders.
  const walked = listSyntaxTargets(ROOT, { command: () => ({ status: 128, stdout: "", stderr: "not a git repository" }) });
  assert.ok(walked.includes("bin/aas.mjs") && walked.includes("scripts/check-syntax.mjs"));
  assert.ok(!walked.some((file) => /^(?:deps|node_modules|\.out)\//.test(file)));

  const scratch = tempRoot();
  writeFileSync(join(scratch, "valid.mjs"), "export const ok = 1;\n");
  writeFileSync(join(scratch, "broken.mjs"), "export const = ;\n");
  const failures = checkSyntax(["valid.mjs", "broken.mjs"], { cwd: scratch });
  assert.deepEqual(failures.map((failure) => failure.file), ["broken.mjs"]);
  assert.match(failures[0].detail, /SyntaxError/);
});

test("workflow actions are pinned by commit and checkouts drop the token", () => {
  const workflows = join(ROOT, ".github", "workflows");
  const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name)).sort();
  assert.ok(files.includes("ci.yml"), "ci.yml is missing");
  const pins = new Map();
  let checkouts = 0;
  for (const name of files) {
    const lines = readFileSync(join(workflows, name), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const uses = /^(\s*(?:-\s+)?)uses:\s*(\S+)/.exec(line);
      if (!uses) return;
      const where = `${name}:${index + 1}`;
      const pinned = /^\s*(?:-\s+)?uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})\s+#\s*(v\d+\.\d+\.\d+)\s*$/.exec(line);
      assert.ok(pinned, `${where} must pin a 40-character commit SHA with a # vX.Y.Z comment: ${line.trim()}`);
      const [, action, sha, tag] = pinned;
      const known = pins.get(action);
      if (known) {
        assert.equal(sha, known.sha, `${where} pins ${action} to a different SHA than ${known.where}`);
        assert.equal(tag, known.tag, `${where} labels ${action} differently than ${known.where}`);
      } else {
        pins.set(action, { sha, tag, where });
      }
      if (action !== "actions/checkout") return;
      checkouts += 1;
      // The step's keys sit at the column of `uses:`; the step ends at the
      // first non-blank line indented less than that.
      const keyIndent = uses[1].length;
      const block = [];
      for (const next of lines.slice(index + 1)) {
        if (next.trim() === "") continue;
        if (next.length - next.trimStart().length < keyIndent) break;
        block.push(next.trim());
      }
      assert.ok(block.includes("persist-credentials: false"), `${where} checkout must set persist-credentials: false`);
    });
  }
  assert.ok(checkouts >= 3, `expected every job to check out the repository, found ${checkouts}`);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/setup-python"]) {
    assert.ok(pins.has(action), `${action} is not used by any workflow`);
  }
});

function releaseFixture({ version = "0.2.5", lockVersion = version, changelog, readiness, tag = null } = {}) {
  const pins = loadComponentLock(LOCK).map((component) => component.commit);
  return {
    pkg: { name: "agent-action-stack", version },
    lock: { name: "agent-action-stack", version: lockVersion, packages: { "": { name: "agent-action-stack", version: lockVersion } } },
    changelog: changelog ?? [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Fixed",
      "- One fix.",
      "",
      "[Unreleased]: https://github.com/EauDoon/agent-action-stack/compare/c9e89c001f51b48f1ebda6716996680546033a8b...HEAD",
      "",
    ].join("\n"),
    readiness: readiness ?? pins.map((sha) => `- pin \`${sha}\``).join("\n"),
    stackLock: { components: loadComponentLock(LOCK) },
    tag,
  };
}

const RELEASED_CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [0.3.0] - 2026-10-09",
  "",
  "### Changed",
  "- BREAKING: a change.",
  "",
  "### Fixed",
  "- A fix.",
  "",
  "## [0.2.0] - 2026-08-03",
  "",
  "### Added",
  "- The GUI.",
  "",
  "## [0.1.0] - 2026-07-31",
  "",
  "### Added",
  "- The first demo.",
  "",
  "[Unreleased]: https://github.com/EauDoon/agent-action-stack/compare/v0.3.0...HEAD",
  "[0.3.0]: https://github.com/EauDoon/agent-action-stack/compare/v0.2.0...v0.3.0",
  "[0.2.0]: https://github.com/EauDoon/agent-action-stack/compare/v0.1.0...v0.2.0",
  "[0.1.0]: https://github.com/EauDoon/agent-action-stack/releases/tag/v0.1.0",
  "",
].join("\n");

test("version check accepts the live repository and a well-formed release", () => {
  assert.deepEqual(checkReleaseConsistency(loadReleaseInputs(ROOT)), []);
  assert.deepEqual(checkReleaseConsistency(releaseFixture()), []);
  assert.deepEqual(checkReleaseConsistency(releaseFixture({ version: "0.3.0", changelog: RELEASED_CHANGELOG, tag: "v0.3.0" })), []);
});

test("version check flags lock, changelog, pin, and tag drift", () => {
  const flagged = (inputs, pattern) => {
    const problems = checkReleaseConsistency(inputs);
    assert.ok(problems.some((problem) => pattern.test(problem)), `expected ${pattern} in ${JSON.stringify(problems)}`);
  };
  flagged(releaseFixture({ lockVersion: "0.2.0" }), /package-lock\.json version "0\.2\.0" does not match package\.json 0\.2\.5/);
  flagged(releaseFixture({ lockVersion: "0.2.0" }), /packages\[""\]\.version "0\.2\.0"/);
  flagged(releaseFixture({ version: "0.2" }), /is not X\.Y\.Z/);
  flagged(releaseFixture({ changelog: "## [Unreleased]\n\n### Changed\n- a\n\n### Changed\n- b\n\n[Unreleased]: https://github.com/EauDoon/agent-action-stack/compare/x...HEAD\n" }),
    /repeats "### Changed"/);
  flagged(releaseFixture({ changelog: "## [Unreleased]\n\n### Improved\n- a\n\n[Unreleased]: https://github.com/EauDoon/agent-action-stack/compare/x...HEAD\n" }),
    /"### Improved" is not one of/);
  flagged(releaseFixture({ changelog: "## [0.2.5] - 2026-09-28\n\n### Fixed\n- a\n\n[0.2.5]: https://github.com/EauDoon/agent-action-stack/releases/tag/v0.2.5\n" }),
    /must open with a "## \[Unreleased\]" section/);
  flagged(releaseFixture({ changelog: "## [Unreleased]\n\n[Unreleased]: https://example.com/compare/x...HEAD\n" }), /must link into/);
  flagged(releaseFixture({ changelog: "## [Unreleased]\n\n### Fixed\n- a\n" }), /no \[Unreleased\] link definition/);

  const unsorted = RELEASED_CHANGELOG.replace("## [0.2.0] - 2026-08-03", "## [0.4.0] - 2026-08-03");
  flagged(releaseFixture({ version: "0.3.0", changelog: unsorted }), /0\.4\.0 must be older than 0\.3\.0/);
  flagged(releaseFixture({ version: "0.3.0", changelog: RELEASED_CHANGELOG.replace("2026-08-03", "2026-02-30") }), /invalid version or date/);
  flagged(releaseFixture({ version: "0.3.0", changelog: RELEASED_CHANGELOG.replace("## [0.1.0] - 2026-07-31", "## [0.1.0]") }), /is not "## \[X\.Y\.Z\] - YYYY-MM-DD"/);
  flagged(releaseFixture({ version: "0.3.1", changelog: RELEASED_CHANGELOG }), /newest release 0\.3\.0 does not match package\.json 0\.3\.1/);
  flagged(releaseFixture({ version: "0.3.0", changelog: RELEASED_CHANGELOG.replace("compare/v0.3.0...HEAD", "compare/main...HEAD") }),
    /\[Unreleased\] should be https:\/\/github\.com\/EauDoon\/agent-action-stack\/compare\/v0\.3\.0\.\.\.HEAD/);
  flagged(releaseFixture({ version: "0.3.0", changelog: RELEASED_CHANGELOG.replace("releases/tag/v0.1.0", "releases/tag/v0.0.1") }), /\[0\.1\.0\] should be/);

  flagged(releaseFixture({ tag: "v9.9.9" }), /Tag v9\.9\.9 does not match package\.json version 0\.2\.5/);
  flagged(releaseFixture({ tag: "v0.2.5" }), /no released "## \[0\.2\.5\] - YYYY-MM-DD" section/);
  flagged(releaseFixture({ version: "0.3.0", tag: "v0.3.0", changelog: RELEASED_CHANGELOG.replace("- BREAKING: a change.", "").replace("- A fix.", "") }),
    /section 0\.3\.0 has no entries/);

  const missingPin = loadComponentLock(LOCK)[1].commit;
  flagged(releaseFixture({ readiness: loadComponentLock(LOCK).filter((component) => component.commit !== missingPin).map((component) => component.commit).join("\n") }),
    new RegExp(`does not list the consequence-rail pin ${missingPin}`));
});

test("release notes are exactly one changelog section", () => {
  const notes = releaseNotes(RELEASED_CHANGELOG, "0.3.0");
  assert.equal(notes, "### Changed\n- BREAKING: a change.\n\n### Fixed\n- A fix.\n");
  assert.equal(releaseNotes(RELEASED_CHANGELOG, "0.1.0"), "### Added\n- The first demo.\n");
  assert.throws(() => releaseNotes(RELEASED_CHANGELOG, "9.9.9"), /no section for 9\.9\.9/);
  // A heading inside a fenced block is content, not structure.
  const fenced = parseChangelog("## [Unreleased]\n\n### Added\n- a\n\n```md\n### Added\n```\n");
  assert.deepEqual(fenced.sections[0].headings.map((heading) => heading.title), ["Added"]);
});

test("version check CLI reports drift with exit 1 and usage errors with exit 2", () => {
  const script = join(ROOT, "scripts", "check-version.mjs");
  const live = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8" });
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, /^version: \d+\.\d+\.\d+ consistent \(package, lock, changelog, release pins\)\n$/);

  const usage = spawnSync(process.execPath, [script, "--tag"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Missing value for --tag/);

  const wrongTag = spawnSync(process.execPath, [script, "--tag", "v0.0.0-not-this"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(wrongTag.status, 1);
  assert.match(wrongTag.stderr, /Tag v0\.0\.0-not-this does not match package\.json version/);
});

test("aas --version prints the package.json version and rejects extra arguments", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(stackVersion(), pkg.version);
  for (const argv of [["--version"], ["version"]]) {
    const plain = await captureMain(argv);
    assert.equal(plain.exitCode, 0);
    assert.equal(plain.stdout, `agent-action-stack ${pkg.version}\n`);
    assert.equal(plain.stderr, "");
    const json = await captureMain([...argv, "--json"]);
    assert.equal(json.exitCode, 0);
    assert.deepEqual(JSON.parse(json.stdout), { ok: true, name: "agent-action-stack", version: pkg.version });
  }
  for (const argv of [["version", "extra"], ["--version", "--bogus"], ["--version", "--json", "--json"]]) {
    const bad = await captureMain(argv);
    assert.equal(bad.exitCode, 2, JSON.stringify(argv));
    assert.match(bad.stderr, /Usage: aas --version \[--json\]/);
  }
  const help = helpText();
  assert.match(help, /^ {2}aas --version \[--json\]$/m);
  assert.match(help, /^ {2}version +Print the orchestrator version \(also --version\)$/m);
  assert.match(help.split("Options:")[1], /^ {2}--version +\S/m);
});

test("runs record stack_version, and cases saved without it still load", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const outputRoot = tempRoot();
  const result = await runDemo(["--response", "pass"], stubOptions(outputRoot, { runId: "versioned-run" }));
  assert.equal(result.report.stack_version, pkg.version);
  assert.equal(result.manifest.stack_version, pkg.version);
  assert.equal(result.manifest.schema_version, "agent-action-stack.run/v1");
  const saved = exportRunBundle("versioned-run", { outputRoot });
  assert.equal(saved.manifest.stack_version, pkg.version);
  assert.equal(saved.report.stack_version, pkg.version);
  assert.equal(summarizeRun("versioned-run", { outputRoot }).stack_version, pkg.version);

  // A case written before the field existed: summaries, comparison, and the
  // case review report it as unavailable instead of rejecting the case.
  const legacyRoot = tempRoot();
  writeCase(legacyRoot, "2026-09-06T050000000Z-legacy");
  writeCase(legacyRoot, "2026-09-06T050000000Z-legacy2");
  const legacy = summarizeRun("2026-09-06T050000000Z-legacy", { outputRoot: legacyRoot });
  assert.equal(legacy.stack_version, null);
  assert.notEqual(compareRuns("2026-09-06T050000000Z-legacy", "2026-09-06T050000000Z-legacy2", { outputRoot: legacyRoot }).classification, "not-comparable");

  // stack_version is informational: two cases that differ only in it compare
  // as identical.
  const mixedRoot = tempRoot();
  await runDemo(["--response", "pass"], stubOptions(mixedRoot, { runId: "mixed-a" }));
  await runDemo(["--response", "pass"], stubOptions(mixedRoot, { runId: "mixed-b" }));
  const manifestPath = join(mixedRoot, "runs", "mixed-b", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.stack_version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const mixed = compareRuns("mixed-a", "mixed-b", { outputRoot: mixedRoot });
  assert.equal(mixed.classification, "identical");
  assert.ok(!mixed.differences.some((difference) => difference.field === "stack_version"));
  assert.equal(mixed.left.stack_version, pkg.version);
  assert.equal(mixed.right.stack_version, null);

  const { inspectCase, renderCaseMarkdown } = await import("../bin/case-review.mjs");
  const current = inspectCase("versioned-run", { outputRoot });
  assert.equal(current.stack_version, pkg.version);
  assert.match(renderCaseMarkdown(current), new RegExp(`^- Orchestrator version: ${pkg.version.replace(/\./g, "\\\\\\.")}$`, "m"));
  const older = inspectCase("mixed-b", { outputRoot: mixedRoot });
  assert.equal(older.stack_version, null);
  assert.match(renderCaseMarkdown(older), /^- Orchestrator version: unavailable$/m);
});

test("stackVersion reads package.json lazily so a copy without it still imports", () => {
  // The integration proof's offline replay copies bin/aas.mjs and
  // scripts/bootstrap.mjs without package.json and runs `aas replay`.
  const isolated = tempRoot();
  for (const path of ["bin/aas.mjs", "scripts/bootstrap.mjs", "stack-lock.json"]) {
    mkdirSync(join(isolated, path, ".."), { recursive: true });
    writeFileSync(join(isolated, path), readFileSync(join(ROOT, path)));
  }
  const listed = spawnSync(process.execPath, [join(isolated, "bin", "aas.mjs"), "runs", "--json"], { cwd: isolated, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const version = spawnSync(process.execPath, [join(isolated, "bin", "aas.mjs"), "--version", "--json"], { cwd: isolated, encoding: "utf8" });
  assert.equal(version.status, 1);
  assert.deepEqual(JSON.parse(version.stderr), { error: { message: "Orchestrator version unavailable: package.json is missing or unreadable." } });
});

test("release workflow runs only on version tags with write access scoped to its job", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const lines = text.split(/\r?\n/);
  const block = (key, indent) => {
    const start = lines.findIndex((line) => line === `${" ".repeat(indent)}${key}:`);
    assert.ok(start >= 0, `release.yml has no ${key}: block at indent ${indent}`);
    const body = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
      if (line.trim() !== "" && !line.trim().startsWith("#")) body.push(line.trim());
    }
    return body;
  };
  // Tags only: no branch push, pull_request, schedule, or manual trigger.
  assert.deepEqual(block("on", 0), ["push:", 'tags: ["v*.*.*"]']);
  assert.deepEqual(block("permissions", 0), ["contents: read"]);
  assert.deepEqual(block("permissions", 4), ["contents: write"]);
  assert.equal(lines.filter((line) => /^\s*permissions:/.test(line)).length, 2);
  // A write-permission job must not restore a cache, and the tag reaches the
  // shell through env, never through an inline expression.
  assert.doesNotMatch(text, /^\s*cache:/m);
  assert.match(text, /package-manager-cache: false/);
  // Step keys sit at 8 spaces and their mappings at 10, so anything deeper
  // is the body of a `run: |` script.
  for (const line of lines.filter((entry) => /^\s*run:/.test(entry) || /^ {12,}\S/.test(entry))) {
    assert.doesNotMatch(line, /\$\{\{/, `inline expression in a run step: ${line.trim()}`);
  }
  assert.match(text, /TAG: \$\{\{ github\.ref_name \}\}/);
  assert.match(text, /node scripts\/check-version\.mjs --tag "\$TAG" --notes "\$RUNNER_TEMP\/release-notes\.md"/);
  assert.match(text, /gh release create "\$TAG" --repo "\$GITHUB_REPOSITORY" --verify-tag/);
  assert.doesNotMatch(text, /npm publish/);

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.private, true, "package.json must stay private: it cannot work as an installed dependency");
  assert.equal(pkg.bin.aas, "./bin/aas.mjs");
});

test("npm test reports every declared test", () => {
  // Process isolation ships test events on stdout. This file also writes
  // captured CLI output there, which drops events. The parent then reports a
  // short run and, on failure, only "test failed" with no test name.
  if (process.env.AAS_COUNTING === "1") return;
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const tokens = pkg.scripts.test.split(/\s+/);
  assert.equal(tokens[0], "node");
  const flags = tokens.slice(1).filter((token) => token.startsWith("--"));
  const declared = readFileSync(fileURLToPath(import.meta.url), "utf8").match(/^test\(/gm).length;
  const env = { ...process.env, AAS_COUNTING: "1" };
  // The suite under test must be a real runner. Inheriting this process's
  // child-v8 context makes `node --test` refuse to run files.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [...flags, "test/stack.test.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr.slice(-800));
  // Node's default reporter changed from tap to spec, so the summary line is
  // `# tests N` on some versions and `i tests N` on others. Accept either
  // instead of assuming one, and fail loudly when neither is present rather
  // than comparing NaN and reporting a confusing count.
  const counts = [...result.stdout.matchAll(/^(?:#|\u2139) tests (\d+)$/gm)].map((match) => Number(match[1]));
  const reported = Math.max(0, ...counts);
  assert.ok(counts.length > 0, `no test count in the runner summary:\n${result.stdout.slice(-800)}`);
  assert.ok(reported >= declared, `runner reported ${reported} results but ${declared} tests are declared`);
});


test('case persistence rejects a combined oversized case before replacing latest', () => {
  const outputRoot = tempRoot();
  const save = (runId, stages) => persistRunBundle({
    outputRoot, runId, report: {run_id: runId, stages: {}}, stages,
    componentProvenance: [], exitCode: 0,
  });
  save('previous-readable-case', {});
  const latest = readFileSync(join(outputRoot, 'latest.json'), 'utf8');
  assert.throws(() => save('oversized-combination', {
    decide: {status: 'passed', raw: {pad: 'x'.repeat(600000)}},
    act: {status: 'passed', raw: {pad: 'y'.repeat(600000)}},
  }), /replay byte limit; no case was saved/);
  assert.equal(readFileSync(join(outputRoot, 'latest.json'), 'utf8'), latest);
  assert.deepEqual(readdirSync(join(outputRoot, 'runs')), ['previous-readable-case']);
  assert.equal(exportRunBundle('previous-readable-case', {outputRoot}).manifest.run_id, 'previous-readable-case');
});

test('case persistence accounts for pretty printing and UTF-8 bytes', () => {
  for (const raw of [{rows: Array(30000).fill({x: 0})}, {pad: '界'.repeat(360000)}]) {
    const outputRoot = tempRoot();
    assert.throws(() => persistRunBundle({
      outputRoot, runId: 'oversized-representation', report: {run_id: 'oversized-representation'},
      stages: {decide: {status: 'passed', raw}}, componentProvenance: [], exitCode: 0,
    }), /replay byte limit; no case was saved/);
    assert.equal(existsSync(join(outputRoot, 'latest.json')), false);
    assert.equal(existsSync(join(outputRoot, 'runs')), false);
  }
});

test('successfully persisted cases round-trip at the exact portable byte limit', () => {
  const outputRoot = tempRoot();
  const runId = 'exact-portable-limit';
  const parameters = {
    outputRoot, runId, report: {run_id: runId}, stages: {decide: {status: 'passed', raw: {pad: ''}}},
    componentProvenance: [], exitCode: 0, now: '2026-10-15T00:00:00.000Z',
  };
  const probeRoot = tempRoot();
  persistRunBundle({...parameters, outputRoot: probeRoot});
  const empty = exportRunBundle(runId, {outputRoot: probeRoot});
  const size = Buffer.byteLength(JSON.stringify(empty, null, 2) + '\n');
  parameters.stages.decide.raw.pad = 'x'.repeat(CHILD_JSON_LIMIT - size);
  persistRunBundle(parameters);
  const result = exportRunBundle(runId, {outputRoot});
  assert.equal(Buffer.byteLength(JSON.stringify(result, null, 2) + '\n'), CHILD_JSON_LIMIT);
  assert.equal(result.stages.decide.pad, parameters.stages.decide.raw.pad);
  assert.throws(() => persistRunBundle({...parameters, outputRoot: tempRoot(),
    stages: {decide: {status: 'passed', raw: {pad: parameters.stages.decide.raw.pad + 'x'}}},
  }), /replay byte limit/);
});


test("runDemo preserves the previous case when finalization fails in any stage", async () => {
  const large = { rows: Array.from({ length: 30_000 }, () => ({ x: 0 })) };
  const scenarios = [
    { name: "policy-denied", decide: { ok: false, raw: { passed: false, ...large } } },
    { name: "act-failed", act: { ok: false, raw: { ...large } } },
    { name: "settled", act: { ok: true, raw: { outcome: "settled", ...large } } },
    { name: "prove-passed", prove: { ok: true, raw: { ...large } } },
    { name: "prove-failed", prove: { ok: false, raw: { ...large } } },
  ];
  for (const scenario of scenarios) {
    const outputRoot = tempRoot();
    await runDemo([], stubOptions(outputRoot, { runId: "previous" }));
    const previous = readFileSync(join(outputRoot, "latest.json"), "utf8");
    await assert.rejects(runDemo([], {
      paths: { outputRoot },
      runId: scenario.name,
      componentResolver: () => [],
      runDecideFn: async () => scenario.decide ?? { ok: true, raw: { passed: true } },
      runActFn: async () => scenario.act ?? { ok: true, raw: { outcome: "disputed" } },
      runProveFn: async () => scenario.prove,
    }), /replay byte limit; no case was saved/, scenario.name);
    assert.equal(readFileSync(join(outputRoot, "latest.json"), "utf8"), previous, scenario.name);
    assert.deepEqual(readdirSync(join(outputRoot, "runs")), ["previous"], scenario.name);
  }
});

function captureHuman(report, bundleDir = null) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(String(chunk));
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  try {
    printHuman(report, bundleDir);
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("").split("\n").filter((line) => line !== "");
}

test("every rail demo fault parses for its own domain and is refused for the other", () => {
  assert.equal(DEMO_FAULTS_BY_DOMAIN.refund.length, 13);
  assert.equal(DEMO_FAULTS_BY_DOMAIN.inventory.length, 10);
  for (const [domain, faults] of Object.entries(DEMO_FAULTS_BY_DOMAIN)) {
    for (const fault of faults) {
      const prove = NO_RECEIPT_FAULTS[domain].includes(fault) ? "simulate" : "rail";
      assert.deepEqual(
        parseDemoOptions(["--domain", domain, "--fault", fault, "--prove", prove]),
        { responseName: "pass", fault, forceDispute: false, asJson: false, proveMode: prove, domain },
      );
    }
  }
  for (const fault of ["permit-replay", "action-mutation", "tampered-bundle"]) {
    assert.throws(
      () => parseDemoOptions(["--domain", "inventory", "--fault", fault]),
      (error) => error.name === "UsageError" && /--fault must be one of the inventory faults: none, duplicate, /.test(error.message),
    );
  }
  assert.throws(() => parseDemoOptions(["--fault", "explode"]), /refund faults/);
  assert.throws(() => parseDemoOptions(["--domain", "inventory", "--fault", "explode"]), /inventory faults/);
});

test("same-case review of a no-receipt fault is a usage error before any probe or bundle", async () => {
  for (const [domain, faults] of Object.entries(NO_RECEIPT_FAULTS)) {
    for (const fault of faults) {
      const outputRoot = tempRoot();
      let actCalls = 0;
      await assert.rejects(
        () => runDemo(["--domain", domain, "--fault", fault, "--prove", "rail"], stubOptions(outputRoot, {
          runActFn: async () => { actCalls += 1; return { ok: true, raw: { outcome: null }, status: 0 }; },
        })),
        (error) => error.name === "UsageError"
          && error.message === `fault ${fault} produces no settlement receipt, so --prove rail has no same-case evidence; use --prove simulate`,
      );
      assert.equal(actCalls, 0);
      assert.equal(existsSync(join(outputRoot, "runs")), false, `${domain} ${fault} wrote a case`);
      assert.equal(existsSync(join(outputRoot, "latest.json")), false);
    }
  }
  // main validates before the Node.js floor and the Python probe: an
  // unusable runtime still reports the usage error with exit 2.
  const result = await captureMain(["demo", "--fault", "action-mutation", "--prove", "rail"], { nodeVersion: "20.0.0" });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /fault action-mutation produces no settlement receipt/);
  assert.equal(result.stdout, "");
});

test("a no-receipt fault with the canned simulation goes to prove with a null outcome", async () => {
  const outputRoot = tempRoot();
  const result = await runDemo(["--fault", "lost-response-before-commit"], stubOptions(outputRoot, {
    runId: "no-receipt-run",
    runActFn: async () => ({ ok: true, raw: { outcome: null, state: "FAILED", fault: "lost-response-before-commit", action_id: "act-n", expected_rejection: null, tamper_detection: null }, status: 0 }),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.stages.act.outcome, null);
  assert.equal(result.report.stages.prove.status, "passed");
  assert.equal(result.report.stages.prove.mode, "simulate");
  assert.equal(result.report.stages.prove.triggered_by, "act_outcome=null");
  const lines = captureHuman(result.report);
  assert.ok(lines.includes("act_outcome: none"));
  assert.ok(lines.includes("act_state: FAILED"));
});

test("a disputed rail outcome records a same-case review and the case history can filter it", async () => {
  const outputRoot = tempRoot();
  let reviewed = null;
  const disputed = await runDemo(["--fault", "stale-evidence", "--prove", "rail"], stubOptions(outputRoot, {
    runId: "2035-disputed-run",
    runActFn: async () => ({ ok: true, raw: { outcome: "disputed", state: "CLOSED", fault: "stale-evidence", action_id: "act-d", expected_rejection: null, tamper_detection: null, rail_bundle: { action: { action_id: "act-d" } } }, status: 0 }),
    runProveRailFn: async (bundle) => {
      reviewed = bundle;
      return { ok: true, raw: { ok: true, result: { verdict: "recorded", reviewId: "review-d", actionId: "act-d" } }, status: 0 };
    },
  }));
  assert.equal(disputed.exitCode, 0);
  assert.deepEqual(reviewed, { action: { action_id: "act-d" } });
  assert.equal(disputed.report.stages.act.outcome, "disputed");
  assert.equal(disputed.report.stages.act.rejection_code, null);
  assert.equal(disputed.report.stages.act.tamper_code, null);
  assert.equal(disputed.report.stages.prove.mode, "rail-review");
  assert.equal(disputed.report.stages.prove.triggered_by, "act_outcome=disputed");
  assert.equal(disputed.report.stages.prove.review_verdict, "recorded");
  assert.equal(disputed.report.requested_options.fault, "stale-evidence");
  await runDemo([], stubOptions(outputRoot, { runId: "2035-settled-run" }));
  const filtered = await captureMain(["cases", "--root", outputRoot, "--outcome", "disputed", "--json"]);
  assert.equal(filtered.exitCode, 0);
  assert.deepEqual(JSON.parse(filtered.stdout).cases.map((entry) => entry.run_id), ["2035-disputed-run"]);
  const settled = await captureMain(["cases", "--root", outputRoot, "--outcome", "settled", "--json"]);
  assert.deepEqual(JSON.parse(settled.stdout).cases.map((entry) => entry.run_id), ["2035-settled-run"]);
  const bogus = await captureMain(["cases", "--root", outputRoot, "--outcome", "unresolved"]);
  assert.equal(bogus.exitCode, 2);
  assert.match(bogus.stderr, /Invalid outcome filter/);
});

test("the rail's rejection and tamper codes reach the report and print only when present", async () => {
  const outputRoot = tempRoot();
  const permit = await runDemo(["--fault", "permit-replay"], stubOptions(outputRoot, {
    runId: "permit-run",
    runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED", fault: "permit-replay", action_id: "act-p", expected_rejection: { code: "PERMIT_USED", message: "consumed" }, tamper_detection: null }, status: 0 }),
  }));
  assert.equal(permit.report.stages.act.rejection_code, "PERMIT_USED");
  assert.equal(permit.report.stages.act.tamper_code, null);
  assert.equal(permit.report.stages.prove.status, "skipped");
  const permitLines = captureHuman(permit.report, permit.bundleDir);
  assert.equal(permitLines[12], "flow: decide -> act");
  assert.equal(permitLines[13], "act_rejection: PERMIT_USED");
  assert.equal(permitLines.some((line) => line.startsWith("act_tamper:")), false);
  assert.equal(permitLines.at(-1), `bundle: ${permit.bundleDir}`);

  const tampered = await runDemo(["--fault", "tampered-bundle"], stubOptions(outputRoot, {
    runId: "tamper-run",
    runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED", fault: "tampered-bundle", action_id: "act-t", expected_rejection: null, tamper_detection: { detected: true, code: "BUNDLE_TAMPERED" } }, status: 0 }),
  }));
  assert.equal(tampered.report.stages.act.tamper_code, "BUNDLE_TAMPERED");
  assert.equal(tampered.report.stages.act.rejection_code, null);
  const tamperedLines = captureHuman(tampered.report);
  assert.equal(tamperedLines[13], "act_tamper: BUNDLE_TAMPERED");
  assert.equal(tamperedLines.some((line) => line.startsWith("act_rejection:")), false);

  const undetected = await runDemo([], stubOptions(outputRoot, {
    runId: "undetected-run",
    runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED", fault: "none", action_id: "act-u", tamper_detection: { detected: false, code: null } }, status: 0 }),
  }));
  assert.equal(undetected.report.stages.act.tamper_code, null);
  const plain = captureHuman(undetected.report);
  assert.equal(plain.length, 13);
  assert.equal(plain.some((line) => /^act_(rejection|tamper):/.test(line)), false);
});

test("act rejects malformed rejection and tamper objects from the rail", () => {
  const act = (extra) => runAct("none", {
    depsDir: tempRoot(),
    runner: () => ({ status: 0, stdout: JSON.stringify({ outcome: "settled", state: "CLOSED", ...extra }), stderr: "", error: null }),
  });
  for (const [extra, field] of [
    [{ expected_rejection: "PERMIT_USED" }, "expected_rejection"],
    [{ expected_rejection: { code: 7 } }, "expected_rejection"],
    [{ tamper_detection: [] }, "tamper_detection"],
    [{ tamper_detection: { detected: "yes" } }, "tamper_detection"],
    [{ tamper_detection: { detected: true } }, "tamper_detection"],
  ]) {
    assert.throws(() => act(extra), (error) => {
      assert.match(error.message, new RegExp(`valid ${field} field`));
      assert.equal(error.code, DIAGNOSTIC.CHILD_JSON);
      return true;
    }, JSON.stringify(extra));
  }
  assert.equal(act({ expected_rejection: null, tamper_detection: { detected: false, code: null } }).ok, true);
  assert.equal(act({ expected_rejection: { code: "DIGEST_MISMATCH", message: "m" } }).ok, true);
});

test("CLI help lists every fault per domain and the disputed outcome filter", () => {
  const text = helpText();
  const faults = text.split("Faults (")[1].split("First-time setup:")[0];
  const refund = faults.split("refund:")[1].split("inventory:")[0];
  const inventory = faults.split("inventory:")[1].split("No settlement receipt")[0];
  for (const fault of DEMO_FAULTS_BY_DOMAIN.refund) assert.match(refund, new RegExp(`(?:^|[\\s,])${fault}(?:,|\\s|$)`), fault);
  for (const fault of DEMO_FAULTS_BY_DOMAIN.inventory) assert.match(inventory, new RegExp(`(?:^|[\\s,])${fault}(?:,|\\s|$)`), fault);
  assert.doesNotMatch(inventory, /permit-replay|action-mutation|tampered-bundle/);
  assert.match(text, /--outcome settled\|compensated\|disputed\|none/);
  for (const line of faults.split("\n")) assert.ok(line.length <= 80, `fault help line too long: ${line}`);
});

const OLD_COMMIT = "1111111111111111111111111111111111111111";

/**
 * A fake git for an existing checkout of `component`. It starts at `commit`;
 * a `checkout` moves it to the requested commit. `failOn` makes that
 * subcommand exit 128 with git-like stderr.
 */
function existingCheckout(component, { commit = OLD_COMMIT, origin = component.repository, detached = true, clean = true, failOn = null } = {}) {
  const deps = tempRoot();
  const target = join(deps, component.name);
  mkdirSync(join(target, ".git"), { recursive: true });
  for (const entrypoint of component.expected_entrypoints) {
    mkdirSync(join(target, entrypoint, ".."), { recursive: true });
    writeFileSync(join(target, entrypoint), "fixture\n");
  }
  const state = { commit };
  const calls = [];
  const command = (name, args) => {
    assert.equal(name, "git");
    calls.push(args.slice(2).join(" "));
    const sub = args[2];
    if (sub === failOn) return { status: 128, stdout: "", stderr: "fatal: remote error: upload-pack: not our ref", error: null };
    if (sub === "config") return { status: 0, stdout: `${origin}\n`, stderr: "", error: null };
    if (sub === "rev-parse") return { status: 0, stdout: `${state.commit}\n`, stderr: "", error: null };
    if (sub === "symbolic-ref") return { status: detached ? 1 : 0, stdout: detached ? "" : "main\n", stderr: "", error: null };
    if (sub === "status") return { status: 0, stdout: clean ? "" : " M fixture\n", stderr: "", error: null };
    if (sub === "fetch") return { status: 0, stdout: "", stderr: "", error: null };
    if (sub === "checkout") {
      state.commit = args.at(-1);
      return { status: 0, stdout: "", stderr: "", error: null };
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
  return { deps, target, command, calls, state };
}

function captureBootstrap(argv, options) {
  const stdout = [];
  const stderr = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalExitCode = process.exitCode;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  process.exitCode = undefined;
  try {
    bootstrapMain(argv, options);
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode ?? 0 };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = originalExitCode;
  }
}

test("a stale checkout is refused with both commits and the bootstrap:update remedy, and nothing is fetched", () => {
  const component = loadComponentLock(LOCK).find((entry) => entry.name === "constitutional-agent-testbench");
  const checkout = existingCheckout(component);
  const expected = `Pre-existing dependency commit does not match the lock: ${component.name} (checkout 1111111, lock ${component.commit.slice(0, 7)}). Run npm run bootstrap:update to move this clean checkout to the locked commit, or remove deps/${component.name} and run npm run bootstrap.`;
  assert.throws(() => prepareDependencies({ deps: checkout.deps, components: [component], command: checkout.command }), { message: expected });
  assert.equal(checkout.calls.some((call) => call.startsWith("fetch") || call.startsWith("checkout")), false);
  assert.equal(checkout.state.commit, OLD_COMMIT);
  // `aas demo` and the GUI resolve provenance through the same inspection.
  assert.throws(() => inspectDependencyDirectory(checkout.target, component, { command: checkout.command }), { message: expected });
  const classified = classifyDependency(checkout.target, component, { command: checkout.command });
  assert.equal(classified.state, "stale");
  assert.equal(classified.commit, OLD_COMMIT);
  assert.equal(classified.locked_commit, component.commit);
});

test("bootstrap --update fetches then checks out the locked commit for a clean detached stale checkout", () => {
  const component = loadComponentLock(LOCK).find((entry) => entry.name === "constitutional-agent-testbench");
  const checkout = existingCheckout(component);
  const prepared = prepareDependencies({ deps: checkout.deps, components: [component], command: checkout.command, update: true });
  const fetchIndex = checkout.calls.indexOf(`fetch --depth 1 origin ${component.commit}`);
  const checkoutIndex = checkout.calls.indexOf(`checkout --detach --quiet ${component.commit}`);
  assert.ok(fetchIndex >= 0 && checkoutIndex > fetchIndex, checkout.calls.join("\n"));
  assert.equal(prepared[0].commit, component.commit);
  assert.equal(prepared[0].updated_from, OLD_COMMIT);

  const again = existingCheckout(component);
  const output = captureBootstrap(["--update"], { deps: again.deps, components: [component], command: again.command });
  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stdout, `deps/${component.name}: ${component.commit} detached clean (updated from ${OLD_COMMIT})\nBootstrap complete.\n`);
  // A checkout already at the lock is left alone even with --update.
  const current = existingCheckout(component, { commit: component.commit });
  const unchanged = prepareDependencies({ deps: current.deps, components: [component], command: current.command, update: true });
  assert.equal(unchanged[0].updated_from, undefined);
  assert.equal(current.calls.some((call) => call.startsWith("fetch")), false);
});

test("bootstrap --update still refuses dirty, substituted, and attached checkouts", () => {
  const component = loadComponentLock(LOCK).find((entry) => entry.name === "constitutional-agent-testbench");
  for (const [options, pattern, state] of [
    [{ clean: false }, /has local changes: constitutional-agent-testbench\. Remove deps\/constitutional-agent-testbench and run npm run bootstrap\./, "dirty"],
    [{ origin: "https://github.com/example/substitute.git" }, /origin does not match the lock: constitutional-agent-testbench\. Remove deps\//, "substituted"],
    [{ detached: false }, /is not detached at the locked commit: constitutional-agent-testbench\. Remove deps\//, "attached"],
  ]) {
    const checkout = existingCheckout(component, options);
    assert.throws(() => prepareDependencies({ deps: checkout.deps, components: [component], command: checkout.command, update: true }), pattern);
    assert.equal(checkout.calls.some((call) => call.startsWith("fetch") || call.startsWith("checkout")), false, JSON.stringify(options));
    assert.equal(classifyDependency(checkout.target, component, { command: checkout.command }).state, state);
  }
});

test("a failed update fetch leaves the old commit and reports git's own text", () => {
  const component = loadComponentLock(LOCK).find((entry) => entry.name === "constitutional-agent-testbench");
  const checkout = existingCheckout(component, { failOn: "fetch" });
  assert.throws(
    () => prepareDependencies({ deps: checkout.deps, components: [component], command: checkout.command, update: true }),
    (error) => {
      assert.match(error.message, new RegExp(`^Could not update ${component.name} from ${OLD_COMMIT} to ${component.commit}: Command failed: git .* fetch --depth 1 origin ${component.commit} \\(exit 128\\): fatal: remote error: upload-pack: not our ref\\. deps/${component.name} was left at ${OLD_COMMIT}\\.$`));
      return true;
    },
  );
  assert.equal(checkout.state.commit, OLD_COMMIT);
  assert.equal(checkout.calls.some((call) => call.startsWith("checkout")), false);
});

test("bootstrap honours --help and rejects unknown arguments instead of running a full bootstrap", () => {
  let calls = 0;
  const command = () => { calls += 1; throw new Error("must not spawn"); };
  for (const argv of [["--help"], ["-h"], ["--update", "--help"]]) {
    const help = captureBootstrap(argv, { deps: tempRoot(), command });
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /^Usage: npm run bootstrap\n {7}npm run bootstrap:update\n/);
    assert.match(help.stdout, /--update {4}Move a clean, detached checkout/);
    assert.equal(help.stderr, "");
  }
  for (const [argv, message] of [[["--bogus"], "Unsupported bootstrap argument: --bogus"], [["extra"], "Unsupported bootstrap argument: extra"], [["--update", "--update"], "Duplicate bootstrap option: --update"]]) {
    const rejected = captureBootstrap(argv, { deps: tempRoot(), command });
    assert.equal(rejected.exitCode, 2, argv.join(" "));
    assert.ok(rejected.stderr.startsWith(`${message}\nUsage: npm run bootstrap\n`), rejected.stderr);
    assert.equal(rejected.stdout, "");
  }
  assert.equal(calls, 0);
  assert.equal(parseBootstrapArgs([]).update, false);
  assert.equal(parseBootstrapArgs(["--update"]).update, true);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["bootstrap:update"], "node ./scripts/bootstrap.mjs --update");
  assert.equal(pkg.scripts.bootstrap, "node ./scripts/bootstrap.mjs");
});

test("dependency classification names every state without throwing", (t) => {
  const component = loadComponentLock(LOCK)[0];
  assert.equal(classifyDependency(join(tempRoot(), "absent"), component).state, "missing");
  const file = join(tempRoot(), component.name);
  writeFileSync(file, "not a directory\n");
  assert.deepEqual([classifyDependency(file, component).state, classifyDependency(file, component).detail], ["unusable", "not-directory"]);
  const noGit = join(tempRoot(), component.name);
  mkdirSync(noGit);
  assert.deepEqual([classifyDependency(noGit, component).state, classifyDependency(noGit, component).detail], ["unusable", "no-git"]);
  assert.throws(() => inspectDependencyDirectory(noGit, component), /without Git metadata: constitutional-agent-testbench\. Remove deps\//);
  const ready = existingCheckout(component, { commit: component.commit });
  assert.equal(classifyDependency(ready.target, component, { command: ready.command }).state, "ready");
  const unbuilt = { ...component, expected_entrypoints: [...component.expected_entrypoints, "dist/cli.js"] };
  const missing = classifyDependency(ready.target, unbuilt, { command: ready.command });
  assert.equal(missing.state, "missing-entrypoints");
  assert.deepEqual(missing.missing_entrypoints, ["dist/cli.js"]);
  assert.throws(() => inspectDependencyDirectory(ready.target, unbuilt, { command: ready.command }), /missing expected entrypoints: constitutional-agent-testbench \(dist\/cli\.js\)\. Run npm run bootstrap to rebuild it/);
  const broken = () => ({ status: 128, stdout: "", stderr: "fatal", error: null });
  assert.deepEqual([classifyDependency(ready.target, component, { command: broken }).state, classifyDependency(ready.target, component, { command: broken }).detail], ["unusable", "git-failed"]);
  const link = join(tempRoot(), component.name);
  if (!linkOrSkip(t, ready.target, link, "junction")) return;
  assert.equal(classifyDependency(link, component, { command: ready.command }).state, "unusable");
});

test("checkout revisions are read from .git/HEAD without spawning git", () => {
  const sha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const detached = tempRoot();
  mkdirSync(join(detached, ".git"));
  writeFileSync(join(detached, ".git", "HEAD"), `${sha}\n`);
  assert.equal(readCheckoutCommit(detached), sha);
  const attached = tempRoot();
  mkdirSync(join(attached, ".git"));
  writeFileSync(join(attached, ".git", "HEAD"), "ref: refs/heads/main\n");
  assert.equal(readCheckoutCommit(attached), null);
  assert.equal(readCheckoutCommit(tempRoot()), null, "no Git metadata");
  assert.equal(readCheckoutCommit(join(tempRoot(), "absent")), null);
  const worktree = tempRoot();
  writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n");
  assert.equal(readCheckoutCommit(worktree), null, ".git file");
  const short = tempRoot();
  mkdirSync(join(short, ".git"));
  writeFileSync(join(short, ".git", "HEAD"), "abc123\n");
  assert.equal(readCheckoutCommit(short), null);
});

test("bootstrap --update moves a real checkout to a new commit over a file URL", () => {
  const git = (cwd, args) => execFileSync("git", ["-c", "user.name=AAS Test", "-c", "user.email=aas@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const work = tempRoot();
  git(work, ["init", "--quiet"]);
  writeFileSync(join(work, "entry.txt"), "first\n");
  git(work, ["add", "entry.txt"]);
  git(work, ["commit", "--quiet", "-m", "first"]);
  const first = git(work, ["rev-parse", "HEAD"]);
  writeFileSync(join(work, "entry.txt"), "second\n");
  writeFileSync(join(work, "added.txt"), "only in the second commit\n");
  git(work, ["add", "entry.txt", "added.txt"]);
  git(work, ["commit", "--quiet", "-m", "second"]);
  const second = git(work, ["rev-parse", "HEAD"]);
  const bare = join(tempRoot(), "component.git");
  git(work, ["clone", "--quiet", "--bare", work, bare]);
  const repository = pathToFileURL(bare).href;
  const deps = tempRoot();
  const component = (commit, entrypoints = ["entry.txt"]) => ({ name: "fixture-component", repository, commit, expected_entrypoints: entrypoints });
  const cloned = prepareDependencies({ deps, components: [component(first)] });
  assert.equal(cloned[0].commit, first);
  const target = join(deps, "fixture-component");
  assert.equal(readCheckoutCommit(target), first);
  assert.throws(() => prepareDependencies({ deps, components: [component(second, ["entry.txt", "added.txt"])] }), /bootstrap:update/);
  assert.equal(readCheckoutCommit(target), first);
  const updated = prepareDependencies({ deps, components: [component(second, ["entry.txt", "added.txt"])], update: true });
  assert.equal(updated[0].commit, second);
  assert.equal(updated[0].updated_from, first);
  assert.equal(readCheckoutCommit(target), second);
  assert.equal(readFileSync(join(target, "entry.txt"), "utf8").replaceAll("\r\n", "\n"), "second\n");
  assert.equal(git(target, ["status", "--porcelain"]), "");
});

const RAIL_PIN = PROVENANCE.find((entry) => entry.name === "consequence-rail").commit;
const MB_PIN = PROVENANCE.find((entry) => entry.name === "mandatebound").commit;

/** A deps directory holding only the two verifier entrypoints and their HEADs. */
function verifierDeps({ rail = RAIL_PIN, mandatebound = MB_PIN, omit = null } = {}) {
  const deps = tempRoot();
  for (const [name, entrypoint, head] of [["consequence-rail", "cmd/crctl.js", rail], ["mandatebound", "dist/cli.js", mandatebound]]) {
    if (omit === name) continue;
    mkdirSync(join(deps, name, entrypoint, ".."), { recursive: true });
    writeFileSync(join(deps, name, entrypoint), "// fixture\n");
    if (head !== null) {
      mkdirSync(join(deps, name, ".git"), { recursive: true });
      writeFileSync(join(deps, name, ".git", "HEAD"), `${head}\n`);
    }
  }
  return deps;
}

/**
 * A store with one case per verify status, newest first:
 * 2035-05 verified, 2035-04 unavailable (simulate), 2035-03 conflicting
 * (digest altered), 2035-02 unsupported (rail verifier rejects), 2035-01
 * unreadable (corrupt manifest).
 */
async function verifyStore({ only = null } = {}) {
  const outputRoot = tempRoot();
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
  const railCase = (runId, recorded) => runDemo(["--fault", "duplicate", "--prove", "rail"], stubOptions(outputRoot, {
    runId,
    runActFn: async () => ({ ok: true, raw: { outcome: "compensated", state: "CLOSED", fault: "duplicate", action_id: "act_replay_1", rail_bundle: structuredClone(railBundle) }, status: 0 }),
    runProveRailFn: async () => ({ ok: true, raw: { ok: true, result: recorded }, status: 0 }),
  }));
  const wanted = (name) => only === null || only.includes(name);
  if (wanted("verified")) await railCase("2035-05-verified", review);
  if (wanted("unavailable")) await runDemo([], stubOptions(outputRoot, { runId: "2035-04-unavailable" }));
  if (wanted("conflicting")) await railCase("2035-03-conflicting", { ...review, evidenceDigest: `sha256:${"0".repeat(64)}` });
  if (wanted("unsupported")) await railCase("2035-02-unsupported", { ...review, upstream: { ...review.upstream, outcome: "settled" } });
  if (wanted("unreadable")) {
    mkdirSync(join(outputRoot, "runs", "2035-01-unreadable"), { recursive: true });
    writeFileSync(join(outputRoot, "runs", "2035-01-unreadable", "manifest.json"), "{not json");
  }
  const verification = { valid: true, action_id: "act_replay_1", outcome: "compensated", trusted_key_id: "k", trusted_connector_key_id: "c" };
  return { outputRoot, runner: replayRunnerFixture(verification, review) };
}

test("verify --all classifies every case of a page and fails on conflicting, unsupported, or unreadable cases", async () => {
  const { outputRoot, runner } = await verifyStore();
  const depsDir = verifierDeps();
  const page = verifyCasePage({ outputRoot, depsDir, lockPath: LOCK, runner });
  assert.equal(page.schema_version, "agent-action-stack.verify-batch/v1");
  assert.deepEqual(page.results.map((entry) => [entry.run_id, entry.status]), [
    ["2035-05-verified", "verified"],
    ["2035-04-unavailable", "unavailable"],
    ["2035-03-conflicting", "conflicting"],
    ["2035-02-unsupported", "unsupported"],
    ["2035-01-unreadable", "unreadable"],
  ]);
  assert.deepEqual(page.counts, { verified: 1, unavailable: 1, conflicting: 1, unsupported: 1, unreadable: 1, error: 0 });
  assert.equal(page.scanned, 5);
  assert.equal(page.next_cursor, null);
  assert.equal(page.results[0].reason, null);
  assert.match(page.results[2].reason, /^conflicting: /);
  assert.equal(page.results[4].reason, "Case file contains invalid JSON.");
  assert.deepEqual(page.results[0].recorded_pins, [{ name: "consequence-rail", commit: RAIL_PIN }, { name: "mandatebound", commit: MB_PIN }]);
  assert.deepEqual(page.results[0].pins_differ, []);
  assert.deepEqual(page.results[4].recorded_pins, []);
  assert.equal(page.results[4].pins_differ, null);
  assert.deepEqual(page.verifier, [
    { name: "consequence-rail", checkout_commit: RAIL_PIN, locked_commit: RAIL_PIN, matches_lock: true },
    { name: "mandatebound", checkout_commit: MB_PIN, locked_commit: MB_PIN, matches_lock: true },
  ]);

  const cli = await captureMain(["verify", "--all", "--root", outputRoot], { verifyOptions: { depsDir, lockPath: LOCK, runner } });
  assert.equal(cli.exitCode, 1);
  const lines = cli.stdout.trimEnd().split("\n");
  assert.equal(lines[0], `verifier consequence-rail: ${RAIL_PIN} (lock ${RAIL_PIN})`);
  assert.equal(lines[2], "2035-05-verified verified");
  assert.match(lines[3], /^2035-04-unavailable unavailable: this run persisted no rail bundle/);
  assert.ok(lines.includes("counts: verified=1 unavailable=1 conflicting=1 unsupported=1 unreadable=1 error=0"));
  assert.ok(lines.includes("scanned: 5"));
  assert.equal(lines.at(-1), "next_cursor: none");
  const json = await captureMain(["verify", "--all", "--root", outputRoot, "--json"], { verifyOptions: { depsDir, lockPath: LOCK, runner } });
  assert.equal(json.exitCode, 1);
  assert.equal(JSON.parse(json.stdout).ok, false);
  assert.deepEqual(JSON.parse(json.stdout).counts, page.counts);
});

test("verify --all exits 0 when every case verified or is only unavailable", async () => {
  const depsDir = verifierDeps();
  for (const only of [["verified"], ["unavailable"], ["verified", "unavailable"]]) {
    const { outputRoot, runner } = await verifyStore({ only });
    const result = await captureMain(["verify", "--all", "--root", outputRoot, "--json"], { verifyOptions: { depsDir, lockPath: LOCK, runner } });
    assert.equal(result.exitCode, 0, only.join(","));
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  const empty = await captureMain(["verify", "--all", "--root", tempRoot()], { verifyOptions: { depsDir, lockPath: LOCK } });
  assert.equal(empty.exitCode, 0);
  assert.match(empty.stdout, /no cases in this page\n/);
});

test("verify --all pages a store with the cases cursor", async () => {
  const { outputRoot, runner } = await verifyStore();
  const depsDir = verifierDeps();
  const seen = [];
  let before = null;
  const cursors = [];
  for (let page = 0; page < 3; page += 1) {
    const result = verifyCasePage({ outputRoot, depsDir, lockPath: LOCK, runner, limit: 2, before });
    seen.push(...result.results.map((entry) => entry.run_id));
    cursors.push(result.next_cursor);
    before = result.next_cursor;
  }
  assert.deepEqual(seen, ["2035-05-verified", "2035-04-unavailable", "2035-03-conflicting", "2035-02-unsupported", "2035-01-unreadable"]);
  assert.deepEqual(cursors, ["2035-04-unavailable", "2035-02-unsupported", null]);
  const cli = await captureMain(["verify", "--all", "--root", outputRoot, "--limit", "2"], { verifyOptions: { depsDir, lockPath: LOCK, runner } });
  assert.match(cli.stdout, /next_cursor: 2035-04-unavailable\nContinue with --before 2035-04-unavailable and the same root and page options\.\n$/);
  const second = await captureMain(["verify", "--all", "--root", outputRoot, "--limit", "2", "--before", "2035-04-unavailable", "--json"], { verifyOptions: { depsDir, lockPath: LOCK, runner } });
  assert.deepEqual(JSON.parse(second.stdout).results.map((entry) => entry.run_id), ["2035-03-conflicting", "2035-02-unsupported"]);
});

test("verify --all usage errors exit 2 before any verification", async () => {
  let calls = 0;
  const runner = () => { calls += 1; throw new Error("must not run"); };
  for (const argv of [
    ["verify", "--all", "some-run"],
    ["verify", "--all", "--all"],
    ["verify", "--all", "--limit", "0"],
    ["verify", "--all", "--limit", "51"],
    ["verify", "--all", "--limit"],
    ["verify", "--all", "--before", "../escape"],
    ["verify", "--all", "--bogus"],
    ["verify", "--before", "2035-01-a"],
    ["verify", "some-run", "--limit", "5"],
  ]) {
    const result = await captureMain(argv, { nodeVersion: "20.0.0", verifyOptions: { runner } });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.match(result.stderr, /aas verify --all \[--root output-dir\]/, argv.join(" "));
  }
  assert.equal(calls, 0);
});

test("verify --all aborts once with the bootstrap hint when a verifier is missing", async () => {
  const { outputRoot, runner } = await verifyStore({ only: ["verified", "unavailable"] });
  for (const omit of ["consequence-rail", "mandatebound"]) {
    const depsDir = verifierDeps({ omit });
    assert.throws(() => verifyCasePage({ outputRoot, depsDir, lockPath: LOCK, runner }), /^Error: Missing verifier deps\/(consequence-rail\/cmd\/crctl|mandatebound\/dist\/cli)\.js\. Run: npm run bootstrap$/);
    const cli = await captureMain(["verify", "--all", "--root", outputRoot], { verifyOptions: { depsDir, lockPath: LOCK, runner } });
    assert.equal(cli.exitCode, 1);
    assert.equal(cli.stdout, "");
    assert.equal(cli.stderr.match(/npm run bootstrap/g).length, 1);
  }
});

test("verify --all reports the verifier's own checkout commits, never the lock's, and recorded pins that differ", async () => {
  const { outputRoot, runner } = await verifyStore({ only: ["verified"] });
  const other = "2".repeat(40);
  const stale = verifierRevisions({ depsDir: verifierDeps({ mandatebound: other }), lockPath: LOCK });
  assert.deepEqual(stale[1], { name: "mandatebound", checkout_commit: other, locked_commit: MB_PIN, matches_lock: false });
  const page = verifyCasePage({ outputRoot, depsDir: verifierDeps({ mandatebound: other }), lockPath: LOCK, runner });
  assert.deepEqual(page.results[0].pins_differ, ["mandatebound"]);
  const cli = await captureMain(["verify", "--all", "--root", outputRoot], { verifyOptions: { depsDir: verifierDeps({ mandatebound: other }), lockPath: LOCK, runner } });
  assert.match(cli.stdout, new RegExp(`^verifier mandatebound: ${other} \\(lock ${MB_PIN}\\) differs from lock$`, "m"));
  assert.match(cli.stdout, /^2035-05-verified verified \(recorded under other pins: mandatebound\)$/m);
  // No Git metadata (an offline verifier copy) or an attached HEAD: unknown,
  // never inferred from the lock.
  const unknown = verifyCasePage({ outputRoot, depsDir: verifierDeps({ rail: null, mandatebound: null }), lockPath: LOCK, runner });
  assert.deepEqual(unknown.verifier.map((entry) => [entry.checkout_commit, entry.matches_lock]), [[null, null], [null, null]]);
  assert.equal(unknown.results[0].pins_differ, null);
  const attachedDeps = verifierDeps();
  writeFileSync(join(attachedDeps, "consequence-rail", ".git", "HEAD"), "ref: refs/heads/main\n");
  assert.equal(verifierRevisions({ depsDir: attachedDeps, lockPath: LOCK })[0].checkout_commit, null);
  const noLock = verifierRevisions({ depsDir: verifierDeps(), lockPath: join(tempRoot(), "missing-lock.json") });
  assert.deepEqual(noLock.map((entry) => [entry.locked_commit, entry.matches_lock]), [[null, null], [null, null]]);
});

test("verify --all records a verifier that cannot run as an error without stopping the page", async () => {
  const { outputRoot } = await verifyStore({ only: ["verified", "unavailable"] });
  const runner = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }) });
  const page = verifyCasePage({ outputRoot, depsDir: verifierDeps(), lockPath: LOCK, runner });
  assert.deepEqual(page.results.map((entry) => entry.status), ["error", "unavailable"]);
  assert.match(page.results[0].reason, /replay child process error \(ENOENT\)/);
  assert.equal(page.counts.error, 1);
});
