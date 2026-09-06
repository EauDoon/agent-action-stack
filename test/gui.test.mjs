import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindingsModel, createGuiServer, renderPage, summaryModel } from "../bin/aas-gui.mjs";
import { runDemo } from "../bin/aas.mjs";

const provenance = [
  { name: "constitutional-agent-testbench", repository: "https://github.com/EauDoon/constitutional-agent-testbench.git", commit: "a7a51907eaaab68a52b66edef28b3ee0fcb3ff97", detached: true, clean: true, entrypoints: [] },
  { name: "consequence-rail", repository: "https://github.com/EauDoon/consequence-rail.git", commit: "d1bacc66618591231270902b657ffaa752954ee6", detached: true, clean: true, entrypoints: [] },
  { name: "mandatebound", repository: "https://github.com/EauDoon/mandatebound.git", commit: "468fce7e0d4dcc1e86bad07a469b3d9217914bb0", detached: true, clean: true, entrypoints: [] },
];

function requestServer(server, path, { method = "GET", headers = {} } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("GUI exposes a guided page and uses the orchestrator run bundle", async () => {
  assert.match(renderPage(), /Run stack/);
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-action-stack-gui-"));
  const server = createGuiServer({
    outputRoot,
    runDemoFn: (args, options) => runDemo(args, {
      ...options,
      runId: "gui-run",
      componentResolver: () => provenance,
      runDecideFn: async () => ({ ok: true, raw: { passed: true }, status: 0 }),
      runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED" }, status: 0 }),
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const health = await requestServer(server, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    const address = server.address();
    const run = await requestServer(server, "/api/run?response=pass&fault=none", {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${address.port}` },
    });
    assert.equal(run.status, 200);
    const runBody = JSON.parse(run.body);
    assert.equal(runBody.run_id, "gui-run");
    const bundle = await requestServer(server, "/api/bundle/gui-run");
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers["content-disposition"], /attachment/);
    assert.equal(JSON.parse(bundle.body).manifest.run_id, "gui-run");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("GUI rejects rebinding requests, cross-origin runs, unsafe options, and unsafe artifact paths", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-action-stack-gui-boundary-"));
  const server = createGuiServer({ outputRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const badHost = await requestServer(server, "/api/health", { headers: { host: `localhost:${address.port}` } });
    assert.equal(badHost.status, 403);
    const foreignOrigin = await requestServer(server, "/api/run", {
      method: "POST",
      headers: { origin: "https://example.invalid" },
    });
    assert.equal(foreignOrigin.status, 403);
    const missingOrigin = await requestServer(server, "/api/run", { method: "POST" });
    assert.equal(missingOrigin.status, 400);
    assert.equal(JSON.parse(missingOrigin.body).error, "Origin header required for POST");
    const getRun = await requestServer(server, "/api/run?response=pass&fault=none");
    assert.equal(getRun.status, 404);
    const unsafeOption = await requestServer(server, "/api/run?response=..%2Fsecret&fault=none", {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${address.port}` },
    });
    assert.equal(unsafeOption.status, 400);

    const bundleDir = join(outputRoot, "runs", "unsafe-run");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "manifest.json"), `${JSON.stringify({ report: "../outside.json", stages: {} })}\n`);
    const unsafeBundle = await requestServer(server, "/api/bundle/unsafe-run");
    assert.equal(unsafeBundle.status, 500);
    assert.deepEqual(JSON.parse(unsafeBundle.body), { error: "Request failed" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("GUI run rejects an old runtime before invoking the orchestrator", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-action-stack-gui-node-"));
  let calls = 0;
  const server = createGuiServer({
    outputRoot,
    runDemoFn: () => {
      calls += 1;
      throw new Error("must not run on an old runtime");
    },
    runOptions: { nodeVersion: "20.19.0" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const run = await requestServer(server, "/api/run?response=pass&fault=none", {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${address.port}` },
    });
    assert.equal(run.status, 500);
    assert.match(JSON.parse(run.body).error, /full-stack workflow requires Node\.js 22\.12\.0\+/);
    assert.equal(calls, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("GUI run accepts a rail prove mode and rejects unknown modes", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-action-stack-gui-prove-"));
  const seen = [];
  const server = createGuiServer({
    outputRoot,
    runDemoFn: async (args, options) => {
      seen.push(args);
      return {
        exitCode: 0,
        report: { run_id: "gui-prove-run", stages: { prove: { status: "passed" } } },
        manifest: { run_id: "gui-prove-run" },
      };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const rail = await requestServer(server, "/api/run?response=pass&fault=duplicate&prove=rail", {
      method: "POST",
      headers: { origin },
    });
    assert.equal(rail.status, 200);
    assert.deepEqual(seen[0].slice(-2), ["--prove", "rail"]);
    const bogus = await requestServer(server, "/api/run?response=pass&fault=none&prove=canned", {
      method: "POST",
      headers: { origin },
    });
    assert.equal(bogus.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("GUI page exposes a prove-mode selector defaulting to simulation", () => {
  const page = renderPage();
  assert.match(page, /<select id="prove">/);
  assert.match(page, /<option value="simulate">simulation<\/option>/);
  assert.match(page, /<option value="rail">same-case rail review<\/option>/);
  assert.match(page, /id="summary"/);
  assert.match(page, /id="bindings"/);
});

test("summary model narrates status, gating reasons, and review results", () => {
  const refused = summaryModel({
    flow: "decide -> stop (policy failed)",
    stages: {
      decide: { status: "failed", passed: false, error: "blocked" },
      act: { status: "skipped", reason: "policy_failed" },
      prove: { status: "skipped", reason: "policy_failed" },
    },
  });
  assert.match(refused, /decide: failed/);
  assert.match(refused, /act: skipped \(policy refused\)/);
  assert.match(refused, /error: blocked/);

  const settled = summaryModel({
    flow: "decide -> act",
    stages: {
      decide: { status: "passed", passed: true, policy_id: "p" },
      act: { status: "passed", outcome: "settled", state: "CLOSED", fault: "none", action_id: "act_1" },
      prove: { status: "skipped", reason: "no_dispute" },
    },
  });
  assert.match(settled, /act: passed — outcome settled, state CLOSED, fault none, action act_1/);
  assert.match(settled, /prove: skipped \(settled and no dispute requested\)/);

  const rail = summaryModel({
    flow: "decide -> act -> prove",
    stages: {
      decide: { status: "passed", passed: true },
      act: { status: "passed", outcome: "compensated", state: "CLOSED", fault: "duplicate", action_id: "act_9" },
      prove: { status: "passed", mode: "rail-review", triggered_by: "act_outcome=compensated", ok: true, review_verdict: "recorded", review_id: "review-abc" },
    },
  });
  assert.match(rail, /mode rail-review/);
  assert.match(rail, /review recorded/);
  assert.match(rail, /review review-abc/);
});

test("summary model escapes untrusted values", () => {
  const html = summaryModel({
    flow: "decide -> act",
    stages: {
      decide: { status: "passed", passed: true },
      act: { status: "passed", outcome: "settled", action_id: "<script>alert(1)</script>" },
      prove: { status: "skipped", reason: "no_dispute" },
    },
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("bindings model shows identity, recomputed digest, provenance, and limits", async () => {
  const railBundle = { action: { action_id: "act_bind_1" }, settlement_receipt: { outcome: "compensated" } };
  const bytes = Buffer.from(JSON.stringify(railBundle), "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const bundle = {
    report: {
      run_id: "run-bind-1",
      component_provenance: [
        { name: "consequence-rail", commit: "abc123", detached: true, clean: true },
      ],
      stages: { prove: { status: "passed", mode: "rail-review" } },
    },
    stages: {
      act: { action_id: "act_bind_1", rail_bundle: railBundle },
      prove: {
        result: {
          verdict: "recorded",
          reviewId: "review-bind-1",
          evidenceDigest: digest,
          legalEffect: "not-determined",
          upstream: { valid: true, verifier: "consequence-rail:bundle-verify", outcome: "compensated", trustedKeyIds: ["k"] },
        },
      },
    },
  };
  const html = await bindingsModel(bundle);
  assert.match(html, /Bindings for run run-bind-1/);
  assert.match(html, /action: act_bind_1/);
  assert.match(html, new RegExp(`evidence digest: ${digest} — recomputed match`));
  assert.match(html, /consequence-rail abc123 \(detached clean\)/);
  assert.match(html, /review verdict: recorded/);
  assert.match(html, /binding only, not signature verification/);
  assert.match(html, /source truth: unknown; legal effect: not determined/);
  assert.match(html, /proves the handoff, not the rail's claims/);
});

test("bindings model marks simulation mode and missing bundles honestly", async () => {
  const simulated = await bindingsModel({
    report: { run_id: "run-sim-1", component_provenance: [], stages: { prove: { status: "passed", mode: "simulate" } } },
    stages: { act: { action_id: "act_sim_1" } },
  });
  assert.match(simulated, /canned operator scenario, unrelated to this action/);

  const missing = await bindingsModel({
    report: { run_id: "run-missing-1", component_provenance: [] },
    stages: { act: { action_id: "act_missing_1" } },
  });
  assert.match(missing, /rail bundle: not persisted for this run/);
});

test("bindings model escapes untrusted bundle values", async () => {
  const html = await bindingsModel({
    report: { run_id: 'run-"quoted"', component_provenance: [{ name: "<b>rail</b>", commit: "c", detached: true, clean: true }] },
    stages: { act: { action_id: "<img src=x>" } },
  });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.doesNotMatch(html, /<b>rail<\/b>/);
  assert.match(html, /run-&quot;quoted&quot;/);
});

function pageScript() {
  const page = renderPage();
  const match = page.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "page has no inline script");
  return match[1];
}

function stubDocument() {
  const elements = {};
  for (const id of ["response", "fault", "dispute", "prove", "run", "download", "output", "summary", "bindings"]) {
    elements[id] = { value: "pass", checked: false, disabled: false, textContent: "", innerHTML: "", href: null, style: {}, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      removeAttribute(name) { delete this[name]; } };
  }
  elements.response.value = "pass";
  elements.fault.value = "duplicate";
  elements.prove.value = "rail";
  return {
    elements,
    getElementById: (id) => elements[id],
  };
}

test("page script ties every result and export to the latest run id", async () => {
  const script = pageScript();
  const run = new Function("document", "fetch", "crypto", `${script}; return { click: () => document.getElementById('run').listeners.click() };`);
  const document = stubDocument();
  let calls = 0;
  const pending = [];
  const fetch = (url) => {
    if (url.startsWith("/api/run")) {
      calls += 1;
      const id = calls === 1 ? "run-first" : "run-second";
      return new Promise((resolve) => pending.push(() => resolve({ json: async () => ({ run_id: id, report: { flow: id, stages: {} } }) })));
    }
    return Promise.resolve({ json: async () => ({ report: { run_id: "late-bundle", stages: {} }, manifest: {}, stages: {} }) });
  };
  const ui = run(document, fetch, globalThis.crypto);
  const first = ui.click();
  assert.equal(document.elements.run.disabled, true);
  assert.equal(document.elements.download.href, undefined);
  const second = ui.click();
  assert.equal(document.elements.run.disabled, true);
  pending[1]();
  await second;
  assert.match(document.elements.summary.innerHTML, /flow: run-second/);
  assert.equal(document.elements.download.href, "/api/bundle/run-second");
  assert.equal(document.elements.run.disabled, false);
  pending[0]();
  await first;
  assert.match(document.elements.summary.innerHTML, /flow: run-second/);
  assert.equal(document.elements.download.href, "/api/bundle/run-second");
});

test("page script surfaces request failures without stale exports", async () => {
  const script = pageScript();
  const run = new Function("document", "fetch", "crypto", `${script}; return { click: () => document.getElementById('run').listeners.click() };`);
  const document = stubDocument();
  const fetch = () => Promise.reject(new Error("boom"));
  const ui = run(document, fetch, globalThis.crypto);
  await ui.click();
  assert.match(document.elements.output.textContent, /Request failed: boom/);
  assert.equal(document.elements.download.href, undefined);
  assert.equal(document.elements.run.disabled, false);
});

test("GUI rail run and CLI agree on the same review binding", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-action-stack-gui-agree-"));
  const railBundle = { action: { action_id: "act_agree_1" }, settlement_receipt: { outcome: "compensated" } };
  const bytes = Buffer.from(JSON.stringify(railBundle), "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const review = { verdict: "recorded", reviewId: "review-agree-1", actionId: "act_agree_1", evidenceDigest: digest, legalEffect: "not-determined", upstream: { valid: true, verifier: "consequence-rail:bundle-verify", outcome: "compensated", trustedKeyIds: ["k"] } };
  const runOptions = {
    componentResolver: () => [],
    runDecideFn: async () => ({ ok: true, raw: { passed: true }, status: 0 }),
    runActFn: async () => ({ ok: true, raw: { outcome: "compensated", state: "CLOSED", fault: "duplicate", action_id: "act_agree_1", rail_bundle: railBundle }, status: 0 }),
    runProveRailFn: async () => ({ ok: true, raw: { ok: true, result: review }, status: 0 }),
  };
  const direct = await runDemo(["--fault", "duplicate", "--prove", "rail"], { ...runOptions, runId: "cli-agree-run", paths: { outputRoot } });
  const server = createGuiServer({ outputRoot, runDemoFn: (args, options) => runDemo(args, { ...options, ...runOptions, runId: "gui-agree-run" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const posted = await requestServer(server, "/api/run?response=pass&fault=duplicate&prove=rail", {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${address.port}` },
    });
    assert.equal(posted.status, 200);
    const body = JSON.parse(posted.body);
    assert.deepEqual({ ...body.report, run_id: "run" }, { ...direct.report, run_id: "run" });
    const bundleRes = await requestServer(server, `/api/bundle/${body.run_id}`);
    assert.equal(bundleRes.status, 200);
    const rendered = await bindingsModel(JSON.parse(bundleRes.body));
    assert.match(rendered, new RegExp(`evidence digest: ${digest} — recomputed match`));
    assert.match(rendered, /review-agree-1/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
