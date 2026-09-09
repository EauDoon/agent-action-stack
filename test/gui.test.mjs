import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filterHistory, bindingsModel, compareModel, createGuiServer, historyModel, renderPage, replayHttpStatus, replayResultModel, summaryModel } from "../bin/aas-gui.mjs";
import { exportRunBundle, runDemo, selectPython } from "../bin/aas.mjs";

const provenance = [
  { name: "constitutional-agent-testbench", repository: "https://github.com/EauDoon/constitutional-agent-testbench.git", commit: "a7a51907eaaab68a52b66edef28b3ee0fcb3ff97", detached: true, clean: true, entrypoints: [] },
  { name: "consequence-rail", repository: "https://github.com/EauDoon/consequence-rail.git", commit: "d1bacc66618591231270902b657ffaa752954ee6", detached: true, clean: true, entrypoints: [] },
  { name: "mandatebound", repository: "https://github.com/EauDoon/mandatebound.git", commit: "468fce7e0d4dcc1e86bad07a469b3d9217914bb0", detached: true, clean: true, entrypoints: [] },
];

function requestServer(server, path, { method = "GET", headers = {}, body = null } = {}) {
  const address = server.address();
  let settled = false;
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        settled = true;
        resolve({ status: response.statusCode, headers: response.headers, body: text });
      });
    });
    // A bounded server destroys an oversized upload while the client is
    // still writing; that write error must not mask the response.
    req.on("error", (error) => { if (!settled) reject(error); });
    if (body === null) req.end();
    else req.end(body);
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
  for (const id of ["response", "fault", "dispute", "prove", "run", "download", "output", "summary", "bindings", "case-file", "replay", "import-status", "import-result", "load-history", "left-case", "right-case", "compare", "compare-status", "compare-result", "history-list", "domain", "history-search", "history-outcome", "history-count"]) {
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
    return Promise.resolve({ json: async () => ({ report: { run_id: url.split("/").at(-1), stages: {} }, manifest: { run_id: url.split("/").at(-1) }, stages: {} }) });
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

test("CLI export and GUI bundle download agree on the same run", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "agent-action-stack-export-agree-"));
  const server = createGuiServer({
    outputRoot,
    runDemoFn: (args, options) => runDemo(args, {
      ...options,
      runId: "agree-run",
      componentResolver: () => [],
      runDecideFn: async () => ({ ok: true, raw: { passed: true }, status: 0 }),
      runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED" }, status: 0 }),
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const posted = await requestServer(server, "/api/run?response=pass&fault=none", {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${address.port}` },
    });
    assert.equal(posted.status, 200);
    const downloaded = await requestServer(server, "/api/bundle/agree-run");
    assert.equal(downloaded.status, 200);
    assert.deepEqual(exportRunBundle("agree-run", { outputRoot }), JSON.parse(downloaded.body));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function replayPost(server, body, headers = { "content-type": "application/json" }) {
  return requestServer(server, "/api/replay", {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${server.address().port}`, ...headers },
    body,
  });
}

test("GUI replay never invokes execution or remediation", async () => {
  const seen = [];
  const railBundle = { action: { action_id: "act_noexec" }, settlement_receipt: { outcome: "compensated" } };
  const bytes = Buffer.from(JSON.stringify(railBundle), "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const review = { verdict: "recorded", reviewId: "r", actionId: "act_noexec", evidenceDigest: digest, legalEffect: "not-determined", receipt: { outcome: "compensated" }, upstream: { valid: true, verifier: "consequence-rail:bundle-verify", outcome: "compensated", trustedKeyIds: ["k"] }, reviewDigest: "sha256:x" };
  const doc = { report: { run_id: "noexec-run" }, stages: { act: { action_id: "act_noexec", rail_bundle: railBundle }, prove: { result: review } } };
  const server = createGuiServer({
    replayRunner: (bin, args) => {
      seen.push(args.join(" "));
      if (args.includes("bundle")) {
        return { status: 0, stdout: `${JSON.stringify({ valid: true, action_id: "act_noexec", outcome: "compensated", trusted_key_id: "k", trusted_connector_key_id: "c" })}\n`, stderr: "", error: null };
      }
      return { status: 0, stdout: `${JSON.stringify({ ok: true, result: { ...review } })}\n`, stderr: "", error: null };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const posted = await replayPost(server, JSON.stringify(doc));
    assert.equal(posted.status, 200);
    assert.ok(seen.length >= 2);
    assert.equal(seen.length, 2, `expected exactly two verification commands, saw ${JSON.stringify(seen)}`);
    assert.match(seen[0], /bundle verify/);
    assert.match(seen[1], /review --input/);
    for (const command of seen) {
      assert.doesNotMatch(command, /\bdemo\b/, `replay invoked a demo: ${command}`);
      assert.doesNotMatch(command, /execute|remediate/, `replay invoked execution: ${command}`);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("GUI replay reports conflicting, unavailable, malformed, and oversized imports", async () => {
  const server = createGuiServer({
    replayRunner: () => ({ status: 0, stdout: '{"valid":true,"action_id":"a","outcome":"o","trusted_key_id":"k","trusted_connector_key_id":"c"}\n', stderr: "", error: null }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const tampered = {
      report: { run_id: "tampered" },
      stages: {
        act: { action_id: "a", rail_bundle: { action: { action_id: "a" }, settlement_receipt: { outcome: "settled" } } },
        prove: { result: { verdict: "recorded", actionId: "a", evidenceDigest: "sha256:stale", legalEffect: "not-determined", upstream: {} } },
      },
    };
    const conflicting = await replayPost(server, JSON.stringify(tampered));
    assert.equal(conflicting.status, 409);
    assert.match(JSON.parse(conflicting.body).reason, /conflicting/);

    const unavailable = await replayPost(server, JSON.stringify({ report: { run_id: "sim" }, stages: { act: {}, prove: {} } }));
    assert.equal(unavailable.status, 422);
    assert.match(JSON.parse(unavailable.body).reason, /unavailable/);

    const malformed = await replayPost(server, "{not json");
    assert.equal(malformed.status, 400);
    const notObject = await replayPost(server, "[]");
    assert.equal(notObject.status, 400);
    const empty = await replayPost(server, "   ");
    assert.equal(empty.status, 400);
    const wrongType = await replayPost(server, JSON.stringify({ report: {} }), { "content-type": "text/plain" });
    assert.equal(wrongType.status, 400);
    const oversized = await replayPost(server, JSON.stringify({ pad: "x".repeat(1024 * 1024 + 1024) }));
    assert.equal(oversized.status, 413);
    const repeated = await replayPost(server, JSON.stringify({ report: { run_id: "sim" }, stages: {} }));
    assert.equal(repeated.status, 422);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("replay status mapping and result rendering stay stable", () => {
  assert.equal(replayHttpStatus({ ok: true }), 200);
  assert.match(replayResultModel({ ok: true, run_id: "r", checks: [{ name: "digest-binding", passed: true, detail: "ok" }] }), /replay verified under synthetic demo keys/);
  assert.equal(replayHttpStatus({ ok: false, reason: "conflicting: digest" }), 409);
  assert.equal(replayHttpStatus({ ok: false, reason: "unavailable: no bundle" }), 422);
  assert.equal(replayHttpStatus({ ok: false, reason: "unsupported: rail failed" }), 422);

  const html = replayResultModel({
    ok: false,
    run_id: "<b>run</b>",
    reason: "conflicting: <script>x</script>",
    checks: [{ name: "digest-binding", passed: false, detail: "mismatch <x>" }, { name: "identity-binding", passed: true, detail: "bound" }],
  });
  assert.doesNotMatch(html, /<script>x/);
  assert.doesNotMatch(html, /<b>run<\/b>/);
  assert.match(html, /Imported case &lt;b&gt;run&lt;\/b&gt; — not verified/);
  assert.match(html, /proves no provenance and no link to a local run/);
  assert.match(html, /digest-binding: FAIL/);
  assert.match(html, /identity-binding: pass/);
  assert.match(html, /no action execution or remediation runs/);
  assert.match(html, /source truth unknown, legal effect not determined/);
});

test("history and comparison models escape untrusted values and state limits", () => {
  assert.match(historyModel([]), /No cases yet/);
  const listed = historyModel([
    { run_id: "<b>run</b>", outcome: "settled", policy_id: "p", review_verdict: "recorded" },
  ]);
  assert.doesNotMatch(listed, /<b>run<\/b>/);
  assert.match(listed, /&lt;b&gt;run&lt;\/b&gt;/);

  const html = compareModel({
    classification: "different",
    left: { run_id: "<img src=x>" },
    right: { run_id: "ok" },
    errors: ["left (<b>): missing"],
    differences: [{ field: "outcome", left: "<script>", right: "settled" }],
  });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /Comparison: different/);
  assert.match(html, /differences do not establish causation/);
  assert.match(html, /matching metadata does not prove matching evidence/);

  const empty = compareModel({ classification: "identical", left: { run_id: "a" }, right: { run_id: "b" } });
  assert.match(empty, /No compared field differs/);
});


function writeCase(outputRoot, runId, { stageStatus = { decide: "passed", act: "passed", prove: "passed" }, report, prove } = {}) {
  const dir = join(outputRoot, "runs", runId);
  mkdirSync(join(dir, "stages"), { recursive: true });
  const stages = {};
  for (const name of ["decide", "act", "prove"]) {
    stages[name] = { status: stageStatus[name] ?? "skipped", reason: null, code: null, stderr: null, artifact: `stages/${name}.json` };
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schema_version: "agent-action-stack.run/v1",
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
  writeFileSync(join(dir, "stages", "prove.json"), JSON.stringify(prove ?? {
    ok: true,
    result: { verdict: "recorded", reviewId: `review_${runId}`, actionId: `act_${runId}`, evidenceDigest: "sha256:abc", legalEffect: "not-determined" },
  }));
  return dir;
}

test("GUI history and compare endpoints serve summaries and classifications", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "aas-gui-history-"));
  writeCase(outputRoot, "2026-09-06T050000000Z-one");
  writeCase(outputRoot, "2026-09-06T050000001Z-two", {
    report: {
      run_id: "2026-09-06T050000001Z-two",
      flow: "decide -> act",
      component_provenance: [{ name: "consequence-rail", commit: "def" }],
      stages: {
        decide: { status: "passed", policy_id: "p1" },
        act: { status: "passed", outcome: "settled", state: "CLOSED", fault: "none", action_id: "act_two" },
        prove: { status: "skipped", mode: null },
      },
    },
    prove: {},
  });

  const server = createGuiServer({ outputRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const history = await requestServer(server, "/api/history");
    assert.equal(history.status, 200);
    const cases = JSON.parse(history.body).cases;
    assert.deepEqual(cases.map((entry) => entry.run_id), ["2026-09-06T050000001Z-two", "2026-09-06T050000000Z-one"]);
    assert.equal(cases[0].review_verdict, null);
    assert.equal(cases[1].review_verdict, "recorded");

    const compared = await requestServer(server, "/api/compare?a=2026-09-06T050000000Z-one&b=2026-09-06T050000001Z-two");
    assert.equal(compared.status, 200);
    const result = JSON.parse(compared.body);
    assert.equal(result.classification, "different");
    assert.ok(result.differences.some((entry) => entry.field === "evidence_digest"));

    const same = await requestServer(server, "/api/compare?a=2026-09-06T050000000Z-one&b=2026-09-06T050000000Z-one");
    assert.equal(JSON.parse(same.body).classification, "identical");

    for (const query of ["", "?a=2026-09-06T050000000Z-one", "?a=../escape&b=x", "?a=x&b=y/z", "?a=..&b=x", "?a=.&b=x", "?a=...&b=x"]) {
      const rejected = await requestServer(server, `/api/compare${query}`);
      assert.equal(rejected.status, 400, `expected 400 for ${query}`);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("GUI exposes a domain selector defaulting to refund", () => {
  const page = renderPage();
  assert.match(page, /<select id="domain">/);
  assert.match(page, /<option value="refund">refund<\/option>/);
  assert.match(page, /<option value="inventory">inventory allocation<\/option>/);
  const script = pageScript();
  assert.match(script, /domain:document\.getElementById\('domain'\)\.value/);
});

test("GUI run accepts a domain and rejects an unknown one", async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "aas-gui-domain-"));
  const seen = [];
  const server = createGuiServer({
    outputRoot,
    runDemoFn: async (args, options) => {
      seen.push(args);
      return runDemo(args, { ...options, runId: "domain-run", componentResolver: () => [], runDecideFn: async () => ({ ok: true, raw: { passed: true }, status: 0 }), runActFn: async () => ({ ok: true, raw: { outcome: "settled", state: "CLOSED" }, status: 0 }) });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const posted = await requestServer(server, "/api/run?response=pass&fault=none&domain=inventory", {
      method: "POST",
      headers: { origin },
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(seen[0].slice(-2), ["--domain", "inventory"]);
    assert.equal(JSON.parse(posted.body).report.domain, "inventory");
    const bogus = await requestServer(server, "/api/run?response=pass&fault=none&domain=payments", {
      method: "POST",
      headers: { origin },
    });
    assert.equal(bogus.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("GUI rejects duplicate and unknown options before invoking a run", async () => {
  let calls = 0;
  const server = createGuiServer({ runDemoFn: () => { calls++; throw new Error("must not run"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const query of ["domain=refund&domain=inventory", "response=pass&response=fail", "fault=none&fault=none", "dispute=1&dispute=1", "prove=rail&prove=simulate", "account=live"]) {
      const res = await requestServer(server, "/api/run?" + query, { method: "POST", headers: { origin: "http://127.0.0.1:" + server.address().port } });
      assert.equal(res.status, 400, query);
    }
    assert.equal(calls, 0);
    const compare = await requestServer(server, "/api/compare?a=x&a=y&b=z");
    assert.equal(compare.status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("GUI bounds concurrent synthetic work and releases the lease after failure", async () => {
  let release, started;
  const entered = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const server = createGuiServer({ runOptions: { python: "synthetic" }, runDemoFn: async () => { started(); await pending; throw new Error("fixture failure"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const headers = { origin: "http://127.0.0.1:" + server.address().port };
  try {
    const first = requestServer(server, "/api/run", { method: "POST", headers });
    await entered;
    assert.equal((await requestServer(server, "/api/health")).status, 200);
    for (const path of ["/api/run", "/api/replay"]) {
      const blocked = await requestServer(server, path, { method: "POST", headers });
      assert.equal(blocked.status, 503);
      assert.equal(blocked.headers["retry-after"], "1");
    }
    release();
    assert.equal((await first).status, 500);
    assert.equal((await requestServer(server, "/api/run?domain=bad", { method: "POST", headers })).status, 400);
  } finally { release(); await new Promise((resolve) => server.close(resolve)); }
});

test("page reports actionable API failures and refuses mismatched bundle exports", async () => {
  const run = new Function("document", "fetch", "crypto", pageScript() + "; return () => document.getElementById('run').listeners.click();");
  for (const mismatch of [false, true]) {
    const document = stubDocument();
    const fetch = async (url) => ({ json: async () => url.startsWith("/api/run") ? (mismatch ? { run_id: "selected", report: {} } : { error: "Another run is active" }) : { report: { run_id: "wrong" }, manifest: { run_id: "wrong" }, stages: {} } });
    await run(document, fetch, globalThis.crypto)();
    assert.equal(document.elements.download.href, undefined);
    assert.equal(document.elements.run.disabled, false);
    assert.match(mismatch ? document.elements.bindings.textContent : document.elements.output.textContent, mismatch ? /identity does not match/ : /Another run is active/);
  }
});

test("import file changes release stale requests and reject oversized files before reading", async () => {
  const document = stubDocument();
  let resolveText, reads = 0, calls = 0;
  const run = new Function("document", "fetch", "crypto", pageScript());
  run(document, async () => { calls++; return { json: async () => ({}) }; }, globalThis.crypto);
  document.elements['case-file'].files = [{ size: 10, text: () => new Promise((resolve) => { resolveText = resolve; }) }];
  const pending = document.elements.replay.listeners.click();
  assert.equal(document.elements.replay.disabled, true);
  document.elements['case-file'].listeners.change();
  assert.equal(document.elements.replay.disabled, false);
  resolveText('{}'); await pending;
  assert.equal(calls, 0);
  document.elements['case-file'].files = [{ size: 2 * 1024 * 1024, text: () => { reads++; return '{}'; } }];
  await document.elements.replay.listeners.click();
  assert.equal(reads, 0);
  assert.match(document.elements['import-status'].textContent, /too large/);
  assert.equal(document.elements.replay.disabled, false);
});

test("history refresh does not strand comparisons and selection changes invalidate results", async () => {
  const document = stubDocument(); let complete;
  const fetch = async (url) => url.startsWith('/api/compare') ? new Promise((resolve) => { complete = resolve; }) : { json: async () => ({ cases: [] }) };
  new Function('document', 'fetch', 'crypto', pageScript())(document, fetch, globalThis.crypto);
  const pending = document.elements.compare.listeners.click();
  await document.elements['load-history'].listeners.click();
  complete({ json: async () => ({ classification: 'identical' }) }); await pending;
  assert.equal(document.elements.compare.disabled, false);
  assert.match(document.elements['compare-result'].innerHTML, /identical/);
  document.elements['left-case'].listeners.change();
  assert.equal(document.elements['compare-result'].innerHTML, '');
});

test("history search matches case metadata without broadening outcome filters", () => {
  const cases = [{run_id: 'A', policy_id: 'Inventory-Gate', domain: 'inventory', outcome: 'settled'}, {run_id: 'B', review_verdict: 'recorded', outcome: 'compensated'}];
  assert.deepEqual(filterHistory(cases, ' INVENTORY ', 'settled'), [cases[0]]);
  assert.deepEqual(filterHistory(cases, 'inventory', 'compensated'), []);
  assert.deepEqual(filterHistory(cases, 'recorded'), [cases[1]]);
  assert.deepEqual(filterHistory(cases), cases);
});
