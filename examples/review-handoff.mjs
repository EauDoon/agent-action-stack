#!/usr/bin/env node
/**
 * Minimal integrator example: policy evaluation, bounded synthetic
 * execution, recourse reservation, evidence inspection, same-case review,
 * and offline replay, using the supported public interfaces of the three
 * pinned components.
 *
 * Prerequisite: `npm run bootstrap` (clones the pinned component
 * checkouts the commands below run against).
 *
 * This script only transports bytes between component CLIs and checks the
 * bindings between their outputs. Policy semantics live in
 * constitutional-agent-testbench, execution semantics in consequence-rail,
 * and review semantics in mandatebound. Nothing here is mocked: every step
 * spawns the real component CLI.
 *
 * Exit codes: 0 when every binding verifies; 1 with an explicit reason
 * when policy refuses, verification fails, or a binding mismatches.
 */
import { spawnSync } from "node:child_process";
import { selectPython } from "../bin/aas.mjs";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testbenchDir = join(root, "deps", "constitutional-agent-testbench");
const railDir = join(root, "deps", "consequence-rail");
const mandateboundDir = join(root, "deps", "mandatebound");

const DOMAIN_FIXTURES = {
  refund: {
    policy: "examples/policy.json",
    pass: "examples/passing-response.json",
    fail: "examples/failing-response.json",
    action: "demo.refund.issue/v1",
  },
  inventory: {
    policy: join(root, "fixtures", "inventory.policy.json"),
    pass: join(root, "fixtures", "inventory.response.pass.json"),
    fail: join(root, "fixtures", "inventory.response.fail.json"),
    action: "demo.inventory.allocate/v1",
  },
};

