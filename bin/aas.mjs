#!/usr/bin/env node
/**
 * Agent Action Stack orchestrator.
 *
 * Flow:
 *   1. Decide  — Constitutional Agent Testbench evaluates structured agent JSON
 *   2. On pass — Consequence Rail executes with recourse gating
 *   3. On dispute (compensated / disputed / --dispute) — MandateBound simulates evidence readiness
 *
 * Public deps only. Private repos are never touched.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deps = join(root, "deps");
const fixtures = join(root, "fixtures");
const outDir = join(root, ".out");

const DISPUTE_OUTCOMES = new Set(["compensated", "disputed"]);

function has(args, name) {
  return args.includes(name);
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function printHelp() {
  process.stdout.write(`Agent Action Stack

Usage:
  aas demo [--response pass|fail] [--fault none|duplicate|...] [--dispute] [--json]
  aas help

Flow:
  decide  → constitutional-agent-testbench evaluate
  on pass → consequence-rail demo refund
  on dispute (compensated|disputed|--dispute) → mandatebound simulate

First-time setup:
  npm run bootstrap
`);
}

function requireDeps() {
  const needed = [
    "constitutional-agent-testbench",
    "consequence-rail",
    "mandatebound",
  ];
  const missing = needed.filter((name) => !existsSync(join(deps, name)));
  if (missing.length > 0) {
    throw new Error(
      `Missing deps/${missing.join(", ")}. Run: npm run bootstrap`,
    );
  }
  if (!existsSync(join(deps, "mandatebound", "dist", "cli.js"))) {
    throw new Error("mandatebound is not built. Run: npm run bootstrap");
  }
}

function runCapture(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    // Never use shell:true with absolute paths that contain spaces
    // (Windows: C:\Program Files\nodejs\node.exe).
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

function parseJsonOutput(text, label) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`${label} produced empty output.`);
  }
  // Prefer last JSON object/array line if mixed with logs.
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        return JSON.parse(line);
      } catch {
        // continue
      }
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

function pythonCandidates() {
  if (process.platform === "win32") {
    return [
      ["py", ["-3"]],
      ["python", []],
      ["python3", []],
    ];
  }
  return [
    ["python3", []],
    ["python", []],
  ];
}

function runDecide(responsePath) {
  const policyPath = join(fixtures, "policy.json");
  const pythonPath = join(deps, "constitutional-agent-testbench", "src");
  const env = {
    ...process.env,
    PYTHONPATH: pythonPath,
    PYTHONUTF8: "1",
  };

  let lastError = null;
  for (const [bin, prefix] of pythonCandidates()) {
    const result = runCapture(
      bin,
      [
        ...prefix,
        "-m",
        "constitutional_agent_testbench.cli",
        "evaluate",
        policyPath,
        responsePath,
      ],
      { env },
    );
    if (result.error) {
      lastError = result.error;
      continue;
    }
    if (result.status !== 0) {
      const payload = (result.stdout || result.stderr).trim();
      if (payload.startsWith("{")) {
        return { ok: false, raw: parseJsonOutput(payload, "decide"), status: result.status };
      }
      throw new Error(`Decide failed (${result.status}): ${result.stderr || result.stdout}`);
    }
    const evaluation = parseJsonOutput(result.stdout, "decide");
    return { ok: Boolean(evaluation.passed), raw: evaluation, status: 0 };
  }
  throw new Error(
    `Python not found for decide stage${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function runAct(fault) {
  const crctl = join(deps, "consequence-rail", "cmd", "crctl.js");
  const args = ["demo", "refund", "--json"];
  if (fault && fault !== "none") {
    args.push("--fault", fault);
  }
  const result = runCapture(process.execPath, [crctl, ...args], { cwd: join(deps, "consequence-rail") });
  if (result.status !== 0) {
    throw new Error(`Act failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  const summary = parseJsonOutput(result.stdout, "act");
  return { ok: true, raw: summary, status: 0 };
}

function runProve(scenario) {
  const cli = join(deps, "mandatebound", "dist", "cli.js");
  const result = runCapture(
    process.execPath,
    [cli, "simulate", "--scenario", scenario],
    { cwd: join(deps, "mandatebound") },
  );
  if (result.status !== 0) {
    throw new Error(`Prove failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  const payload = parseJsonOutput(result.stdout, "prove");
  return { ok: Boolean(payload.ok), raw: payload, status: 0 };
}

function printHuman(report) {
  const lines = [
    `stack: agent-action-stack`,
    `response: ${report.response}`,
    `decide: ${report.stages.decide.status}`,
    `decide_passed: ${report.stages.decide.passed}`,
  ];
  if (report.stages.act) {
    lines.push(`act: ${report.stages.act.status}`);
    lines.push(`act_outcome: ${report.stages.act.outcome ?? "none"}`);
    lines.push(`act_state: ${report.stages.act.state ?? "none"}`);
    lines.push(`act_fault: ${report.stages.act.fault}`);
  } else {
    lines.push(`act: skipped`);
  }
  if (report.stages.prove) {
    lines.push(`prove: ${report.stages.prove.status}`);
    lines.push(`prove_scenario: ${report.stages.prove.scenario}`);
    lines.push(`prove_triggered_by: ${report.stages.prove.triggered_by}`);
  } else {
    lines.push(`prove: skipped`);
  }
  lines.push(`flow: ${report.flow}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function demo(args) {
  requireDeps();
  mkdirSync(outDir, { recursive: true });

  const responseName = option(args, "--response", "pass");
  if (responseName !== "pass" && responseName !== "fail") {
    throw new Error("--response must be pass or fail");
  }
  const fault = option(args, "--fault", "none");
  const forceDispute = has(args, "--dispute");
  const asJson = has(args, "--json");
  const responsePath = join(fixtures, `response.${responseName}.json`);

  const decide = runDecide(responsePath);
  writeFileSync(join(outDir, "decide.json"), `${JSON.stringify(decide.raw, null, 2)}\n`);

  const report = {
    stack: "agent-action-stack",
    response: responseName,
    flow: "decide",
    stages: {
      decide: {
        status: decide.ok ? "pass" : "fail",
        passed: decide.ok,
        policy_id: decide.raw.policy_id ?? null,
        rule_results: decide.raw.rule_results ?? null,
        error: decide.raw.error ?? null,
      },
    },
  };

  if (!decide.ok) {
    report.flow = "decide → stop (policy failed)";
    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printHuman(report);
    }
    process.exitCode = 0;
    return;
  }

  const act = runAct(fault);
  writeFileSync(join(outDir, "act.json"), `${JSON.stringify(act.raw, null, 2)}\n`);
  const outcome = act.raw.outcome ?? null;
  const state = act.raw.state ?? null;
  report.stages.act = {
    status: "ran",
    outcome,
    state,
    fault: act.raw.fault ?? fault,
    action_id: act.raw.action_id ?? null,
    assurance_mode: act.raw.assurance_mode ?? null,
    bundle_verification: act.raw.bundle_verification ?? null,
  };
  report.flow = "decide → act";

  const disputeBecauseOutcome = DISPUTE_OUTCOMES.has(outcome);
  const shouldProve = forceDispute || disputeBecauseOutcome;
  if (shouldProve) {
    const scenario = "operator";
    const prove = runProve(scenario);
    writeFileSync(join(outDir, "prove.json"), `${JSON.stringify(prove.raw, null, 2)}\n`);
    report.stages.prove = {
      status: prove.ok ? "pass" : "fail",
      scenario,
      triggered_by: forceDispute && !disputeBecauseOutcome ? "--dispute" : `act_outcome=${outcome}`,
      ok: prove.ok,
      result_keys: prove.raw.result && typeof prove.raw.result === "object"
        ? Object.keys(prove.raw.result)
        : [],
    };
    report.flow = "decide → act → prove";
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "demo") {
    await demo(args.slice(1));
    return;
  }
  printHelp();
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
  process.exitCode = 1;
});
