#!/usr/bin/env node
/**
 * Agent Action Stack orchestrator.
 *
 * Flow:
 *   1. Decide with Constitutional Agent Testbench.
 *   2. On pass, act with Consequence Rail.
 *   3. On dispute, prove with MandateBound.
 *
 * Public dependencies only. Each invocation receives an isolated run bundle.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertFullStackNodeVersion,
  inspectDependencyDirectory,
  loadComponentLock,
} from "../scripts/bootstrap.mjs";

/**
 * @typedef {object} ChildResult
 * @property {number} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error} [error]
 *
 * @typedef {object} ComponentProvenance
 * @property {string} name
 * @property {string} repository
 * @property {string} commit
 * @property {string} [origin]
 * @property {boolean} [detached]
 * @property {boolean} [clean]
 * @property {string[]} [entrypoints]
 *
 * @typedef {"pending"|"passed"|"failed"|"skipped"|"error"} StageStatus
 *
 * @typedef {object} DecideStage
 * @property {StageStatus} status
 * @property {boolean} [passed]
 * @property {string|null} [policy_id]
 * @property {unknown} [rule_results]
 * @property {unknown} [error]
 * @property {string} [reason]
 * @property {string} [code]
 * @property {string} [stderr]
 *
 * @typedef {object} ActStage
 * @property {StageStatus} status
 * @property {string|null} [outcome]
 * @property {string|null} [state]
 * @property {string|null} [fault]
 * @property {string|null} [action_id]
 * @property {unknown} [assurance_mode]
 * @property {unknown} [bundle_verification]
 * @property {string} [reason]
 * @property {string} [code]
 * @property {string} [stderr]
 *
 * @typedef {object} ProveStage
 * @property {StageStatus} status
 * @property {string} [scenario]
 * @property {string} [triggered_by]
 * @property {boolean} [ok]
 * @property {string[]} [result_keys]
 * @property {string} [reason]
 * @property {string} [code]
 * @property {string} [stderr]
 *
 * @typedef {object} RunReport
 * @property {"agent-action-stack"} stack
 * @property {"pass"|"fail"} response
 * @property {string} flow
 * @property {string} run_id
 * @property {ComponentProvenance[]} component_provenance
 * @property {{decide: DecideStage, act: ActStage, prove: ProveStage}} stages
 *
 * @typedef {object} DemoResult
 * @property {RunReport} report
 * @property {object} manifest
 * @property {string} bundleDir
 * @property {number} exitCode
 * @property {boolean} asJson
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PATHS = Object.freeze({
  root,
  deps: join(root, "deps"),
  fixtures: join(root, "fixtures"),
  outputRoot: join(root, ".out"),
  lock: join(root, "stack-lock.json"),
});

const STAGE_NAMES = ["decide", "act", "prove"];
const DEMO_FLAG_OPTIONS = new Set(["--dispute", "--json"]);
const DEMO_VALUE_OPTIONS = new Set(["--response", "--fault", "--prove", "--domain"]);
const DEMO_DOMAINS = new Set(["refund", "inventory"]);
const PROVE_MODES = new Set(["simulate", "rail"]);
const STDERR_LIMIT = 800;
/** Child stdout is capped so a runaway tool cannot inflate the run bundle. */
export const CHILD_JSON_LIMIT = 1024 * 1024;
/** Fail closed if a decide/act/prove child hangs. Override with AAS_CHILD_TIMEOUT_MS. */
export const DEFAULT_CHILD_TIMEOUT_MS = 30_000;
export const CHILD_TIMEOUT_MAX_MS = 600_000;
/** Loopback port for `aas-gui`. Override with AAS_GUI_PORT. */
export const DEFAULT_GUI_PORT = 8787;
const DEMO_FAULTS = new Set(["none", "duplicate"]);
const PROVE_SCENARIOS = new Set([
  "principal",
  "operator",
  "model_vendor",
  "unresolved",
  "expiry",
  "replay",
  "tamper",
  "conflict",
  "appeal",
]);
/** Minimum Python required by the locked Constitutional Agent Testbench. */
export const MIN_PYTHON = Object.freeze([3, 11]);
const PYTHON_VERSION_PROBE = "import sys; print(\"%d.%d\" % (sys.version_info[0], sys.version_info[1]))";
export const DIAGNOSTIC = Object.freeze({
  CHILD_SPAWN: "AAS_CHILD_SPAWN",
  CHILD_EXIT: "AAS_CHILD_EXIT",
  CHILD_JSON: "AAS_CHILD_JSON",
  CHILD_TIMEOUT: "AAS_CHILD_TIMEOUT",
});

/**
 * Parse an optional integer environment value.
 * Unset or blank values use `fallback`. Other non-integers fail closed.
 *
 * @param {string} name
 * @param {string|undefined} raw
 * @param {{fallback: number, min: number, max: number}} bounds
 * @returns {number}
 */
export function parseEnvInteger(name, raw, { fallback, min, max }) {
  if (raw === undefined) return fallback;
  const trimmed = String(raw).trim();
  if (trimmed === "") return fallback;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function resolveChildTimeoutMs(env = process.env) {
  return parseEnvInteger("AAS_CHILD_TIMEOUT_MS", env.AAS_CHILD_TIMEOUT_MS, {
    fallback: DEFAULT_CHILD_TIMEOUT_MS,
    min: 1,
    max: CHILD_TIMEOUT_MAX_MS,
  });
}

export function resolveGuiPort(env = process.env) {
  return parseEnvInteger("AAS_GUI_PORT", env.AAS_GUI_PORT, {
    fallback: DEFAULT_GUI_PORT,
    min: 1,
    max: 65535,
  });
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function has(args, name) {
  return args.includes(name);
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function isHelpFlag(value) {
  return value === "--help" || value === "-h";
}

function isHelpToken(value) {
  return value === "help" || isHelpFlag(value);
}

function demoRequestsHelp(args) {
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (isHelpFlag(name)) return true;
    if (DEMO_VALUE_OPTIONS.has(name)) index += 1;
  }
  return false;
}

function validateDemoArgs(args) {
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!DEMO_FLAG_OPTIONS.has(name) && !DEMO_VALUE_OPTIONS.has(name)) {
      if (typeof name === "string" && name.startsWith("-")) {
        throw new UsageError(`Unsupported demo option: ${name}`);
      }
      throw new UsageError(`Unexpected argument: ${name}`);
    }
    if (seen.has(name)) throw new UsageError(`Duplicate demo option: ${name}`);
    seen.add(name);
    if (DEMO_VALUE_OPTIONS.has(name)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) throw new UsageError(`Missing value for demo option: ${name}`);
      if (value.trim() === "") throw new UsageError(`Empty value for demo option: ${name}`);
      index += 1;
    }
  }
}

export function helpText() {
  return `Agent Action Stack

Usage:
  aas demo [--response pass|fail] [--fault none|duplicate] [--dispute] [--prove simulate|rail] [--domain refund|inventory] [--json]
  aas export <run-id> [--out <path>]
  aas replay <bundle-file|-> [--json]
  aas cases [--json]
  aas compare <run-id> <run-id> [--json]
  aas help

Commands:
  demo    Run decide, act, and prove and persist one run bundle
  export  Print one run bundle as portable JSON (or write it with --out)
  replay  Re-verify an exported bundle offline without rerunning the action
  runs    List persisted runs newest-first
  cases   List bounded case summaries (outcome, policy, review, digest)
  compare Compare two cases and classify identical, different, or not comparable
  prune   Remove oldest runs beyond --keep (latest stays; --dry-run previews)

Options:
  --response pass|fail     Policy fixture to evaluate (default: pass)
  --fault none|duplicate   Rail demo fault (default: none)
  --dispute                Force MandateBound prove after a settled act
  --prove simulate|rail    Prove path: canned operator simulation (default)
                           or review of the same-case rail bundle
  --domain refund|inventory  Synthetic action domain (default: refund)
  --json                   Print the run report as JSON
  -h, --help               Show this help

Flow:
  decide -> constitutional-agent-testbench evaluate
  on pass -> consequence-rail demo refund
  on dispute -> mandatebound simulate --scenario operator
  on dispute --prove rail -> rail bundle verify + mandatebound review

First-time setup:
  npm run bootstrap

Requires Node.js 22.12+ and Python 3.11+.

Missing child tools fail closed with a bootstrap hint. Each run is written to
.out/runs/<run-id>. The .out/latest.json pointer identifies the most recent
complete bundle.

Environment:
  AAS_CHILD_TIMEOUT_MS  Child process timeout in milliseconds (default: 30000)
  AAS_GUI_PORT          Loopback port for the local GUI (default: 8787)
  AAS_PYTHON            Interpreter for the decide stage (default: first Python 3.11+ found)

Exit codes:
  0  completed run (including fail-closed policy denial)
  1  stage or environment error
  2  usage error
`;
}

