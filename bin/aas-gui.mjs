#!/usr/bin/env node
/** Lightweight local GUI for the Agent Action Stack orchestrator. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_GUI_PORT, DEFAULT_PATHS, resolveGuiPort, runDemo, selectPython } from "./aas.mjs";
import { assertFullStackNodeVersion } from "../scripts/bootstrap.mjs";

export function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stageHeadline(name, stage) {
  const reasons = {
    policy_failed: "policy refused",
    decide_error: "decide errored",
    no_dispute: "settled and no dispute requested",
    not_reached: "not reached",
    act_error: "act errored",
  };
  if (!stage || typeof stage !== "object") return `${name}: unknown`;
  if (stage.status === "skipped") {
    const reason = typeof stage.reason === "string" && stage.reason !== ""
      ? (reasons[stage.reason] ?? stage.reason)
      : "skipped";
    return `${name}: skipped (${reason})`;
  }
  return `${name}: ${stage.status ?? "unknown"}`;
}

/**
 * Readable decide/act/prove summary. Pure and browser-safe: every
 * interpolated value is escaped, so the same function renders the page and
 * backs the unit tests.
 */
export function summaryModel(report) {
  const stages = report?.stages && typeof report.stages === "object" ? report.stages : {};
  const rows = ["decide", "act", "prove"].map((name) => {
    const stage = stages[name];
    const facts = [];
    if (name === "decide" && stage?.policy_id) facts.push(`policy ${stage.policy_id}`);
    if (name === "decide" && stage?.error) facts.push(`error: ${stage.error}`);
    if (name === "act" && stage?.outcome) facts.push(`outcome ${stage.outcome}`);
    if (name === "act" && stage?.state) facts.push(`state ${stage.state}`);
    if (name === "act" && stage?.fault) facts.push(`fault ${stage.fault}`);
    if (name === "act" && stage?.action_id) facts.push(`action ${stage.action_id}`);
    if (name === "prove" && stage?.mode) facts.push(`mode ${stage.mode}`);
    if (name === "prove" && stage?.scenario) facts.push(`scenario ${stage.scenario}`);
    if (name === "prove" && stage?.triggered_by) facts.push(`triggered by ${stage.triggered_by}`);
    if (name === "prove" && stage?.review_verdict) facts.push(`review ${stage.review_verdict}`);
    if (name === "prove" && stage?.review_id) facts.push(`review ${stage.review_id}`);
    if (stage?.code) facts.push(`code ${stage.code}`);
    if (stage?.reason && stage?.status !== "skipped") facts.push(`reason: ${stage.reason}`);
    const detail = facts.length > 0 ? ` — ${facts.join(", ")}` : "";
    return `<li>${escapeHtml(stageHeadline(name, stage) + detail)}</li>`;
  });
  const flow = typeof report?.flow === "string" ? report.flow : "unknown";
  return `<p>flow: ${escapeHtml(flow)}</p><ul>${rows.join("")}</ul>`;
}