function fail(reason) {
  process.stderr.write(`integrator example failed: ${reason}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { domain: "refund", response: "pass", fault: "none" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--response" || token === "--fault" || token === "--domain") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) fail(`Missing value for ${token}`);
      options[token.slice(2)] = value;
      index += 1;
    } else {
      fail(`Unsupported option: ${token} (expected --domain refund|inventory, --response pass|fail, --fault none|duplicate)`);
    }
  }
  if (!Object.hasOwn(DOMAIN_FIXTURES, options.domain)) fail(`--domain must be one of: ${Object.keys(DOMAIN_FIXTURES).join(", ")}`);
  if (!["pass", "fail"].includes(options.response)) fail("--response must be pass or fail");
  if (!["none", "duplicate"].includes(options.fault)) fail("--fault must be none or duplicate");
  return options;
}


function run(bin, args, { cwd, env }) {
  const result = spawnSync(bin, args, { cwd, env, encoding: "utf8", shell: false });
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
  const { domain, response, fault } = parseArgs(process.argv.slice(2));
  const fixture = DOMAIN_FIXTURES[domain];
  const python = selectPython();
  if (!python) fail("decide needs Python 3.11+; set AAS_PYTHON to a working interpreter.");
  const scratch = mkdtempSync(join(tmpdir(), "aas-integrator-"));
  try {
    note(`domain: ${domain} (${fixture.action})`);

    // 1. Policy evaluation.
    const decided = run(python.bin, [...python.prefix,
      "-m",
      "constitutional_agent_testbench.cli",
      "evaluate",
      fixture.policy,
      response === "pass" ? fixture.pass : fixture.fail,
    ], { cwd: testbenchDir, env: { ...process.env, PYTHONPATH: join(testbenchDir, "src"), PYTHONUTF8: "1" } });
    if (decided.status !== 0) fail(`decide exited ${decided.status}: ${decided.stderr.slice(-300)}`);
    const evaluation = readJson("decide", decided);
    if (evaluation.passed !== true) {
      note("decide: policy refused the response; act and prove are skipped (fail-closed)");
      process.exit(1);
    }
    note(`decide: policy ${evaluation.policy_id} passed (${evaluation.rule_results.length} rules)`);

    // 2. Execution. The rail reserves recourse before issuing a permit and
    // executes once; `--out` persists the settlement bundle for review.
    const bundlePath = join(scratch, "rail-bundle.json");
    const actArgs = ["demo", domain, "--json", "--out", bundlePath];
    if (fault !== "none") actArgs.push("--fault", fault);
    const acted = run(process.execPath, ["cmd/crctl.js", ...actArgs], { cwd: railDir });
    if (acted.status !== 0) fail(`act exited ${acted.status}: ${acted.stderr.slice(-300)}`);
    const summary = readJson("act", acted);
    if (!["settled", "compensated", "disputed"].includes(summary.outcome)) {
      fail(`act returned an unrecognized outcome: ${summary.outcome}`);
    }
    note(`act: ${summary.outcome} (state ${summary.state}, action ${summary.action_id})`);
    const bundleBytes = readFileSync(bundlePath);
    const bundle = JSON.parse(bundleBytes.toString("utf8"));
    if (bundle?.action?.action_id !== summary.action_id) {
      fail("act summary and persisted bundle disagree on the action id");
    }
    note(`act: recourse reservations ${summary.recourse_reservation_calls ?? 0}, remedies ${summary.remedy_calls ?? 0}`);

    // 3. Evidence inspection: what the rail recorded, not what we hope it says.
    const evidence = bundle.outcome_evidence ?? [];
    const facts = evidence.length > 0 ? evidence[evidence.length - 1].facts ?? {} : {};
    note(`evidence: ${JSON.stringify(facts)}`);
    const receipt = bundle.settlement_receipt ?? {};
    note(`receipt: outcome ${receipt.outcome ?? "none"}, recourse ${receipt.recourse_final_status ?? "none"}, `
      + `evidence digests ${(receipt.evidence_digests ?? []).length}`);

    // 4. Verification with the rail's own verifier over the persisted bytes.
    const verified = run(process.execPath, ["cmd/crctl.js", "bundle", "verify", bundlePath, "--json"], {
      cwd: railDir,
    });
    if (verified.status !== 0) fail(`rail verification exited ${verified.status}`);
    const verification = readJson("rail verification", verified);
    if (verification.valid !== true) fail("rail verifier rejected the persisted bundle");
    note(`verify: rail verifier accepts ${verification.action_id} (synthetic demo trust keys)`);

    // 5. Same-case review: bind the same action and digest in MandateBound.
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

    // 6. Offline replay. The orchestrator packages the same components into a
    // run bundle; export it and replay it without rerunning the action.
    const orchestrated = run(process.execPath, [join(root, "bin", "aas.mjs"), "demo", "--domain", domain, "--fault", fault, "--dispute", "--prove", "rail", "--json"], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: join(testbenchDir, "src"), PYTHONUTF8: "1" },
    });
    if (orchestrated.status !== 0) fail(`orchestrated demo exited ${orchestrated.status}: ${orchestrated.stderr.slice(-300)}`);
    const runId = readJson("orchestrated demo", orchestrated).run_id;
    if (typeof runId !== "string") fail("orchestrated demo did not report a run id");
    const casePath = join(scratch, "case.json");
    const exported = run(process.execPath, [join(root, "bin", "aas.mjs"), "export", runId, "--out", casePath], { cwd: root });
    if (exported.status !== 0) fail(`export exited ${exported.status}: ${exported.stderr.slice(-300)}`);
    const exportedCase = JSON.parse(readFileSync(casePath, "utf8"));
    if (exportedCase?.report?.run_id !== runId) fail("exported case does not match the run id");
    const replayed = run(process.execPath, [join(root, "bin", "aas.mjs"), "replay", casePath, "--json"], {
      cwd: root,
    });
    if (replayed.status !== 0) fail(`replay exited ${replayed.status}: ${replayed.stdout.slice(-300)}`);
    const replayReport = readJson("replay", replayed);
    if (replayReport.ok !== true) fail(`replay did not verify the case: ${replayReport.reason ?? "unknown reason"}`);
    note(`replay: ${replayReport.checks.length} checks passed offline for run ${runId}`);

    note("established: policy gate, synthetic execution outcome, recourse reservation, evidence, "
      + "rail verification, digest-bound review, offline replay");
    note("not established: source truth, recovery success, legal effect, protocol compliance, "
      + "or that any real-world action is reversible or safe");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