function printHelp(stream = process.stdout) {
  stream.write(helpText());
}

function missingChildTool(label) {
  return new Error(`Missing ${label}. Run: npm run bootstrap`);
}

/** @returns {ChildResult} */
export function runCapture(command, args, opts = {}) {
  const { timeout = resolveChildTimeoutMs(), ...rest } = opts;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: CHILD_JSON_LIMIT,
    ...rest,
    timeout,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/** Keep the trailing `limit` characters after stripping ANSI/control chars. */
export function clipChildStderr(stderr, limit = STDERR_LIMIT) {
  if (typeof stderr !== "string" || stderr.length === 0) return "";
  const cleaned = stderr
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const trimmed = cleaned.trim();
  if (!trimmed) return "";
  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit);
}

function attachChildDiagnostics(error, { stage, code, stderr }) {
  error.stage = stage;
  error.code = code;
  error.stderr = clipChildStderr(stderr);
  return error;
}

function childProcessError(label, result) {
  const timedOut = result.error?.code === "ETIMEDOUT";
  const spawn = Boolean(result.error);
  const code = timedOut
    ? DIAGNOSTIC.CHILD_TIMEOUT
    : spawn
      ? DIAGNOSTIC.CHILD_SPAWN
      : DIAGNOSTIC.CHILD_EXIT;
  const base = timedOut
    ? `${label} child process timed out`
    : spawn
      ? `${label} child process error (${result.error.code ?? "spawn-error"})`
      : `${label} child process exited with status ${result.status}`;
  const detail = clipChildStderr(result.stderr, 200).replace(/\s+/g, " ");
  const error = new Error(detail ? `${base}: ${detail}` : base);
  return attachChildDiagnostics(error, { stage: label, code, stderr: result.stderr });
}

function failedStderr(result) {
  const stderr = clipChildStderr(result?.stderr);
  return stderr ? { stderr } : {};
}

function stageErrorFields(error) {
  const stderr = clipChildStderr(error.stderr);
  return {
    reason: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

/**
 * Parse the last complete JSON value from mixed child stdout.
 *
 * @param {string} text
 * @param {string} label Stage name used in error messages.
 * @param {number} [limit]
 * @returns {unknown}
 */
export function parseJsonOutput(text, label, limit = CHILD_JSON_LIMIT) {
  if (typeof text !== "string") {
    throw new Error(`${label} produced empty output.`);
  }
  if (text.length > limit) {
    throw new Error(`${label} JSON output exceeds ${limit} characters.`);
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`${label} produced empty output.`);
  }
  let parseError;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    parseError = error;
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let end = lines.length; end > 0; end -= 1) {
    if (!/[}\]]$/.test(lines[end - 1].trim())) continue;
    for (let start = 0; start < end; start += 1) {
      if (!/^[\[{]/.test(lines[start].trim())) continue;
      try {
        return JSON.parse(lines.slice(start, end).join("\n"));
      } catch {
        // Keep looking for the last complete JSON range.
      }
    }
  }
  throw new Error(`${label} did not return JSON: ${parseError.message}`);
}

function booleanField(payload, field, label) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || typeof payload[field] !== "boolean") {
    throw new Error(`${label} did not return a boolean ${field} field`);
  }
  return payload[field];
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function optionalField(payload, field, allowed, label) {
  if (payload[field] === undefined) return;
  if (!allowed.includes(jsonType(payload[field]))) {
    throw new Error(`${label} did not return a valid ${field} field`);
  }
}

function parseStageJson(label, result) {
  try {
    return parseJsonOutput(result.stdout, label);
  } catch (error) {
    if (result.status !== 0) throw childProcessError(label, result);
    throw attachChildDiagnostics(error, {
      stage: label,
      code: DIAGNOSTIC.CHILD_JSON,
      stderr: result.stderr,
    });
  }
}

/**
 * Interpreters to try for the decide stage, most specific first.
 * `AAS_PYTHON` overrides selection with an explicit interpreter.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Array<[string, string[]]>}
 */
export function pythonCandidates(env = process.env) {
  const override = typeof env.AAS_PYTHON === "string" ? env.AAS_PYTHON.trim() : "";
  const overrideEntry = override === "" ? [] : [[override, []]];
  if (process.platform === "win32") {
    return [
      ...overrideEntry,
      ["py", ["-3"]],
      ["py", ["-3.14"]],
      ["py", ["-3.13"]],
      ["py", ["-3.12"]],
      ["py", ["-3.11"]],
      ["python", []],
      ["python3", []],
    ];
  }
  return [
    ...overrideEntry,
    ["python3", []],
    ["python3.14", []],
    ["python3.13", []],
    ["python3.12", []],
    ["python3.11", []],
    ["python", []],
  ];
}

/**
 * @param {string} stdout
 * @returns {[number, number]|null}
 */
export function parsePythonVersion(stdout) {
  if (typeof stdout !== "string") return null;
  const match = /^(\d{1,3})\.(\d{1,3})$/u.exec(stdout.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

/**
 * Pick an interpreter that satisfies the locked testbench's `requires-python`.
 *
 * Returns null when no interpreter could be read, so the existing decide
 * error path still reports a missing Python. Throws an actionable error when
 * interpreters exist but every one is too old.
 *
 * @returns {{bin: string, prefix: string[], version: [number, number]}|null}
 */
export function selectPython({ runner = runCapture, env = process.env, candidates = pythonCandidates(env) } = {}) {
  const minimum = MIN_PYTHON.join(".");
  const override = typeof env.AAS_PYTHON === "string" ? env.AAS_PYTHON.trim() : "";
  if (override !== "") {
    const probe = runner(override, ["-c", PYTHON_VERSION_PROBE], { env: { ...env, PYTHONUTF8: "1" } });
    const version = probe.error || probe.status !== 0 ? null : parsePythonVersion(probe.stdout);
    if (version === null) {
      throw new Error(
        `AAS_PYTHON (${override}) did not report a usable Python version. Set AAS_PYTHON to a working Python ${minimum}+ interpreter.`,
      );
    }
    if (version[0] < MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] < MIN_PYTHON[1])) {
      throw new Error(
        `AAS_PYTHON (${override}) is Python ${version[0]}.${version[1]} but the decide stage requires Python ${minimum}+.`,
      );
    }
    return { bin: override, prefix: [], version };
  }
  const tooOld = [];
  let readable = false;
  for (const [bin, prefix] of candidates) {
    const probe = runner(bin, [...prefix, "-c", PYTHON_VERSION_PROBE], {
      env: { ...env, PYTHONUTF8: "1" },
    });
    if (probe.error || probe.status !== 0) continue;
    const version = parsePythonVersion(probe.stdout);
    if (version === null) continue;
    readable = true;
    if (version[0] > MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1])) {
      return { bin, prefix, version };
    }
    tooOld.push(`${bin} is Python ${version[0]}.${version[1]}`);
  }
  if (!readable) return null;
  throw new Error(
    `decide stage requires Python ${minimum}+ (constitutional-agent-testbench declares requires-python >= ${minimum}); found ${tooOld.join(", ")}. Install Python ${minimum}+ or set AAS_PYTHON to its interpreter.`,
  );
}

/** @returns {ComponentProvenance[]} */
export function resolveComponentProvenance(
  depsDir = DEFAULT_PATHS.deps,
  lockPath = DEFAULT_PATHS.lock,
) {
  const components = loadComponentLock(lockPath);
  return components.map((component) => {
    const target = join(depsDir, component.name);
    const state = inspectDependencyDirectory(target, {
      ...component,
      expected_entrypoints: [
        ...component.expected_entrypoints,
        ...(component.post_build_entrypoints ?? []),
      ],
    });
    if (!state.exists) {
      throw new Error(`Missing deps/${component.name}. Run: npm run bootstrap`);
    }
    return {
      name: component.name,
      repository: component.repository,
      commit: state.commit,
      origin: state.origin,
      detached: state.detached,
      clean: state.clean,
      entrypoints: state.entrypoints,
    };
  });
}

/**
 * Evaluate a response fixture against the locked testbench policy.
 *
 * @returns {{ok: boolean, raw: object, status: number}}
 */
