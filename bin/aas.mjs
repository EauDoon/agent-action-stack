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
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
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
const DEMO_VALUE_OPTIONS = new Set(["--response", "--fault"]);
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
  aas demo [--response pass|fail] [--fault none|duplicate] [--dispute] [--json]
  aas help

Options:
  --response pass|fail     Policy fixture to evaluate (default: pass)
  --fault none|duplicate   Rail demo fault (default: none)
  --dispute                Force MandateBound prove after a settled act
  --json                   Print the run report as JSON
  -h, --help               Show this help

Flow:
  decide -> constitutional-agent-testbench evaluate
  on pass -> consequence-rail demo refund
  on dispute -> mandatebound simulate --scenario operator

First-time setup:
  npm run bootstrap

Missing child tools fail closed with a bootstrap hint. Each run is written to
.out/runs/<run-id>. The .out/latest.json pointer identifies the most recent
complete bundle.

Environment:
  AAS_CHILD_TIMEOUT_MS  Child process timeout in milliseconds (default: 30000)
  AAS_GUI_PORT          Loopback port for the local GUI (default: 8787)

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

function pythonCandidates() {
  if (process.platform === "win32") {
    return [["py", ["-3"]], ["python", []], ["python3", []]];
  }
  return [["python3", []], ["python", []]];
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
  { depsDir = DEFAULT_PATHS.deps, fixturesDir = DEFAULT_PATHS.fixtures, runner = runCapture } = {},
) {
  const policyPath = join(fixturesDir, "policy.json");
  const pythonPath = join(depsDir, "constitutional-agent-testbench", "src");
  const decideCli = join(pythonPath, "constitutional_agent_testbench", "cli.py");
  if (runner === runCapture && !existsSync(decideCli)) {
    throw missingChildTool("decide CLI (deps/constitutional-agent-testbench/src/constitutional_agent_testbench/cli.py)");
  }
  const env = { ...process.env, PYTHONPATH: pythonPath, PYTHONUTF8: "1" };
  let lastError = null;
  for (const [bin, prefix] of pythonCandidates()) {
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
  { depsDir = DEFAULT_PATHS.deps, runner = runCapture } = {},
) {
  const crctl = join(depsDir, "consequence-rail", "cmd", "crctl.js");
  if (runner === runCapture && !existsSync(crctl)) {
    throw missingChildTool("act CLI (deps/consequence-rail/cmd/crctl.js)");
  }
  const args = ["demo", "refund", "--json"];
  if (fault && fault !== "none") args.push("--fault", fault);
  const result = runner(process.execPath, [crctl, ...args], {
    cwd: join(depsDir, "consequence-rail"),
  });
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
  return { ok: true, raw: payload, status: 0 };
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

export function createRunId(now = new Date(), nonce = randomUUID()) {
  return `${now.toISOString().replace(/[:.]/g, "")}-${nonce.slice(0, 12)}`;
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
  try {
    writeFile(temporary, data, { encoding: "utf8", flag: "wx" });
    rename(temporary, target);
  } catch (error) {
    try {
      unlink(temporary);
    } catch {
      // Preserve the original write or rename error.
    }
    throw error;
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
  const responsePath = join(paths.fixtures, `response.${responseName}.json`);
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
    const act = await (options.runActFn ?? runAct)(fault, { depsDir: paths.deps, runner });
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
    const prove = await (options.runProveFn ?? runProve)(scenario, { depsDir: paths.deps, runner });
    const proveStderr = clipChildStderr(prove.stderr);
    stages.prove = stageRecord(prove.ok ? "passed" : "failed", {
      raw: prove.raw,
      ...(proveStderr ? { stderr: proveStderr } : {}),
    });
    if (!prove.ok) exitCode = 1;
    report.stages.prove = {
      status: stages.prove.status,
      scenario,
      triggered_by: forceDispute && outcome === "settled" ? "--dispute" : `act_outcome=${outcome}`,
      ok: prove.ok,
      result_keys: prove.raw?.result && typeof prove.raw.result === "object" ? Object.keys(prove.raw.result) : [],
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

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help";
  const asJson = has(argv, "--json");
  if (isHelpToken(command) || (command === "demo" && demoRequestsHelp(argv.slice(1)))) {
    printHelp();
    process.exitCode = 0;
    return;
  }
  if (command !== "demo") {
    writeCliError(new UsageError(`Unknown command: ${command}`), { asJson, usage: true });
    if (!asJson) printHelp(process.stderr);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runDemo(argv.slice(1));
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
