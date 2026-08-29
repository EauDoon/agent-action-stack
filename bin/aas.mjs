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

function has(args, name) {
  return args.includes(name);
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function validateDemoArgs(args) {
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!DEMO_FLAG_OPTIONS.has(name) && !DEMO_VALUE_OPTIONS.has(name)) {
      throw new Error(`Unsupported demo option: ${name}`);
    }
    if (seen.has(name)) throw new Error(`Duplicate demo option: ${name}`);
    seen.add(name);
    if (DEMO_VALUE_OPTIONS.has(name)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for demo option: ${name}`);
      index += 1;
    }
  }
}

function printHelp() {
  process.stdout.write(`Agent Action Stack

Usage:
  aas demo [--response pass|fail] [--fault none|duplicate|...] [--dispute] [--json]
  aas help

Flow:
  decide -> constitutional-agent-testbench evaluate
  on pass -> consequence-rail demo refund
  on dispute -> mandatebound simulate

First-time setup:
  npm run bootstrap

Each run is written to .out/runs/<run-id>. The .out/latest.json pointer identifies
the most recent complete bundle.
`);
}

export function runCapture(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    ...opts,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function childProcessError(label, result) {
  if (result.error) {
    const code = result.error.code ?? "spawn-error";
    return new Error(`${label} child process error (${code})`);
  }
  return new Error(`${label} child process exited with status ${result.status}`);
}

export function parseJsonOutput(text, label) {
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

function pythonCandidates() {
  if (process.platform === "win32") {
    return [["py", ["-3"]], ["python", []], ["python3", []]];
  }
  return [["python3", []], ["python", []]];
}

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

export function runDecide(
  responsePath,
  { depsDir = DEFAULT_PATHS.deps, fixturesDir = DEFAULT_PATHS.fixtures, runner = runCapture } = {},
) {
  const policyPath = join(fixturesDir, "policy.json");
  const pythonPath = join(depsDir, "constitutional-agent-testbench", "src");
  const env = { ...process.env, PYTHONPATH: pythonPath, PYTHONUTF8: "1" };
  let lastError = null;
  for (const [bin, prefix] of pythonCandidates()) {
    const result = runner(
      bin,
      [...prefix, "-m", "constitutional_agent_testbench.cli", "evaluate", policyPath, responsePath],
      { env },
    );
    if (result.error) {
      lastError = result.error;
      continue;
    }
    if (result.status !== 0) {
      const payload = (result.stdout || "").trim();
      if (payload.startsWith("{")) {
        return { ok: false, raw: parseJsonOutput(payload, "decide"), status: result.status };
      }
      throw childProcessError("decide", result);
    }
    const evaluation = parseJsonOutput(result.stdout, "decide");
    return { ok: booleanField(evaluation, "passed", "decide"), raw: evaluation, status: 0 };
  }
  throw new Error(`Python not found for decide stage${lastError ? ` (${lastError.code ?? "spawn-error"})` : ""}`);
}

export function runAct(
  fault,
  { depsDir = DEFAULT_PATHS.deps, runner = runCapture } = {},
) {
  const crctl = join(depsDir, "consequence-rail", "cmd", "crctl.js");
  const args = ["demo", "refund", "--json"];
  if (fault && fault !== "none") args.push("--fault", fault);
  const result = runner(process.execPath, [crctl, ...args], {
    cwd: join(depsDir, "consequence-rail"),
  });
  if (result.status !== 0) throw childProcessError("act", result);
  const payload = parseJsonOutput(result.stdout, "act");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || ![null, "settled", "compensated", "disputed"].includes(payload.outcome)) {
    throw new Error("act did not return a valid outcome");
  }
  return { ok: true, raw: payload, status: 0 };
}

export function runProve(
  scenario,
  { depsDir = DEFAULT_PATHS.deps, runner = runCapture } = {},
) {
  const cli = join(depsDir, "mandatebound", "dist", "cli.js");
  const result = runner(
    process.execPath,
    [cli, "simulate", "--scenario", scenario],
    { cwd: join(depsDir, "mandatebound") },
  );
  if (result.status !== 0) throw childProcessError("prove", result);
  const payload = parseJsonOutput(result.stdout, "prove");
  return { ok: booleanField(payload, "ok", "prove"), raw: payload, status: 0 };
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
  if (bundleDir) lines.push(`bundle: ${bundleDir}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function runDemo(args = [], options = {}) {
  validateDemoArgs(args);
  const paths = {
    ...DEFAULT_PATHS,
    ...(options.paths ?? {}),
  };
  const responseName = option(args, "--response", "pass");
  if (responseName !== "pass" && responseName !== "fail") throw new Error("--response must be pass or fail");
  const fault = option(args, "--fault", "none");
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
      runner: options.runner,
    });
    stages.decide = stageRecord(decide.ok ? "passed" : "failed", { raw: decide.raw });
    report.stages.decide = {
      status: stages.decide.status,
      passed: decide.ok,
      policy_id: decide.raw?.policy_id ?? null,
      rule_results: decide.raw?.rule_results ?? null,
      error: decide.raw?.error ?? null,
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
    stages.decide = stageRecord("error", { reason: error.message });
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
    const act = await (options.runActFn ?? runAct)(fault, { depsDir: paths.deps, runner: options.runner });
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
    const prove = await (options.runProveFn ?? runProve)(scenario, { depsDir: paths.deps, runner: options.runner });
    stages.prove = stageRecord(prove.ok ? "passed" : "failed", { raw: prove.raw });
    if (!prove.ok) exitCode = 1;
    report.stages.prove = {
      status: stages.prove.status,
      scenario,
      triggered_by: forceDispute && outcome === "settled" ? "--dispute" : `act_outcome=${outcome}`,
      ok: prove.ok,
      result_keys: prove.raw?.result && typeof prove.raw.result === "object" ? Object.keys(prove.raw.result) : [],
    };
    report.flow = "decide -> act -> prove";
    return finalize();
  } catch (error) {
    exitCode = 1;
    if (actStarted && !proveStarted) {
      stages.act = stageRecord("error", { reason: error.message });
      report.stages.act = stages.act;
    } else {
      stages.prove = stageRecord("error", { reason: error.message });
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

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command !== "demo") {
    printHelp();
    process.exitCode = 2;
    return;
  }
  const result = await runDemo(argv.slice(1));
  if (has(argv, "--json")) process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  else printHuman(result.report, result.bundleDir);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
    process.exitCode = 1;
  });
}