export function runDecide(
  responsePath,
  {
    depsDir = DEFAULT_PATHS.deps,
    fixturesDir = DEFAULT_PATHS.fixtures,
    runner = runCapture,
    python = null,
    domain = "refund",
  } = {},
) {
  const policyPath = join(
    fixturesDir,
    domain === "inventory" ? "inventory.policy.json" : "policy.json",
  );
  const pythonPath = join(depsDir, "constitutional-agent-testbench", "src");
  const decideCli = join(pythonPath, "constitutional_agent_testbench", "cli.py");
  if (runner === runCapture && !existsSync(decideCli)) {
    throw missingChildTool("decide CLI (deps/constitutional-agent-testbench/src/constitutional_agent_testbench/cli.py)");
  }
  const env = { ...process.env, PYTHONPATH: pythonPath, PYTHONUTF8: "1" };
  let lastError = null;
  const candidates = python === null ? pythonCandidates() : [[python.bin, python.prefix]];
  for (const [bin, prefix] of candidates) {
    const result = runner(
      bin,
      [...prefix, "-m", "constitutional_agent_testbench.cli", "evaluate", policyPath, responsePath],
      { env },
    );
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") throw childProcessError("decide", result);
      lastError = result.error;
      continue;
    }
    const evaluation = parseStageJson("decide", result);
    if (result.status !== 0) {
      return { ok: false, raw: evaluation, status: result.status, ...failedStderr(result) };
    }
    try {
      const ok = booleanField(evaluation, "passed", "decide");
      optionalField(evaluation, "policy_id", ["string"], "decide");
      optionalField(evaluation, "rule_results", ["array"], "decide");
      return { ok, raw: evaluation, status: 0, ...(ok ? {} : failedStderr(result)) };
    } catch (error) {
      throw attachChildDiagnostics(error, {
        stage: "decide",
        code: DIAGNOSTIC.CHILD_JSON,
        stderr: result.stderr,
      });
    }
  }
  const missing = new Error(`Python not found for decide stage${lastError ? ` (${lastError.code ?? "spawn-error"})` : ""}`);
  throw attachChildDiagnostics(missing, {
    stage: "decide",
    code: DIAGNOSTIC.CHILD_SPAWN,
    stderr: lastError?.message,
  });
}

/**
 * Execute the locked Consequence Rail refund demo.
 *
 * @param {string} fault Demo fault name, or "none".
 * @returns {{ok: true, raw: object, status: number}}
 */