async function sha256HexText(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Bindings panel: run/action identity, recomputed evidence digest,
 * component provenance, and the review verdict with its limits. Pure apart
 * from the digest computation, and browser-safe.
 */
export async function bindingsModel(bundle) {
  const report = bundle?.report && typeof bundle.report === "object" ? bundle.report : {};
  const stages = bundle?.stages && typeof bundle.stages === "object" ? bundle.stages : {};
  const manifest = bundle?.manifest && typeof bundle.manifest === "object" ? bundle.manifest : {};
  const runId = typeof report.run_id === "string" ? report.run_id : "unknown";
  const act = stages.act && typeof stages.act === "object" ? stages.act : null;
  const actionId = typeof act?.action_id === "string" ? act.action_id : null;
  const railBundle = act && typeof act.rail_bundle === "object" && act.rail_bundle !== null ? act.rail_bundle : null;
  const prove = stages.prove && typeof stages.prove === "object" ? stages.prove : null;
  const review = prove && typeof prove.result === "object" && prove.result !== null ? prove.result : null;
  const provenance = Array.isArray(report.component_provenance) ? report.component_provenance : [];

  let digestRow = "<li>rail bundle: not persisted for this run</li>";
  if (railBundle && actionId) {
    const recomputed = await sha256HexText(JSON.stringify(railBundle));
    const recorded = typeof review?.evidenceDigest === "string" ? review.evidenceDigest : null;
    if (recomputed && recorded) {
      const match = recorded === `sha256:${recomputed}`;
      digestRow = `<li>evidence digest: ${escapeHtml(recorded)} — recomputed ${match ? "match" : "MISMATCH"}</li>`;
    } else if (recomputed) {
      digestRow = `<li>evidence digest: sha256:${recomputed} (recomputed locally, no review record)</li>`;
    }
  }
  const provenanceRows = provenance.map((entry) => {
    const name = typeof entry?.name === "string" ? entry.name : "unknown";
    const commit = typeof entry?.commit === "string" ? entry.commit : "unknown";
    const state = entry?.detached && entry?.clean ? "detached clean" : "check required";
    return `<li>${escapeHtml(name)} ${escapeHtml(commit)} (${escapeHtml(state)})</li>`;
  });
  const reviewRows = [];
  if (review && typeof review.verdict === "string") {
    reviewRows.push(`<li>review verdict: ${escapeHtml(review.verdict)}</li>`);
    if (review.reviewId) reviewRows.push(`<li>review id: ${escapeHtml(review.reviewId)}</li>`);
    if (review.upstream && typeof review.upstream === "object") {
      reviewRows.push(
        `<li>rail verification (rail's own verifier): ${escapeHtml(String(review.upstream.valid))} via ${escapeHtml(review.upstream.verifier ?? "unknown")} — outcome ${escapeHtml(review.upstream.outcome ?? "unknown")}</li>`,
      );
    }
    reviewRows.push("<li>MandateBound recording: binding only, not signature verification</li>");
    reviewRows.push("<li>source truth: unknown; legal effect: not determined</li>");
    reviewRows.push("<li>recorded proves the handoff, not the rail's claims or any recovery</li>");
  } else if (report?.stages?.prove?.status === "passed" && report?.stages?.prove?.mode !== "rail-review") {
    reviewRows.push("<li>simulation mode: canned operator scenario, unrelated to this action</li>");
  }
  return `<h2>Bindings for run ${escapeHtml(runId)}</h2><ul>`
    + `<li>action: ${escapeHtml(actionId ?? "none")}</li>`
    + digestRow
    + provenanceRows.join("")
    + reviewRows.join("")
    + `</ul>`;
}

export function renderPage() {
  const embedded = [escapeHtml, stageHeadline, summaryModel, bindingsModel, sha256HexText]
    .map((fn) => fn.toString()).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Action Stack</title>
<style>body{font:16px system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#17202a}button{padding:10px 14px;margin:4px 0;cursor:pointer}button:disabled{cursor:wait;opacity:.6}select{padding:9px;margin:4px}pre{background:#f3f5f7;padding:16px;overflow:auto;border-radius:6px}.state{margin:16px 0}.download{display:none}.panel{margin:16px 0}.error{color:#7a1f1f}</style></head>
<body><h1>Agent Action Stack</h1><p>Run the local decide, act, and prove flow using the reviewed component lock.</p>
<div class="state"><label>Response <select id="response"><option value="pass">pass</option><option value="fail">fail</option></select></label>
<label>Fault <select id="fault"><option value="none">none</option><option value="duplicate">duplicate</option></select></label>
<label><input id="dispute" type="checkbox"> force dispute proof</label>
<label>Prove <select id="prove"><option value="simulate">simulation</option><option value="rail">same-case rail review</option></select></label>
<br><button id="run">Run stack</button>
<a id="download" class="download" download="agent-action-stack-run.json">Download run bundle</a></div>
<div class="panel" id="summary"></div>
<div class="panel" id="bindings"></div>
<pre id="output">Ready.</pre>
<script>
${embedded}
const output=document.getElementById('output');
const summary=document.getElementById('summary');
const bindings=document.getElementById('bindings');
const runButton=document.getElementById('run');
const download=document.getElementById('download');
let latestToken=0;
runButton.addEventListener('click',async()=>{
  const token=++latestToken;
  runButton.disabled=true;
  download.style.display='none';
  download.removeAttribute('href');
  summary.innerHTML='';
  bindings.innerHTML='';
  output.textContent='Running...';
  const query=new URLSearchParams({response:document.getElementById('response').value,fault:document.getElementById('fault').value,prove:document.getElementById('prove').value});
  if(document.getElementById('dispute').checked) query.set('dispute','1');
  let runBody;
  try {
    const response=await fetch('/api/run?'+query,{method:'POST'});
    runBody=await response.json();
  } catch(error) { if(token!==latestToken) return; output.textContent='Request failed: '+error.message; runButton.disabled=false; return; }
  if(token!==latestToken) return;
  if(!runBody || typeof runBody.run_id!=='string') { output.textContent='Request failed.'; runButton.disabled=false; return; }
  const runId=runBody.run_id;
  output.textContent=JSON.stringify(runBody.report ?? runBody,null,2);
  try { summary.innerHTML=summaryModel(runBody.report ?? {}); } catch(error) { summary.innerHTML='<p class="error">Summary unavailable.</p>'; }
  let bundle;
  try {
    const bundleResponse=await fetch('/api/bundle/'+encodeURIComponent(runId));
    bundle=await bundleResponse.json();
  } catch(error) { if(token!==latestToken) return; bindings.innerHTML='<p class="error">Bundle unavailable.</p>'; runButton.disabled=false; return; }
  if(token!==latestToken) return;
  try { bindings.innerHTML=await bindingsModel(bundle); } catch(error) { bindings.innerHTML='<p class="error">Bindings unavailable.</p>'; }
  download.href='/api/bundle/'+encodeURIComponent(runId);
  download.style.display='inline-block';
  runButton.disabled=false;
});
</script></body></html>`;
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function isLoopbackPeer(address) {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function requestBoundaryFailure(request) {
  if (!isLoopbackPeer(request.socket.remoteAddress)) return "peer";
  const port = request.socket.localPort;
  if (!Number.isInteger(port)) return "host";
  const expectedHost = `127.0.0.1:${port}`;
  const hostHeaders = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host");
  if (hostHeaders.length !== 1 || request.headers.host !== expectedHost) return "host";
  const origin = request.headers.origin;
  // Distinguish a missing-Origin POST (caller forgot to identify itself) from
  // a wrong-Origin POST (caller is some other origin). The first is a 400
  // ("you forgot to send Origin"), the second is a 403 ("Origin does not
  // match this server"). Both still return 403 today; the missing-Origin
  // case is the surprising one for programmatic local clients.
  if (request.method === "POST" && origin === undefined) return "missing-origin";
  if (request.method === "POST" && origin !== `http://${expectedHost}`) return "origin";
  if (origin !== undefined && origin !== `http://${expectedHost}`) return "origin";
  return null;
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

function readBundle(outputRoot, runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("Invalid run id.");
  const bundleDir = join(outputRoot, "runs", runId);
  const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
  const report = JSON.parse(readFileSync(safeBundleFile(bundleDir, manifest.report, "report path"), "utf8"));
  const stages = {};
  for (const [name, stage] of Object.entries(manifest.stages)) {
    if (stage.artifact) {
      stages[name] = JSON.parse(readFileSync(safeBundleFile(bundleDir, stage.artifact, "stage artifact path"), "utf8"));
    }
  }
  return { manifest, report, stages };
}

export function createGuiServer({
  runDemoFn = runDemo,
  outputRoot = DEFAULT_PATHS.outputRoot,
  runOptions = {},
} = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      const boundary = requestBoundaryFailure(request);
      if (boundary === "missing-origin") {
        sendJson(response, 400, { error: "Origin header required for POST" });
        return;
      }
      if (boundary !== null) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        });
        response.end(renderPage());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, stack: "agent-action-stack" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/run") {
        const allowedKeys = new Set(["response", "fault", "dispute", "prove"]);
        if ([...url.searchParams.keys()].some((key) => !allowedKeys.has(key))) {
          sendJson(response, 400, { error: "Invalid options" });
          return;
        }
        const selectedResponse = url.searchParams.get("response") ?? "pass";
        const selectedFault = url.searchParams.get("fault") ?? "none";
        const selectedProve = url.searchParams.get("prove") ?? "simulate";
        if (!new Set(["pass", "fail"]).has(selectedResponse)
          || !new Set(["none", "duplicate"]).has(selectedFault)
          || !new Set([null, "1"]).has(url.searchParams.get("dispute"))
          || !new Set(["simulate", "rail"]).has(selectedProve)) {
          sendJson(response, 400, { error: "Invalid options" });
          return;
        }
        const args = ["--response", selectedResponse, "--fault", selectedFault, "--json"];
        if (url.searchParams.get("dispute") === "1") args.push("--dispute");
        if (selectedProve !== "simulate") args.push("--prove", selectedProve);
        try {
          assertFullStackNodeVersion(
            runOptions.nodeVersion === undefined ? {} : { version: runOptions.nodeVersion },
          );
        } catch (error) {
          sendJson(response, 500, { error: error.message });
          return;
        }
        let python = runOptions.python ?? null;
        if (python === null) {
          try {
            python = selectPython();
          } catch (error) {
            sendJson(response, 500, { error: error.message });
            return;
          }
        }
        const result = await runDemoFn(args, {
          ...runOptions,
          ...(python ? { python } : {}),
          paths: { ...(runOptions.paths ?? {}), outputRoot },
        });
        sendJson(response, result.exitCode === 0 ? 200 : 500, {
          run_id: result.report.run_id,
          exit_code: result.exitCode,
          report: result.report,
          manifest: result.manifest,
        });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/bundle/")) {
        const runId = decodeURIComponent(url.pathname.slice("/api/bundle/".length));
        const bundle = readBundle(outputRoot, runId);
        sendJson(response, 200, bundle, {
          "content-disposition": `attachment; filename="agent-action-stack-${runId}.json"`,
        });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch {
      sendJson(response, 500, { error: "Request failed" });
    }
  });
}

export async function startGui({ port = DEFAULT_GUI_PORT, host = "127.0.0.1", ...options } = {}) {
  if (host !== "127.0.0.1") throw new TypeError("GUI host must be 127.0.0.1.");
  const server = createGuiServer(options);
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`Agent Action Stack GUI: http://${host}:${actualPort}\n`);
  return server;
}

async function main() {
  if (process.argv.includes("--smoke-test")) {
    const server = await startGui({ port: 0 });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.stdout.write("GUI smoke test passed.\n");
    return;
  }
  await startGui({ port: resolveGuiPort() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
    process.exitCode = 1;
  });
}
