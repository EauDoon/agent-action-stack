#!/usr/bin/env node
/**
 * Minimal integrator example: policy evaluation, synthetic execution,
 * same-case review, and offline replay using the supported public
 * interfaces of the three pinned components.
 *
 * Prerequisite: `npm run bootstrap` (clones the pinned component
 * checkouts the commands below run against).
 *
 * This script only transports bytes between component CLIs and checks the
 * bindings between their outputs. Policy semantics live in
 * constitutional-agent-testbench, execution semantics in consequence-rail,
 * and review semantics in mandatebound.
 *
 * Exit codes: 0 when every binding verifies; 1 with an explicit reason
 * when policy refuses, verification fails, or a binding mismatches.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testbenchDir = join(root, "deps", "constitutional-agent-testbench");
const railDir = join(root, "deps", "consequence-rail");
const mandateboundDir = join(root, "deps", "mandatebound");

function fail(reason) {
  process.stderr.write(`integrator example failed: ${reason}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { response: "pass", fault: "none" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--response" || token === "--fault") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) fail(`Missing value for ${token}`);
      options[token.slice(2)] = value;
      index += 1;
    } else {
      fail(`Unsupported option: ${token} (expected --response pass|fail, --fault none|duplicate)`);
    }
  }
  if (!["pass", "fail"].includes(options.response)) fail("--response must be pass or fail");
  if (!["none", "duplicate"].includes(options.fault)) fail("--fault must be none or duplicate");
  return options;
}

function resolvePython() {
  for (const bin of ["python3", "python"]) {
    const probe = spawnSync(bin, ["-c", "import sys; print(sys.version_info[0] * 100 + sys.version_info[1])"], {
      encoding: "utf8",
      shell: false,
    });
    if (probe.error || probe.status !== 0) continue;
    if (Number.parseInt(probe.stdout.trim(), 10) >= 311) return bin;
  }
  fail("decide needs Python 3.11+ on PATH as python3 (the testbench declares requires-python >= 3.11)");
}

function run(bin, args, { cwd, env }) {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", shell: false, env });
  if (result.error) fail(`cannot spawn ${bin} ${args[0]} (${result.error.code ?? "spawn-error"})`);
  return result;
}

function readJson(label, result) {
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    fail(`${label} did not return JSON (exit ${result.status}): ${result.stderr.slice(-300)}`);
  }
  return payload;
}

function note(text) {
  process.stdout.write(`${text}\n`);
}

function main() {
  const { response, fault } = parseArgs(process.argv.slice(2));
  const python = resolvePython();
  const scratch = mkdtempSync(join(tmpdir(), "aas-integrator-"));
  try {
    const decided = run(python, [
      "-m",
      "constitutional_agent_testbench.cli",
      "evaluate",
      "examples/policy.json",
      response === "pass" ? "examples/passing-response.json" : "examples/failing-response.json",
    ], { cwd: testbenchDir, env: { ...process.env, PYTHONPATH: join(testbenchDir, "src"), PYTHONUTF8: "1" } });
    if (decided.status !== 0) fail(`decide exited ${decided.status}: ${decided.stderr.slice(-300)}`);
    const evaluation = readJson("decide", decided);
    if (evaluation.passed !== true) {
      note("decide: policy refused the response; act and prove are skipped (fail-closed)");
      process.exit(1);
    }
    note(`decide: policy ${evaluation.policy_id} passed (${evaluation.rule_results.length} rules)`);

    const actArgs = ["demo", "refund", "--json", "--out", join(scratch, "rail-bundle.json")];
    if (fault !== "none") actArgs.push("--fault", fault);
    const acted = run(process.execPath, ["cmd/crctl.js", ...actArgs], { cwd: railDir });
    if (acted.status !== 0) fail(`act exited ${acted.status}: ${acted.stderr.slice(-300)}`);
    const summary = readJson("act", acted);
    if (!["settled", "compensated", "disputed"].includes(summary.outcome)) {
      fail(`act returned an unrecognized outcome: ${summary.outcome}`);
    }
    note(`act: ${summary.outcome} (state ${summary.state}, action ${summary.action_id})`);
    const bundleBytes = readFileSync(join(scratch, "rail-bundle.json"));
    const bundle = JSON.parse(bundleBytes.toString("utf8"));
    if (bundle?.action?.action_id !== summary.action_id) {
      fail("act summary and persisted bundle disagree on the action id");
    }

    const verified = run(process.execPath, ["cmd/crctl.js", "bundle", "verify", join(scratch, "rail-bundle.json"), "--json"], {
      cwd: railDir,
    });
    if (verified.status !== 0) fail(`rail verification exited ${verified.status}`);
    const verification = readJson("rail verification", verified);
    if (verification.valid !== true) fail("rail verifier rejected the persisted bundle");
    note(`verify: rail verifier accepts ${verification.action_id} (synthetic demo trust keys)`);

    const digest = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;
    const request = {
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
        actionId: verification.action_id,
        outcome: verification.outcome,
        trustedKeyIds: [verification.trusted_key_id, verification.trusted_connector_key_id].filter(
          (key) => typeof key === "string" && key !== "",
        ),
      },
    };
    writeFileSync(join(scratch, "review-request.json"), JSON.stringify(request));
    const reviewed = run(process.execPath, ["dist/cli.js", "review", "--input", join(scratch, "review-request.json")], {
      cwd: mandateboundDir,
    });
    if (reviewed.status !== 0) fail(`review exited ${reviewed.status}: ${reviewed.stdout.slice(-300)}`);
    const review = readJson("review", reviewed);
    if (review?.ok !== true || review?.result?.verdict !== "recorded") {
      fail(`review did not record the evidence: ${reviewed.stdout.slice(-300)}`);
    }
    const record = review.result;
    if (record.actionId !== summary.action_id || record.evidenceDigest !== digest) {
      fail("review record is not bound to this run's action and digest");
    }
    note(`review: recorded ${record.reviewId} for ${record.actionId}; legal effect ${record.legalEffect}`);
    note("established: policy gate, synthetic execution outcome, rail verification, digest-bound review");
    note("not established: source truth, recovery success, legal effect, protocol compliance");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