export function runAct(
  fault,
  {
    depsDir = DEFAULT_PATHS.deps,
    runner = runCapture,
    persistRailBundle = false,
    domain = "refund",
  } = {},
) {
  const crctl = join(depsDir, "consequence-rail", "cmd", "crctl.js");
  if (runner === runCapture && !existsSync(crctl)) {
    throw missingChildTool("act CLI (deps/consequence-rail/cmd/crctl.js)");
  }
  const args = ["demo", domain, "--json"];
  if (fault && fault !== "none") args.push("--fault", fault);
  const railDir = join(depsDir, "consequence-rail");
  let scratch = null;
  let bundlePath = null;
  if (persistRailBundle) {
    scratch = mkdtempSync(join(tmpdir(), "aas-act-"));
    bundlePath = join(scratch, "rail-bundle.json");
    args.push("--out", bundlePath);
  }
  const result = runner(process.execPath, [crctl, ...args], {
    cwd: railDir,
  });
  try {
    if (result.error) throw childProcessError("act", result);
    const payload = parseStageJson("act", result);
    if (result.status !== 0) {
      // A nonzero exit with parseable JSON is an unsuccessful act (the CLI
      // surfaces structured errors as JSON on stdout), not a child-process
      // error. Mirror runProve so persistRunBundle and printHuman see the
      // structured failure and the GUI can render the stage artifact.
      return { ok: false, raw: payload, status: result.status, ...failedStderr(result) };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || ![null, "settled", "compensated", "disputed"].includes(payload.outcome)) {
      throw attachChildDiagnostics(new Error("act did not return a valid outcome"), {
        stage: "act",
        code: DIAGNOSTIC.CHILD_JSON,
        stderr: result.stderr,
      });
    }
    try {
      optionalField(payload, "state", ["string", "null"], "act");
      optionalField(payload, "fault", ["string", "null"], "act");
      optionalField(payload, "action_id", ["string", "null"], "act");
      optionalField(payload, "assurance_mode", ["string", "null"], "act");
      optionalField(payload, "bundle_verification", ["string", "null"], "act");
    } catch (error) {
      throw attachChildDiagnostics(error, {
        stage: "act",
        code: DIAGNOSTIC.CHILD_JSON,
        stderr: result.stderr,
      });
    }
    if (scratch !== null) {
      try {
        payload.rail_bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
      } catch (error) {
        throw attachChildDiagnostics(
          new Error(`act did not persist a readable rail bundle: ${error.message}`),
          { stage: "act", code: DIAGNOSTIC.CHILD_JSON, stderr: result.stderr },
        );
      }
    }
    return { ok: true, raw: payload, status: 0 };
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Run MandateBound's operator simulation as the prove stage.
 *
 * @param {string} scenario MandateBound simulate scenario id.
 * @returns {{ok: boolean, raw: object, status: number}}
 */
export function runProve(
  scenario,
  { depsDir = DEFAULT_PATHS.deps, runner = runCapture } = {},
) {
  if (typeof scenario !== "string" || scenario.trim() === "") {
    throw new Error("prove requires a non-empty scenario");
  }
  if (!PROVE_SCENARIOS.has(scenario)) {
    throw new Error(`prove scenario is not supported: ${scenario}`);
  }
  const cli = join(depsDir, "mandatebound", "dist", "cli.js");
  if (runner === runCapture && !existsSync(cli)) {
    throw missingChildTool("prove CLI (deps/mandatebound/dist/cli.js)");
  }
  const result = runner(
    process.execPath,
    [cli, "simulate", "--scenario", scenario],
    { cwd: join(depsDir, "mandatebound") },
  );
  if (result.error) throw childProcessError("prove", result);
  const payload = parseStageJson("prove", result);
  if (result.status !== 0) {
    return { ok: false, raw: payload, status: result.status, ...failedStderr(result) };
  }
  try {
    const ok = booleanField(payload, "ok", "prove");
    optionalField(payload, "result", ["object"], "prove");
    return { ok, raw: payload, status: 0, ...(ok ? {} : failedStderr(result)) };
  } catch (error) {
    throw attachChildDiagnostics(error, {
      stage: "prove",
      code: DIAGNOSTIC.CHILD_JSON,
      stderr: result.stderr,
    });
  }
}

/**
 * Build a MandateBound review request binding same-case rail evidence.
 *
 * Pure: no child processes or filesystem access, safe to unit-test. The
 * caller supplies the rail bundle bytes (as first persisted by the act
 * stage) and the rail verifier's own verdict over those exact bytes.
 * Upstream validity stays a caller assertion; MandateBound binds it without
 * re-verifying rail signatures.
 *
 * @returns {{request: object, digest: string, bundleBytes: Buffer}}
 */
export function buildRailReviewRequest({ bundle, verification }) {
  const actionId = bundle?.action?.action_id;
  const receipt = bundle?.settlement_receipt;
  if (typeof actionId !== "string" || actionId === "" || !receipt || typeof receipt !== "object") {
    throw new Error("prove rail-review requires an act rail bundle with action and settlement_receipt");
  }
  if (!verification || typeof verification !== "object" || verification.valid !== true) {
    throw new Error("prove rail-review requires a passing rail bundle verification for the handed-off bytes");
  }
  for (const [label, value] of [["action_id", verification.action_id], ["outcome", verification.outcome]]) {
    if (typeof value !== "string" || value === "") {
      throw new Error(`prove rail-review verification is missing ${label}`);
    }
  }
  if (verification.action_id !== actionId || verification.outcome !== receipt.outcome) {
    throw new Error("prove rail-review verification does not match the handed-off rail bundle");
  }
  const keyIds = [verification.trusted_key_id, verification.trusted_connector_key_id]
    .filter((key) => typeof key === "string" && key !== "");
  if (keyIds.length === 0) {
    throw new Error("prove rail-review verification names no trusted keys");
  }
  const bundleBytes = Buffer.from(JSON.stringify(bundle), "utf8");
  const digest = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;
  return {
    request: {
      source: { sourceId: "consequence-rail", eventClass: "settlement" },
      evidence: {
        mediaType: "application/json",
        bytesBase64: bundleBytes.toString("base64"),
        digest,
        byteLength: bundleBytes.length,
      },
      anchors: { expectedDigest: digest },
      upstream: {
        verifier: "consequence-rail:bundle-verify",
        valid: true,
        actionId,
        outcome: receipt.outcome,
        trustedKeyIds: keyIds,
      },
    },
    digest,
    bundleBytes,
  };
}

/**
 * Confirm a MandateBound review record is bound to the handed-off case.
 * Throws instead of recording a mismatched review.
 */
export function validateRailReview({ review, digest, bundle }) {
  const actionId = bundle?.action?.action_id;
  if (!review || typeof review !== "object" || review.verdict !== "recorded") {
    throw new Error("prove rail-review did not record the handed-off evidence");
  }
  if (review.actionId !== actionId || review.evidenceDigest !== digest) {
    throw new Error("prove rail-review record is not bound to the handed-off rail bundle");
  }
  if (review.legalEffect !== "not-determined") {
    throw new Error("prove rail-review record claims a legal effect");
  }
}

/**
 * Prove by reviewing the same-case rail bundle: verify it with the rail's
 * own verifier, then bind it into a MandateBound review record. Fails
 * closed on any verification, digest, identity, or verdict mismatch.
 *
 * @returns {{ok: boolean, raw: object, status: number}}
 */
export function runProveRail(bundle, { depsDir = DEFAULT_PATHS.deps, runner = runCapture } = {}) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("prove rail-review requires the act stage rail bundle; the act stage did not persist one");
  }
  const railDir = join(depsDir, "consequence-rail");
  const mbDir = join(depsDir, "mandatebound");
  const crctl = join(railDir, "cmd", "crctl.js");
  const cli = join(mbDir, "dist", "cli.js");
  if (runner === runCapture) {
    if (!existsSync(crctl)) throw missingChildTool("prove CLI (deps/consequence-rail/cmd/crctl.js)");
    if (!existsSync(cli)) throw missingChildTool("prove CLI (deps/mandatebound/dist/cli.js)");
  }
  const scratch = mkdtempSync(join(tmpdir(), "aas-prove-"));
  try {
    const bundlePath = join(scratch, "rail-bundle.json");
    const requestPath = join(scratch, "review-request.json");
    writeFileSync(bundlePath, JSON.stringify(bundle));
    const verifyResult = runner(process.execPath, [crctl, "bundle", "verify", bundlePath, "--json"], {
      cwd: railDir,
    });
    if (verifyResult.error) throw childProcessError("prove", verifyResult);
    const verification = parseStageJson("prove", verifyResult);
    if (verifyResult.status !== 0) {
      return { ok: false, raw: verification, status: verifyResult.status, ...failedStderr(verifyResult) };
    }
    const stored = readFileSync(bundlePath);
    let request;
    let digest;
    try {
      ({ request, digest } = buildRailReviewRequest({
        bundle: JSON.parse(stored.toString("utf8")),
        verification,
      }));
    } catch (error) {
      throw attachChildDiagnostics(error, {
        stage: "prove",
        code: DIAGNOSTIC.CHILD_JSON,
        stderr: verifyResult.stderr,
      });
    }
    writeFileSync(requestPath, JSON.stringify(request));
    const reviewResult = runner(process.execPath, [cli, "review", "--input", requestPath], {
      cwd: mbDir,
    });
    if (reviewResult.error) throw childProcessError("prove", reviewResult);
    const payload = parseStageJson("prove", reviewResult);
    if (reviewResult.status !== 0) {
      return { ok: false, raw: payload, status: reviewResult.status, ...failedStderr(reviewResult) };
    }
    try {
      const ok = booleanField(payload, "ok", "prove");
      optionalField(payload, "result", ["object"], "prove");
      validateRailReview({ review: payload.result, digest, bundle });
      return { ok, raw: payload, status: 0, ...(ok ? {} : failedStderr(reviewResult)) };
    } catch (error) {
      throw attachChildDiagnostics(error, {
        stage: "prove",
        code: DIAGNOSTIC.CHILD_JSON,
        stderr: reviewResult.stderr,
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Reproduce the supported verification/review process for one exported run
 * bundle without rerunning the action. Every check is explicit: digest
 * recomputation, the rail's own bundle verification over the exported
 * bytes, and a deterministic re-execution of the MandateBound review whose
 * digest must equal the recorded one. Trust basis: the rail's synthetic
 * demo keys via its own verifier; nothing embedded in the bundle is
 * trusted for its own integrity, and caller-owned digests come from the
 * recorded review, never from untrusted annotations.
 *
 * @returns {{ok: boolean, runId: string|null, checks: Array<{name: string, passed: boolean, detail: string}>}}
 */
export function replayBundle(bundleDoc, { depsDir = DEFAULT_PATHS.deps, runner = runCapture } = {}) {
  const checks = [];
  const record = (name, passed, detail) => {
    checks.push({ name, passed, detail });
    return passed;
  };
  const fail = (reason) => ({ ok: false, runId: null, checks, reason });
  if (!bundleDoc || typeof bundleDoc !== "object" || Array.isArray(bundleDoc)) {
    return fail("bundle document is not an object");
  }
  const runId = bundleDoc.report?.run_id ?? null;
  const stages = bundleDoc.stages && typeof bundleDoc.stages === "object" ? bundleDoc.stages : null;
  const railBundle = stages?.act && typeof stages.act === "object" ? stages.act.rail_bundle ?? null : null;
  const review = stages?.prove && typeof stages.prove === "object" && stages.prove.result && typeof stages.prove.result === "object"
    ? stages.prove.result
    : null;
  if (!stages || railBundle === null || typeof railBundle !== "object" || Array.isArray(railBundle)) {
    record("evidence-available", false, "no same-case rail bundle in this run");
    return { ok: false, runId, checks, reason: "unavailable: this run persisted no rail bundle (simulate mode or skipped act)" };
  }
  if (review === null || review.verdict !== "recorded") {
    record("evidence-available", false, "no recorded same-case review in this run");
    return { ok: false, runId, checks, reason: "unavailable: this run recorded no review verdict" };
  }
  record("evidence-available", true, "rail bundle and recorded review present");
  const actionId = stages.act.action_id ?? null;
  const bundleBytes = Buffer.from(JSON.stringify(railBundle), "utf8");
  const digest = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;
  if (!record("identity-binding", review.actionId === actionId && actionId !== null,
    review.actionId === actionId && actionId !== null
      ? `review bound to ${actionId}`
      : "review action id does not match the act action id")) {
    return { ok: false, runId, checks, reason: "conflicting: review is not bound to this run's action" };
  }
  if (!record("digest-binding", review.evidenceDigest === digest,
    review.evidenceDigest === digest ? `evidence digest ${digest}` : "recomputed digest does not match the review")) {
    return { ok: false, runId, checks, reason: "conflicting: exported bytes do not match the recorded digest" };
  }
  const railDir = join(depsDir, "consequence-rail");
  const mbDir = join(depsDir, "mandatebound");
  const crctl = join(railDir, "cmd", "crctl.js");
  const cli = join(mbDir, "dist", "cli.js");
  if (runner === runCapture) {
    if (!existsSync(crctl)) throw missingChildTool("replay CLI (deps/consequence-rail/cmd/crctl.js)");
    if (!existsSync(cli)) throw missingChildTool("replay CLI (deps/mandatebound/dist/cli.js)");
  }
  const scratch = mkdtempSync(join(tmpdir(), "aas-replay-"));
  try {
    const bundlePath = join(scratch, "rail-bundle.json");
    const requestPath = join(scratch, "review-request.json");
    writeFileSync(bundlePath, bundleBytes);
    const verifyResult = runner(process.execPath, [crctl, "bundle", "verify", bundlePath, "--json"], {
      cwd: railDir,
    });
    if (verifyResult.error) throw childProcessError("replay", verifyResult);
    const verification = parseStageJson("replay", verifyResult);
    const verified = verifyResult.status === 0 && verification && verification.valid === true
      && verification.action_id === actionId && verification.outcome === review.upstream?.outcome;
    if (!record("rail-verification", verified, verified
      ? `rail verifier accepts ${actionId} with outcome ${verification.outcome}`
      : "rail verifier rejected the exported bytes")) {
      return { ok: false, runId, checks, reason: "unsupported: rail verification failed for the exported bytes" };
    }
    let request;
    try {
      ({ request } = buildRailReviewRequest({ bundle: JSON.parse(bundleBytes.toString("utf8")), verification }));
    } catch (error) {
      record("review-request", false, `cannot rebuild the review request: ${error.message}`);
      return { ok: false, runId, checks, reason: "unsupported: review request cannot be rebuilt" };
    }
    record("review-request", true, "review request rebuilt from exported bytes");
    writeFileSync(requestPath, JSON.stringify(request));
    const reviewResult = runner(process.execPath, [cli, "review", "--input", requestPath], {
      cwd: mbDir,
    });
    if (reviewResult.error) throw childProcessError("replay", reviewResult);
    const replayed = parseStageJson("replay", reviewResult);
    const reproduced = reviewResult.status === 0 && replayed && replayed.ok === true
      && replayed.result && replayed.result.verdict === "recorded"
      && replayed.result.reviewDigest === review.reviewDigest;
    if (!record("review-replay", reproduced,
      reproduced ? `re-executed review digest ${replayed.result.reviewDigest}` : "re-executed review does not match the record")) {
      return { ok: false, runId, checks, reason: "conflicting: replayed review differs from the record" };
    }
    return { ok: true, runId, checks };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function createRunId(now = new Date(), nonce = randomUUID()) {
  return `${now.toISOString().replace(/[:.]/g, "")}-${nonce.slice(0, 12)}`;
}

function safeBundleFile(bundleDir, value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    throw new Error(`Invalid ${label}.`);
  }
  if (isAbsolute(value) || !/^(?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return join(bundleDir, value);
}

/**
 * Read one persisted run bundle: manifest, report, and every stage artifact
 * the manifest references. Shared by the GUI download and `aas export`, so
 * both produce the identical portable document.
 */
export function readRunBundle(outputRoot, runId) {
  if (!isValidRunId(runId)) throw new Error("Invalid run id.");
  const bundleDir = join(outputRoot, "runs", runId);
  const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
  const report = JSON.parse(readFileSync(safeBundleFile(bundleDir, manifest.report, "report path"), "utf8"));
  const stages = {};
  for (const [name, stage] of Object.entries(manifest.stages ?? {})) {
    if (stage.artifact) {
      stages[name] = JSON.parse(readFileSync(safeBundleFile(bundleDir, stage.artifact, "stage artifact path"), "utf8"));
    }
  }
  return { manifest, report, stages };
}

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * A run id must look like a real run id: the pattern alone also matches "."
 * and "..", which would resolve outside the runs directory.
 */
export function isValidRunId(runId) {
  return typeof runId === "string" && RUN_ID_PATTERN.test(runId) && /^[A-Za-z0-9]/.test(runId);
}

function runsDirectory(outputRoot) {
  return join(outputRoot, "runs");
}

/**
 * List persisted runs newest-first. Entries without a readable manifest
 * (interrupted writes, stray files) are omitted; export and replay still
 * fail closed on them when addressed directly.
 */
export function listRuns({ outputRoot = DEFAULT_PATHS.outputRoot, limit = Number.MAX_SAFE_INTEGER } = {}) {
  const dir = runsDirectory(outputRoot);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  // Names sort newest-first, so order the candidates before reading any
  // manifest: that keeps the result correct and the scan bounded.
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && isValidRunId(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, limit);
  const runs = [];
  for (const name of candidates) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, name, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== "object") continue;
    const stages = {};
    for (const name2 of STAGE_NAMES) stages[name2] = manifest.stages?.[name2]?.status ?? "unknown";
    runs.push({
      run_id: name,
      created_at: typeof manifest.created_at === "string" ? manifest.created_at : null,
      exit_code: manifest.exit_code ?? null,
      stages,
    });
  }
  return runs;
}

function readLatestRunId(outputRoot) {
  try {
    const pointer = JSON.parse(readFileSync(join(outputRoot, "latest.json"), "utf8"));
    const runId = pointer?.run_id;
    return typeof runId === "string" && RUN_ID_PATTERN.test(runId) ? runId : null;
  } catch {
    return null;
  }
}

/**
 * Remove oldest runs beyond `keep`, newest-first retention. The run the
 * latest pointer identifies is always kept so exports and downloads never
 * dangle; dry runs report without deleting. Returns kept/removed run ids.
 */
export function pruneRuns({ outputRoot = DEFAULT_PATHS.outputRoot, keep, dryRun = false } = {}) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new UsageError("prune requires --keep <positive integer>");
  }
  const runs = [...listRuns({ outputRoot })].reverse();
  const latest = readLatestRunId(outputRoot);
  const keepSet = new Set(runs.slice(-keep).map((run) => run.run_id));
  if (latest !== null && runs.some((run) => run.run_id === latest)) keepSet.add(latest);
  const removed = [];
  for (const run of runs) {
    if (keepSet.has(run.run_id)) continue;
    removed.push(run.run_id);
    if (!dryRun) rmSync(join(runsDirectory(outputRoot), run.run_id), { recursive: true, force: true });
  }
  return { kept: [...keepSet], removed, latest, dryRun };
}

const HISTORY_LIMIT = 50;
const COMPARABLE_SCHEMA = "agent-action-stack.run/v1";

function readJsonFile(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Cannot read ${label}.`);
  }
  return JSON.parse(text);
}

function readRunManifest(dir, runId) {
  if (!isValidRunId(runId)) throw new Error("Invalid run id.");
  const bundleDir = join(dir, runId);
  return { bundleDir, manifest: readJsonFile(join(bundleDir, "manifest.json"), `run ${runId} manifest`) };
}

function readRunReport(bundleDir, manifest) {
  return readJsonFile(safeBundleFile(bundleDir, manifest.report, "report path"), "the run report");
}

/**
 * Read a stage artifact. Missing artifacts are normal (a skipped stage has
 * none); an artifact the manifest names but cannot be parsed is reported so
 * callers fail closed instead of treating the field as absent.
 */
function readStageArtifact(bundleDir, manifest, name) {
  const entry = manifest.stages?.[name];
  if (!entry?.artifact) return { value: null, unreadable: false };
  try {
    return { value: readJsonFile(safeBundleFile(bundleDir, entry.artifact, `${name} artifact path`), `the ${name} artifact`), unreadable: false };
  } catch {
    return { value: null, unreadable: true };
  }
}

/**
 * Bounded, summary-only view of one persisted run. Raw evidence is never
 * included: callers get identities, statuses, outcomes, digests, and
 * component revisions only.
 */
export function summarizeRun(runId, { outputRoot = DEFAULT_PATHS.outputRoot } = {}) {
  const { bundleDir, manifest } = readRunManifest(runsDirectory(outputRoot), runId);
  if (manifest.schema_version !== COMPARABLE_SCHEMA) {
    throw new Error(`Run ${runId} uses unsupported manifest schema ${String(manifest.schema_version)}.`);
  }
  const report = readRunReport(bundleDir, manifest);
  const prove = readStageArtifact(bundleDir, manifest, "prove");
  const artifacts_unreadable = prove.unreadable ? ["prove"] : [];
  const stages = {};
  for (const name of STAGE_NAMES) stages[name] = manifest.stages?.[name]?.status ?? "unknown";
  return {
    run_id: runId,
    created_at: typeof manifest.created_at === "string" ? manifest.created_at : null,
    schema_version: manifest.schema_version,
    domain: typeof report.domain === "string" ? report.domain : null,
    exit_code: manifest.exit_code ?? null,
    flow: typeof report.flow === "string" ? report.flow : null,
    stages,
    policy_id: report.stages?.decide?.policy_id ?? null,
    action_id: report.stages?.act?.action_id ?? null,
    outcome: report.stages?.act?.outcome ?? null,
    state: report.stages?.act?.state ?? null,
    fault: report.stages?.act?.fault ?? null,
    prove_mode: report.stages?.prove?.mode ?? null,
    review_verdict: prove.value?.result?.verdict ?? null,
    review_id: prove.value?.result?.reviewId ?? null,
    evidence_digest: prove.value?.result?.evidenceDigest ?? null,
    artifacts_unreadable,
    components: (Array.isArray(report.component_provenance) ? report.component_provenance : [])
      .map((entry) => ({ name: entry?.name ?? "unknown", commit: entry?.commit ?? null }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  };
}

/** Newest-first bounded history of run summaries. */
export function listRunSummaries({ outputRoot = DEFAULT_PATHS.outputRoot, limit = HISTORY_LIMIT } = {}) {
  // Bound the scan itself: names sort newest-first, so only the newest
  // `limit` entries are opened at all.
  const ids = listRuns({ outputRoot, limit }).map((run) => run.run_id);
  const summaries = [];
  for (const runId of ids.slice(0, limit)) {
    try {
      summaries.push(summarizeRun(runId, { outputRoot }));
    } catch {
      // A run whose artifacts are missing or unsupported is skipped from the
      // history rather than failing the whole list; direct selection still
      // reports the problem explicitly.
    }
  }
  return summaries;
}

const COMPARISON_NOTES = [
  "differences do not establish causation",
  "matching metadata does not prove matching evidence",
  "only the listed compared fields are checked; raw evidence is never loaded into this view",
];

const COMPARED_FIELDS = [
  "domain",
  "flow",
  "stages",
  "policy_id",
  "action_id",
  "outcome",
  "state",
  "fault",
  "prove_mode",
  "review_verdict",
  "review_id",
  "evidence_digest",
  "exit_code",
];

/**
 * Compare two persisted runs. Reports which supported fields differ and
 * classifies the pair as identical, different, or not comparable. It never
 * infers causation, and identical metadata is not presented as proof of
 * identical evidence.
 */
export function compareRuns(leftId, rightId, { outputRoot = DEFAULT_PATHS.outputRoot } = {}) {
  let left = null;
  let right = null;
  const errors = [];
  for (const [label, runId] of [["left", leftId], ["right", rightId]]) {
    try {
      const summary = summarizeRun(runId, { outputRoot });
      if (label === "left") left = summary;
      else right = summary;
    } catch (error) {
      errors.push(`${label} (${runId}): ${error.message}`);
    }
  }
  if (left === null || right === null) {
    return { classification: "not-comparable", differences: [], errors, notes: COMPARISON_NOTES, left, right };
  }
  for (const [label, summary] of [["left", left], ["right", right]]) {
    for (const artifact of summary.artifacts_unreadable) {
      errors.push(`${label} (${summary.run_id}): the ${artifact} artifact is unreadable`);
    }
  }
  if (errors.length > 0) {
    return { classification: "not-comparable", differences: [], errors, notes: COMPARISON_NOTES, left, right };
  }
  const differences = [];
  for (const field of COMPARED_FIELDS) {
    if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) {
      differences.push({ field, left: left[field], right: right[field] });
    }
  }
  const leftComponents = JSON.stringify(left.components);
  const rightComponents = JSON.stringify(right.components);
  if (leftComponents !== rightComponents) {
    differences.push({ field: "components", left: left.components, right: right.components });
  }
  return {
    classification: differences.length === 0 ? "identical" : "different",
    differences,
    errors,
    notes: COMPARISON_NOTES,
    left,
    right,
  };
}

/** Export one run bundle as a single portable JSON document. */


export function exportRunBundle(runId, { outputRoot = DEFAULT_PATHS.outputRoot } = {}) {
  return readRunBundle(outputRoot, runId);
}

export function writeAtomicFile(
  target,
  data,
  {
    writeFile = writeFileSync,
    rename = renameSync,
    unlink = unlinkSync,
    mkdir = mkdirSync,
  } = {},
) {
  mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let written = false;
  try {
    writeFile(temporary, data, { encoding: "utf8", flag: "wx" });
    written = true;
    rename(temporary, target);
  } catch (error) {
    throw error;
  } finally {
    if (written) {
      // Best-effort cleanup. Only attempt unlink when we know the
      // temporary was created; if the write itself failed, the file
      // does not exist and unlink would just throw ENOENT we have to
      // swallow. Rethrow the original error above either way.
      try {
        unlink(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          // A non-ENOENT unlink failure is a real problem: the
          // temporary is still on disk and will not be retried. Surface
          // it for the operator but do not mask the original error.
          process.emitWarning(
            `writeAtomicFile: failed to unlink ${temporary}: ${cleanupError.message}`,
            "WriteAtomicFileCleanup",
          );
        }
      }
    }
  }
}

function stageArtifact(stage, raw) {
  return raw === undefined ? null : { name: stage, path: `stages/${stage}.json` };
}

export function persistRunBundle({
  outputRoot = DEFAULT_PATHS.outputRoot,
  runId,
  report,
  stages,
  componentProvenance,
  exitCode,
  now = new Date().toISOString(),
}) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("Invalid run id.");
  const runsDir = join(outputRoot, "runs");
  const finalDir = join(runsDir, runId);
  const temporaryDir = join(runsDir, `.${runId}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(temporaryDir, { recursive: true });
  try {
    const stageManifest = {};
    for (const stage of STAGE_NAMES) {
      const current = stages[stage] ?? { status: "skipped", reason: "not_reached" };
      const artifact = stageArtifact(stage, current.raw);
      stageManifest[stage] = {
        status: current.status,
        reason: current.reason ?? null,
        code: current.code ?? null,
        stderr: current.stderr ? clipChildStderr(current.stderr) : null,
        artifact: artifact?.path ?? null,
      };
      if (artifact) {
        writeAtomicFile(
          join(temporaryDir, artifact.path),
          `${JSON.stringify(current.raw, null, 2)}\n`,
        );
      }
    }
    const manifest = {
      schema_version: "agent-action-stack.run/v1",
      run_id: runId,
      created_at: now,
      exit_code: exitCode,
      component_provenance: componentProvenance,
      stages: stageManifest,
      report: "report.json",
    };
    writeAtomicFile(join(temporaryDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeAtomicFile(join(temporaryDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (existsSync(finalDir)) throw new Error(`Run bundle already exists: ${runId}`);
    renameSync(temporaryDir, finalDir);
    const pointer = {
      schema_version: "agent-action-stack.latest/v1",
      run_id: runId,
      manifest: `runs/${runId}/manifest.json`,
      updated_at: now,
    };
    writeAtomicFile(join(outputRoot, "latest.json"), `${JSON.stringify(pointer, null, 2)}\n`);
    return { manifest, bundleDir: finalDir, pointer };
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

function stageRecord(status, fields = {}) {
  return { status, ...fields };
}

/**
 * Print the CLI human report. Field order is part of the public surface and
 * must match the pass-path sample in README.md.
 *
 * @param {RunReport} report
 * @param {string|null} [bundleDir]
 */
export function printHuman(report, bundleDir = null) {
  const lines = [
    "stack: agent-action-stack",
    `response: ${report.response}`,
    `decide: ${report.stages.decide.status}`,
    `decide_passed: ${report.stages.decide.passed ?? false}`,
    `act: ${report.stages.act.status}`,
    `act_outcome: ${report.stages.act.outcome ?? "none"}`,
    `act_state: ${report.stages.act.state ?? "none"}`,
    `act_fault: ${report.stages.act.fault ?? "none"}`,
    `prove: ${report.stages.prove.status}`,
    `prove_scenario: ${report.stages.prove.scenario ?? "none"}`,
    `prove_triggered_by: ${report.stages.prove.triggered_by ?? "none"}`,
    `prove_mode: ${report.stages.prove.mode ?? "none"}`,
    `flow: ${report.flow}`,
  ];
  for (const name of STAGE_NAMES) {
    const stage = report.stages[name];
    if (!stage || (stage.status !== "error" && stage.status !== "failed")) continue;
    if (stage.code) lines.push(`${name}_code: ${stage.code}`);
    if (stage.reason) lines.push(`${name}_reason: ${stage.reason}`);
    if (stage.stderr) lines.push(`${name}_stderr: ${clipChildStderr(stage.stderr).replace(/\s+/g, " ")}`);
  }
  if (bundleDir) lines.push(`bundle: ${bundleDir}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Run decide → act → prove and persist an isolated bundle.
 *
 * @param {string[]} [args] Demo flags: --response, --fault, --dispute, --json.
 * @param {object} [options]
 * @returns {Promise<DemoResult>}
 */
export async function runDemo(args = [], options = {}) {
  validateDemoArgs(args);
  const childTimeoutMs = options.childTimeoutMs ?? resolveChildTimeoutMs();
  const runner = options.runner ?? ((command, args, opts = {}) =>
    runCapture(command, args, { timeout: childTimeoutMs, ...opts }));
  const paths = {
    ...DEFAULT_PATHS,
    ...(options.paths ?? {}),
  };
  const responseName = option(args, "--response", "pass");
  if (responseName !== "pass" && responseName !== "fail") {
    throw new UsageError("--response must be pass or fail");
  }
  const fault = option(args, "--fault", "none");
  if (!DEMO_FAULTS.has(fault)) {
    throw new UsageError("--fault must be none or duplicate");
  }
  const forceDispute = has(args, "--dispute");
  const asJson = has(args, "--json");
  const proveMode = option(args, "--prove", "simulate");
  if (!PROVE_MODES.has(proveMode)) {
    throw new UsageError("--prove must be simulate or rail");
  }
  const domain = option(args, "--domain", "refund");
  if (!DEMO_DOMAINS.has(domain)) {
    throw new UsageError("--domain must be refund or inventory");
  }
  const responseFile =
    domain === "inventory"
      ? `inventory.response.${responseName}.json`
      : `response.${responseName}.json`;
  const responsePath = join(paths.fixtures, responseFile);
  if (!existsSync(responsePath) && !options.runDecideFn) throw new Error(`Missing fixture: ${responsePath}`);
  const runId = options.runId ?? createRunId(options.now ? new Date(options.now) : new Date());
  const componentProvenance = options.componentResolver
    ? await options.componentResolver(paths)
    : resolveComponentProvenance(paths.deps, paths.lock);
  const stages = {
    decide: stageRecord("pending"),
    act: stageRecord("skipped", { reason: "not_reached" }),
    prove: stageRecord("skipped", { reason: "not_reached" }),
  };
  let exitCode = 0;
  const report = {
    stack: "agent-action-stack",
    response: responseName,
    domain,
    flow: "decide",
    run_id: runId,
    component_provenance: componentProvenance,
    stages: {
      decide: stageRecord("pending", { passed: false }),
      act: stageRecord("skipped", { reason: "not_reached" }),
      prove: stageRecord("skipped", { reason: "not_reached" }),
    },
  };
  const finalize = () => {
    report.stages = Object.fromEntries(STAGE_NAMES.map((stage) => {
      const { raw: _raw, ...visible } = report.stages[stage] ?? stages[stage];
      return [stage, { ...visible, status: stages[stage].status }];
    }));
    const persisted = persistRunBundle({
      outputRoot: paths.outputRoot,
      runId,
      report,
      stages,
      componentProvenance,
      exitCode,
    });
    return { report, manifest: persisted.manifest, bundleDir: persisted.bundleDir, exitCode, asJson };
  };
  try {
    const decide = await (options.runDecideFn ?? runDecide)(responsePath, {
      depsDir: paths.deps,
      fixturesDir: paths.fixtures,
      runner,
      domain,
      ...(options.python ? { python: options.python } : {}),
    });
    const decideStderr = clipChildStderr(decide.stderr);
    stages.decide = stageRecord(decide.ok ? "passed" : "failed", {
      raw: decide.raw,
      ...(decideStderr ? { stderr: decideStderr } : {}),
    });
    report.stages.decide = {
      status: stages.decide.status,
      passed: decide.ok,
      policy_id: decide.raw?.policy_id ?? null,
      rule_results: decide.raw?.rule_results ?? null,
      error: decide.raw?.error ?? null,
      ...(decideStderr ? { stderr: decideStderr } : {}),
    };
    if (!decide.ok) {
      stages.act = stageRecord("skipped", { reason: "policy_failed" });
      stages.prove = stageRecord("skipped", { reason: "policy_failed" });
      report.stages.act = stages.act;
      report.stages.prove = stages.prove;
      report.flow = "decide -> stop (policy failed)";
      return finalize();
    }
  } catch (error) {
    exitCode = 1;
    stages.decide = stageRecord("error", stageErrorFields(error));
    stages.act = stageRecord("skipped", { reason: "decide_error" });
    stages.prove = stageRecord("skipped", { reason: "decide_error" });
    report.stages.decide = stages.decide;
    report.stages.act = stages.act;
    report.stages.prove = stages.prove;
    report.flow = "decide -> error";
    return finalize();
  }

  let actStarted = false;
  let proveStarted = false;
  try {
    actStarted = true;
    const act = await (options.runActFn ?? runAct)(fault, {
      depsDir: paths.deps,
      runner,
      domain,
      persistRailBundle: proveMode === "rail" && options.runActFn === undefined,
    });
    const outcome = act.raw?.outcome ?? null;
    stages.act = stageRecord("passed", { raw: act.raw });
    report.stages.act = {
      status: "passed",
      outcome,
      state: act.raw?.state ?? null,
      fault: act.raw?.fault ?? fault,
      action_id: act.raw?.action_id ?? null,
      assurance_mode: act.raw?.assurance_mode ?? null,
      bundle_verification: act.raw?.bundle_verification ?? null,
    };
    report.flow = "decide -> act";
    const shouldProve = forceDispute || outcome !== "settled";
    if (!shouldProve) {
      stages.prove = stageRecord("skipped", { reason: "no_dispute" });
      report.stages.prove = stages.prove;
      return finalize();
    }
    const scenario = "operator";
    proveStarted = true;
    const prove = proveMode === "rail"
      ? await (options.runProveRailFn ?? runProveRail)(act.raw?.rail_bundle ?? null, { depsDir: paths.deps, runner })
      : await (options.runProveFn ?? runProve)(scenario, { depsDir: paths.deps, runner });
    const proveStderr = clipChildStderr(prove.stderr);
    stages.prove = stageRecord(prove.ok ? "passed" : "failed", {
      raw: prove.raw,
      ...(proveStderr ? { stderr: proveStderr } : {}),
    });
    if (!prove.ok) exitCode = 1;
    report.stages.prove = {
      status: stages.prove.status,
      mode: proveMode === "rail" ? "rail-review" : "simulate",
      scenario: proveMode === "rail" ? null : scenario,
      triggered_by: forceDispute && outcome === "settled" ? "--dispute" : `act_outcome=${outcome}`,
      ok: prove.ok,
      result_keys: prove.raw?.result && typeof prove.raw.result === "object" ? Object.keys(prove.raw.result) : [],
      ...(proveMode === "rail" && prove.ok
        ? {
          review_verdict: prove.raw?.result?.verdict ?? null,
          review_id: prove.raw?.result?.reviewId ?? null,
          review_action_id: prove.raw?.result?.actionId ?? null,
        }
        : {}),
      ...(proveStderr ? { stderr: proveStderr } : {}),
    };
    report.flow = "decide -> act -> prove";
    return finalize();
  } catch (error) {
    exitCode = 1;
    if (actStarted && !proveStarted) {
      stages.act = stageRecord("error", stageErrorFields(error));
      report.stages.act = stages.act;
    } else {
      stages.prove = stageRecord("error", stageErrorFields(error));
      report.stages.prove = stages.prove;
    }
    if (actStarted && !proveStarted) stages.prove = stageRecord("skipped", { reason: "act_error" });
    if (proveStarted && stages.act.status === "pending") stages.act = stageRecord("skipped", { reason: "prove_error" });
    report.stages.act = { ...stages.act, raw: undefined };
    report.stages.prove = { ...stages.prove, raw: undefined };
    report.flow = actStarted && !proveStarted ? "decide -> act error" : "decide -> act -> prove error";
    return finalize();
  }
}

function writeCliError(error, { asJson = false, usage = false } = {}) {
  if (asJson) {
    const body = { message: error.message };
    if (error.code) body.code = error.code;
    if (error.stage) body.stage = error.stage;
    const stderr = clipChildStderr(error.stderr);
    if (stderr) body.stderr = stderr;
    process.stderr.write(`${JSON.stringify({ error: body })}\n`);
    return;
  }
  process.stderr.write(`${error.message}\n`);
  if (error.code) process.stderr.write(`code: ${error.code}\n`);
  const stderr = clipChildStderr(error.stderr);
  if (stderr) process.stderr.write(`${stderr}\n`);
  if (usage) process.stderr.write("Try `aas help` for usage.\n");
}

async function readReplayInput(source, { stdin = process.stdin } = {}) {
  if (source === "-") {
    if (stdin.isTTY) throw new UsageError("replay reads stdin only from a pipe; pass a bundle file instead");
    const chunks = [];
    for await (const chunk of stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length > CHILD_JSON_LIMIT) {
      throw new Error(`replay bundle exceeds the ${CHILD_JSON_LIMIT} byte limit`);
    }
    if (text.trim() === "") throw new Error("replay received an empty bundle document");
    return text;
  }
  let text;
  try {
    text = readFileSync(source, "utf8");
  } catch {
    throw new Error(`replay cannot read bundle file: ${source}`);
  }
  if (text.length > CHILD_JSON_LIMIT) {
    throw new Error(`replay bundle exceeds the ${CHILD_JSON_LIMIT} byte limit`);
  }
  if (text.trim() === "") throw new Error("replay received an empty bundle document");
  return text;
}

function runRunsCommand(args, { asJson } = {}) {
  if (args.some((token) => token !== "--json")) {
    throw new UsageError(`Unsupported runs option (expected [--json])`);
  }
  const runs = listRuns({});
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, runs }, null, 2)}\n`);
  } else if (runs.length === 0) {
    process.stdout.write("no runs yet\n");
  } else {
    for (const run of runs) {
      process.stdout.write(
        `${run.run_id} exit=${run.exit_code ?? "?"} decide=${run.stages.decide} act=${run.stages.act} prove=${run.stages.prove}\n`,
      );
    }
  }
  process.exitCode = 0;
}

function runCasesCommand(args, { asJson } = {}) {
  if (args.some((token) => token !== "--json")) {
    throw new UsageError("Unsupported cases option (expected [--json])");
  }
  const cases = listRunSummaries({});
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, cases }, null, 2)}\n`);
  } else if (cases.length === 0) {
    process.stdout.write("no cases yet\n");
  } else {
    for (const entry of cases) {
      process.stdout.write(
        `${entry.run_id} outcome=${entry.outcome ?? "none"} policy=${entry.policy_id ?? "none"} `
          + `review=${entry.review_verdict ?? "none"} exit=${entry.exit_code ?? "?"}\n`,
      );
    }
  }
  process.exitCode = 0;
}

function printComparison(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`comparison: ${result.classification}\n`);
  for (const error of result.errors) process.stdout.write(`  ${error}\n`);
  if (result.classification !== "not-comparable") {
    if (result.differences.length === 0) {
      process.stdout.write("  no compared field differs\n");
    } else {
      for (const difference of result.differences) {
        process.stdout.write(
          `  ${difference.field}: ${JSON.stringify(difference.left)} vs ${JSON.stringify(difference.right)}\n`,
        );
      }
    }
  }
  for (const note of result.notes ?? []) process.stdout.write(`  ${note}\n`);
  process.exitCode = result.classification === "not-comparable" ? 1 : 0;
}

function runCompareCommand(args, { asJson } = {}) {
  const ids = args.filter((token) => token !== "--json");
  if (ids.some((token) => typeof token === "string" && token.startsWith("-"))) {
    throw new UsageError(`Unsupported compare option: ${args.find((token) => String(token).startsWith("-"))}`);
  }
  if (ids.length !== 2) throw new UsageError("Usage: aas compare <run-id> <run-id> [--json]");
  const result = compareRuns(ids[0], ids[1], {});
  printComparison(result, asJson);
}

function runPruneCommand(args, { asJson } = {}) {
  let keep = null;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--keep") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) throw new UsageError("Missing value for prune option: --keep");
      if (keep !== null) throw new UsageError("Duplicate prune option: --keep");
      if (!/^[0-9]+$/.test(value) || Number(value) < 1) throw new UsageError("prune requires --keep <positive integer>");
      keep = Number(value);
      index += 1;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token !== "--json") {
      throw new UsageError(`Unsupported prune option: ${token} (expected --keep <n> [--dry-run] [--json])`);
    }
  }
  if (keep === null) throw new UsageError("Usage: aas prune --keep <positive integer> [--dry-run] [--json]");
  const result = pruneRuns({ keep, dryRun });
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } else if (dryRun) {
    process.stdout.write(
      result.removed.length === 0
        ? `would keep ${result.kept.length} run(s); nothing to remove\n`
        : `would remove ${result.removed.length} run(s): ${result.removed.join(", ")}\n`,
    );
  } else {
    process.stdout.write(
      result.removed.length === 0
        ? `kept ${result.kept.length} run(s); nothing removed\n`
        : `removed ${result.removed.length} run(s): ${result.removed.join(", ")}\n`,
    );
  }
  process.exitCode = 0;
}

function printReplayReport(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [
    `replay: ${result.ok ? "verified" : "failed"}`,
    `run: ${result.runId ?? "unknown"}`,
    ...result.checks.map((check) => `check ${check.name}: ${check.passed ? "pass" : "FAIL"} — ${check.detail}`),
  ];
  if (!result.ok && result.reason) lines.push(`reason: ${result.reason}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function runExportCommand(args, { asJson } = {}) {
  let runId = null;
  let out = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--out") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) throw new UsageError("Missing value for export option: --out");
      if (out !== null) throw new UsageError("Duplicate export option: --out");
      out = value;
      index += 1;
    } else if (typeof token === "string" && token.startsWith("-")) {
      throw new UsageError(`Unsupported export option: ${token}`);
    } else if (runId !== null) {
      throw new UsageError("export accepts exactly one run id");
    } else if (token.trim() === "") {
      throw new UsageError("export requires a non-empty run id");
    } else {
      runId = token;
    }
  }
  if (runId === null) throw new UsageError("Usage: aas export <run-id> [--out <path>]");
  let bundle;
  try {
    bundle = exportRunBundle(runId, {});
  } catch (error) {
    writeCliError(error, { asJson, usage: false });
    process.exitCode = 1;
    return;
  }
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  if (out === null) {
    process.stdout.write(text);
    process.exitCode = 0;
    return;
  }
  try {
    writeAtomicFile(out, text, {});
  } catch (error) {
    writeCliError(error, { asJson, usage: false });
    process.exitCode = 1;
    return;
  }
  if (!asJson) process.stdout.write(`exported: ${out}\n`);
  else process.stdout.write(`${JSON.stringify({ ok: true, out }, null, 2)}\n`);
  process.exitCode = 0;
}

async function runReplayCommand(args, { asJson, nodeVersion, stdin } = {}) {
  let source = null;
  let json = false;
  for (const token of args) {
    if (token === "--json") {
      json = true;
    } else if (typeof token === "string" && token.startsWith("-") && token !== "-") {
      throw new UsageError(`Unsupported replay option: ${token}`);
    } else if (source !== null) {
      throw new UsageError("replay accepts exactly one bundle file or -");
    } else {
      source = token;
    }
  }
  if (source === null) throw new UsageError("Usage: aas replay <bundle-file|-> [--json]");
  assertFullStackNodeVersion(nodeVersion === undefined ? {} : { version: nodeVersion });
  let bundleDoc;
  try {
    bundleDoc = JSON.parse(await readReplayInput(source, { stdin }));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    writeCliError(error, { asJson: json || asJson, usage: false });
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    result = replayBundle(bundleDoc, {});
  } catch (error) {
    writeCliError(error, { asJson: json || asJson, usage: false });
    process.exitCode = 1;
    return;
  }
  printReplayReport(result, json || asJson);
  process.exitCode = result.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const command = argv[0] ?? "help";
  const asJson = has(argv, "--json");
  if (isHelpToken(command) || (command === "demo" && demoRequestsHelp(argv.slice(1)))) {
    printHelp();
    process.exitCode = 0;
    return;
  }
  if (command === "runs" || command === "cases" || command === "compare" || command === "prune") {
    try {
      if (command === "runs") runRunsCommand(argv.slice(1), { asJson });
      else if (command === "cases") runCasesCommand(argv.slice(1), { asJson });
      else if (command === "compare") runCompareCommand(argv.slice(1), { asJson });
      else runPruneCommand(argv.slice(1), { asJson });
    } catch (error) {
      const usage = error instanceof UsageError;
      writeCliError(error, { asJson, usage });
      process.exitCode = usage ? 2 : 1;
    }
    return;
  }
  if (command === "export" || command === "replay") {
    try {
      if (command === "export") runExportCommand(argv.slice(1), { asJson });
      else {
        await runReplayCommand(argv.slice(1), {
          asJson,
          nodeVersion: options.nodeVersion,
          stdin: options.stdin,
        });
      }
    } catch (error) {
      const usage = error instanceof UsageError;
      writeCliError(error, { asJson, usage });
      process.exitCode = usage ? 2 : 1;
    }
    return;
  }
  if (command !== "demo") {
    writeCliError(new UsageError(`Unknown command: ${command}`), { asJson, usage: true });
    if (!asJson) printHelp(process.stderr);
    process.exitCode = 2;
    return;
  }
  try {
    assertFullStackNodeVersion(
      options.nodeVersion === undefined ? {} : { version: options.nodeVersion },
    );
    const python = selectPython();
    const result = await runDemo(argv.slice(1), { ...(python ? { python } : {}) });
    if (asJson) process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    else printHuman(result.report, result.bundleDir);
    process.exitCode = result.exitCode;
  } catch (error) {
    const usage = error instanceof UsageError;
    writeCliError(error, { asJson, usage });
    process.exitCode = usage ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
    process.exitCode = 1;
  });
}
