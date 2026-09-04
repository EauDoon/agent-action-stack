import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGuiServer, renderPage } from "../bin/aas-gui.mjs";
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
