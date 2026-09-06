#!/usr/bin/env node
/**
 * Full-stack integration proof for the committed component pins.
 *
 * From a clean checkout: install the root package, bootstrap the locked
 * dependencies, then exercise the pass, policy-refusal, and
 * compensated/dispute demo paths while asserting exact dependency SHAs,
 * clean tracked files, structured outcomes, stage gating, and
 * stale-artifact isolation.
 *
 * The prove stage runs the synthetic MandateBound operator simulation only;
 * a passing prove stage does not verify the rail case and claims no evidence
 * handoff or binding to the rail bundle.
 *
 * Run through `npm run integration`: the npm runner locates the npm CLI on
 * every platform (required for the install step on Windows).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFullStackNodeVersion,
  loadComponentLock,
  npmInvocation,
} from "./bootstrap.mjs";
import { createGuiServer } from "../bin/aas-gui.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
  return Boolean(condition);
}

function run(command, args, { cwd = root } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

function runNpm(args) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args);
}

function git(target, args) {
  return run("git", ["-C", target, ...args]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function latestBundle() {
  const pointer = readJson(join(root, ".out", "latest.json"));
  const bundleDir = join(root, ".out", pointer.manifest.split("/manifest.json")[0]);
  return { pointer, bundleDir, manifest: readJson(join(bundleDir, "manifest.json")) };
}

function stageFiles(bundleDir) {
  return readdirSync(join(bundleDir, "stages")).sort();
}

function runDemo(args) {
  const result = run(process.execPath, ["./bin/aas.mjs", "demo", ...args, "--json"]);
  check(result.status === 0, `demo ${args.join(" ") || "(pass)"} exited ${result.status}: ${result.stderr.slice(-400)}`);
  return result;
}

async function main() {
  assertFullStackNodeVersion();

  const install = runNpm(["ci", "--ignore-scripts"]);
  check(install.status === 0, `npm ci failed: ${install.stderr.slice(-400)}`);

  const bootstrap = run(process.execPath, ["./scripts/bootstrap.mjs"]);
  check(bootstrap.status === 0, `bootstrap failed: ${bootstrap.stderr.slice(-400)}`);

  const components = loadComponentLock(join(root, "stack-lock.json"));
  for (const component of components) {
    const target = join(root, "deps", component.name);
    const head = git(target, ["rev-parse", "HEAD"]);
    check(
      head.status === 0 && head.stdout.trim() === component.commit,
      `deps/${component.name} HEAD ${head.stdout.trim()} does not match pin ${component.commit}`,
    );
    const origin = git(target, ["config", "--get", "remote.origin.url"]);
    check(
      origin.stdout.trim().replace(/\.git$/, "") === component.repository.replace(/\.git$/, ""),
      `deps/${component.name} origin ${origin.stdout.trim()} does not match ${component.repository}`,
    );
    const status = git(target, ["status", "--porcelain", "--untracked-files=no"]);
    check(status.stdout.trim() === "", `deps/${component.name} has tracked modifications`);
    for (const entrypoint of [...component.expected_entrypoints, ...(component.post_build_entrypoints ?? [])]) {
      check(existsSync(join(target, entrypoint)), `deps/${component.name} is missing ${entrypoint}`);
    }
  }

  runDemo([]);
  {
    const { manifest } = latestBundle();
    check(manifest.stages.decide?.status === "passed", "pass path: decide did not pass");
    check(manifest.stages.act?.status === "passed", "pass path: act did not pass");
    check(manifest.stages.prove?.status === "skipped", "pass path: prove was not skipped");
    check(
      JSON.stringify(stageFiles(latestBundle().bundleDir)) === JSON.stringify(["act.json", "decide.json"]),
      "pass path: stale or missing stage artifacts",
    );
    const provenance = Object.fromEntries(
      (manifest.component_provenance ?? []).map((entry) => [entry.name, entry]),
    );
    for (const component of components) {
      const entry = provenance[component.name];
      check(entry?.commit === component.commit, `pass path: provenance for ${component.name} is not the pin`);
      check(entry?.detached === true && entry?.clean === true, `pass path: ${component.name} provenance is not detached clean`);
    }
  }

  runDemo(["--response", "fail"]);
  {
    const { manifest } = latestBundle();
    check(manifest.stages.decide?.status === "failed", "refusal path: decide did not fail");
    check(manifest.stages.act?.status === "skipped", "refusal path: act was not skipped");
    check(manifest.stages.prove?.status === "skipped", "refusal path: prove was not skipped");
    check(
      JSON.stringify(stageFiles(latestBundle().bundleDir)) === JSON.stringify(["decide.json"]),
      "refusal path: bundle reuses artifacts from another run",
    );
  }

  runDemo(["--fault", "duplicate"]);
  {
    const { bundleDir, manifest } = latestBundle();
    check(manifest.stages.decide?.status === "passed", "dispute path: decide did not pass");
    check(manifest.stages.act?.status === "passed", "dispute path: act did not pass");
    check(manifest.stages.prove?.status === "passed", "dispute path: prove did not pass");
    const report = readJson(join(bundleDir, "report.json"));
    check(report.flow === "decide -> act -> prove", `dispute path: unexpected flow ${report.flow}`);
    const act = readJson(join(bundleDir, "stages", "act.json"));
    check(act.outcome === "compensated" || act.fault === "duplicate", "dispute path: act is not the compensated outcome");
    const prove = readJson(join(bundleDir, "stages", "prove.json"));
    check(prove.ok === true, "dispute path: prove payload is not ok");
    check(
      JSON.stringify(stageFiles(bundleDir)) === JSON.stringify(["act.json", "decide.json", "prove.json"]),
      "dispute path: stale or missing stage artifacts",
    );
  }

  runDemo(["--fault", "duplicate", "--prove", "rail"]);
  {
    const { bundleDir, manifest } = latestBundle();
    check(manifest.stages.decide?.status === "passed", "rail-review path: decide did not pass");
    check(manifest.stages.act?.status === "passed", "rail-review path: act did not pass");
    check(manifest.stages.prove?.status === "passed", "rail-review path: prove did not pass");
    const report = readJson(join(bundleDir, "report.json"));
    check(report.flow === "decide -> act -> prove", `rail-review path: unexpected flow ${report.flow}`);
    check(report.stages.prove?.mode === "rail-review", "rail-review path: prove mode not recorded");
    check(report.stages.prove?.review_verdict === "recorded", "rail-review path: review not recorded");
    const act = readJson(join(bundleDir, "stages", "act.json"));
    const prove = readJson(join(bundleDir, "stages", "prove.json"));
    const review = prove.result;
    check(
      review?.actionId === act.action_id,
      "rail-review path: review is not bound to the act action id",
    );
    check(
      review?.legalEffect === "not-determined",
      "rail-review path: review claims a legal effect",
    );
    const bundleBytes = Buffer.from(JSON.stringify(act.rail_bundle), "utf8");
    check(
      review?.evidenceDigest === `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`,
      "rail-review path: review digest does not match the persisted rail bundle",
    );
    check(
      JSON.stringify(stageFiles(bundleDir)) === JSON.stringify(["act.json", "decide.json", "prove.json"]),
      "rail-review path: stale or missing stage artifacts",
    );
  }

  runDemo(["--dispute", "--prove", "rail"]);
  {
    const { bundleDir, manifest } = latestBundle();
    check(manifest.stages.decide?.status === "passed", "settled-review path: decide did not pass");
    check(manifest.stages.act?.status === "passed", "settled-review path: act did not pass");
    check(manifest.stages.prove?.status === "passed", "settled-review path: prove did not pass");
    const report = readJson(join(bundleDir, "report.json"));
    check(report.flow === "decide -> act -> prove", `settled-review path: unexpected flow ${report.flow}`);
    check(report.stages.prove?.mode === "rail-review", "settled-review path: prove mode not recorded");
    check(report.stages.prove?.triggered_by === "--dispute", "settled-review path: wrong trigger");
    const act = readJson(join(bundleDir, "stages", "act.json"));
    const prove = readJson(join(bundleDir, "stages", "prove.json"));
    check(act.outcome === "settled", "settled-review path: act is not settled");
    check(
      prove.result?.verdict === "recorded" && prove.result?.actionId === act.action_id,
      "settled-review path: review not bound to the settled action",
    );
  }

  let casePath = null;
  let latest = null;
  {
    latest = readJson(join(root, ".out", "latest.json"));
    casePath = join(root, ".out", "replay-case.json");
    const exported = run(process.execPath, ["./bin/aas.mjs", "export", latest.run_id, "--out", casePath]);
    check(exported.status === 0, `export failed: ${exported.stderr.slice(-400)}`);
    const replayed = run(process.execPath, ["./bin/aas.mjs", "replay", casePath, "--json"]);
    check(replayed.status === 0, `replay failed: ${replayed.stdout.slice(-400)}${replayed.stderr.slice(-400)}`);
    if (replayed.status === 0) {
      const replayReport = JSON.parse(replayed.stdout);
      check(replayReport.ok === true, "replay report is not ok");
      check(
        replayReport.checks.every((check) => check.passed),
        "replay left a failing check",
      );
    }
  }

  {
    const server = createGuiServer({ outputRoot: join(root, ".out") });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address();
      const body = readFileSync(casePath, "utf8");
      const replayed = await new Promise((resolve, reject) => {
        const req = httpRequest(
          { hostname: "127.0.0.1", port, path: "/api/replay", method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` } },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { text += chunk; });
            response.on("end", () => resolve({ status: response.statusCode, text }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
      check(replayed.status === 200, `GUI replay of the exported case returned ${replayed.status}`);
      if (replayed.status === 200) {
        const report = JSON.parse(replayed.text);
        check(report.ok === true, "GUI replay did not verify the exported case");
        check(report.run_id === latest.run_id, "GUI replay reported a different run id");
        check(
          JSON.stringify(report.checks.map((entry) => entry.name)) === JSON.stringify([
            "evidence-available",
            "identity-binding",
            "digest-binding",
            "rail-verification",
            "review-request",
            "review-replay",
          ]),
          "GUI replay did not run every supported check",
        );
        check(
          report.checks.every((entry) => entry.passed === true && typeof entry.detail === "string"),
          "GUI replay left a failing check",
        );
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const inventory = run(process.execPath, ["./bin/aas.mjs", "demo", "--domain", "inventory", "--fault", "duplicate", "--prove", "rail"]);
  check(inventory.status === 0, `inventory demo failed: ${inventory.stderr.slice(-400)}`);
  {
    const { bundleDir, manifest } = latestBundle();
    check(manifest.stages.decide?.status === "passed", "inventory: decide did not pass");
    check(manifest.stages.act?.status === "passed", "inventory: act did not pass");
    check(manifest.stages.prove?.status === "passed", "inventory: prove did not pass");
    const report = readJson(join(bundleDir, "report.json"));
    check(report.flow === "decide -> act -> prove", `inventory: unexpected flow ${report.flow}`);
    check(report.stages.prove?.mode === "rail-review", "inventory: prove mode not recorded");
    const act = readJson(join(bundleDir, "stages", "act.json"));
    check(act.outcome === "compensated", "inventory: act is not compensated");
    check(
      report.stages.decide?.policy_id === "aas-inventory-gate-v1",
      `inventory: unexpected policy ${report.stages.decide?.policy_id}`,
    );
    const provenance = readJson(join(bundleDir, "manifest.json"));
    check(
      provenance.component_provenance.some((entry) => entry.name === "consequence-rail"),
      "inventory: rail provenance missing",
    );
  }

  const cases = run(process.execPath, ["./bin/aas.mjs", "cases", "--json"]);
  check(cases.status === 0, `cases failed: ${cases.stderr.slice(-300)}`);
  if (cases.status === 0) {
    const listed = JSON.parse(cases.stdout).cases;
    check(Array.isArray(listed) && listed.length >= 2, "cases did not list the runs made here");
    const [newest, older] = listed;
    const compared = run(process.execPath, ["./bin/aas.mjs", "compare", newest.run_id, older.run_id, "--json"]);
    check(compared.status === 0, `compare failed: ${compared.stderr.slice(-300)}`);
    if (compared.status === 0) {
      const result = JSON.parse(compared.stdout);
      check(
        ["identical", "different", "not-comparable"].includes(result.classification),
        `unexpected classification ${result.classification}`,
      );
      check(result.left?.run_id === newest.run_id, "compare reported the wrong left run");
    }
    const invalid = run(process.execPath, ["./bin/aas.mjs", "compare", newest.run_id]);
    check(invalid.status !== 0, "compare accepted a single run id");
  }

  const tree = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  check(tree.stdout.trim() === "", `integration runs left tracked modifications: ${tree.stdout.trim().slice(0, 200)}`);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`integration check failed: ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `integration check: ${components.length} pinned dependencies verified across pass, refusal, dispute, settled-review, and rail-review paths\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`integration check crashed: ${error.stack}\n`);
  process.exit(1);
});
