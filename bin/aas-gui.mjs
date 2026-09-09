#!/usr/bin/env node
/** Lightweight local GUI for the Agent Action Stack orchestrator. */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  CHILD_JSON_LIMIT,
  DEFAULT_GUI_PORT,
  DEFAULT_PATHS,
  compareRuns,
  exportRunBundle,
  isValidRunId,
  listRunSummaries,
  parseJsonOutput,
  replayBundle,
  resolveGuiPort,
  runCapture,
  runDemo,
  selectPython,
} from "./aas.mjs";
import { assertFullStackNodeVersion } from "../scripts/bootstrap.mjs";

/** Bounded, strict JSON request body. The cap is enforced here regardless of any client-side check. */
async function readJsonRequest(request, { maxBytes = CHILD_JSON_LIMIT } = {}) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:;\s*charset=utf-?8)?$/i.test(contentType.trim())) {
    throw Object.assign(new Error("Imported case must be application/json."), { status: 400 });
  }
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  // Drain a rejected upload up to a hard ceiling so the client always
  // receives its error response instead of a dropped connection.
  const ceiling = maxBytes * 2;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBytes) {
      tooLarge = true;
      if (received > ceiling) {
        // Stop reading an abusive upload and let the handler answer before
        // the socket is closed, so the caller still learns why.
        throw Object.assign(new Error("Imported case is too large."), { status: 413, closeAfterResponse: true });
      }
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw Object.assign(new Error("Imported case is too large."), { status: 413 });
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw Object.assign(new Error("Imported case is empty."), { status: 400 });
  return parseJsonOutput(text, "imported case", maxBytes);
}

/**
 * Map a replay result onto a stable HTTP status so clients can distinguish
 * a conflicting case (409), missing or unsupported evidence (422), and a
 * clean verification (200).
 */
export function replayHttpStatus(result) {
  if (result.ok) return 200;
  const reason = typeof result.reason === "string" ? result.reason : "";
  if (reason.startsWith("conflicting")) return 409;
  if (reason.startsWith("unavailable") || reason.startsWith("unsupported")) return 422;
  return 500;
}

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
  return `<p>domain: ${escapeHtml(report?.domain ?? "unknown (older case)")}</p><p>flow: ${escapeHtml(flow)}</p><ul>${rows.join("")}</ul>`;
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

/**
 * Render one imported-case replay result. The imported case identity is
 * always labelled separately from any live run, and every value is
 * escaped. Pure and browser-safe.
 */
export function replayResultModel(result) {
  const body = result && typeof result === "object" ? result : {};
  const runId = typeof body.run_id === "string" ? body.run_id : null;
  const checks = Array.isArray(body.checks) ? body.checks : [];
  const rows = checks.map((check) => `<li>${escapeHtml(check?.name ?? "check")}: ${check?.passed ? "pass" : "FAIL"} — ${escapeHtml(check?.detail ?? "")}</li>`);
  const reason = typeof body.reason === "string" && body.reason !== ""
    ? `<p class="error">${escapeHtml(body.reason)}</p>`
    : "";
  const verdictLabel = body.ok === true
    ? "replay verified under synthetic demo keys"
    : "not verified";
  return `<h3>Imported case ${escapeHtml(runId ?? "(unknown run id)")} — ${verdictLabel}</h3>`
    + `<ul>${rows.join("")}</ul>`
    + reason
    + `<ul><li>verification only: no action execution or remediation runs</li>`
    + `<li>imported identity is untrusted text; this panel proves no provenance and no link to a local run</li>`
    + `<li>synthetic keys, source truth unknown, legal effect not determined</li></ul>`;
}

/**
 * Render a two-case comparison. Every value is escaped and the notes restate
 * the limits: no causation, and matching metadata is not proof of matching
 * evidence. Pure and browser-safe.
 */
export function compareModel(result) {
  const body = result && typeof result === "object" ? result : {};
  const left = body.left?.run_id ?? null;
  const right = body.right?.run_id ?? null;
  const errors = Array.isArray(body.errors) && body.errors.length > 0
    ? `<p class="error">${body.errors.map((entry) => escapeHtml(entry)).join("<br>")}</p>`
    : "";
  const differences = Array.isArray(body.differences) ? body.differences : [];
  const rows = differences.length === 0
    ? "<p>No compared field differs.</p>"
    : `<ul>${differences.map((entry) => `<li>${escapeHtml(entry.field)}: ${escapeHtml(JSON.stringify(entry.left))} vs ${escapeHtml(JSON.stringify(entry.right))}</li>`).join("")}</ul>`;
  const notes = Array.isArray(body.notes) && body.notes.length > 0
    ? body.notes
    : ["differences do not establish causation", "matching metadata does not prove matching evidence"];
  return `<h3>Comparison: ${escapeHtml(body.classification ?? "unknown")}</h3>`
    + `<p>${escapeHtml(left ?? "(left unavailable)")} vs ${escapeHtml(right ?? "(right unavailable)")}</p>`
    + errors
    + rows
    + `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`;
}

function renderCaseOptions(cases) {
  return (Array.isArray(cases) ? cases : [])
    .map((entry) => `<option value="${escapeHtml(entry.run_id)}">${escapeHtml(entry.run_id)} — ${escapeHtml(entry.outcome ?? "none")}</option>`)
    .join("");
}

/**
 * Render the bounded history list. Summary-only: no raw evidence.
 */
export function historyModel(cases) {
  const list = Array.isArray(cases) ? cases : [];
  if (list.length === 0) return "<p>No cases yet.</p>";
  return `<ul>${list.map((entry) => `<li>${escapeHtml(entry.run_id)} — outcome ${escapeHtml(entry.outcome ?? "none")}, policy ${escapeHtml(entry.policy_id ?? "none")}, review ${escapeHtml(entry.review_verdict ?? "none")}</li>`).join("")}</ul>`;
}

export function validateRunBundle(bundle, runId) {
  if (!bundle || bundle.report?.run_id !== runId || bundle.manifest?.run_id !== runId
    || !bundle.stages || typeof bundle.stages !== "object" || Array.isArray(bundle.stages)) {
    throw new Error("Bundle identity does not match the selected run.");
  }
  return bundle;
}

export function renderPage() {
  const embedded = [validateRunBundle, escapeHtml, stageHeadline, summaryModel, bindingsModel, replayResultModel, compareModel, historyModel, renderCaseOptions, sha256HexText]
    .map((fn) => fn.toString()).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Action Stack</title>
<style>body{font:16px system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#17202a}button{padding:10px 14px;margin:4px 0;cursor:pointer}button:disabled{cursor:wait;opacity:.6}select{padding:9px;margin:4px}pre{background:#f3f5f7;padding:16px;overflow:auto;border-radius:6px}.state{margin:16px 0}.download{display:none}.panel{margin:16px 0}.error{color:#7a1f1f}</style></head>
<body><h1>Agent Action Stack</h1><p>Run the local decide, act, and prove flow using the reviewed component lock.</p>
<div class="state"><label>Response <select id="response"><option value="pass">pass</option><option value="fail">fail</option></select></label>
<label>Fault <select id="fault"><option value="none">none</option><option value="duplicate">duplicate</option></select></label>
<label>Domain <select id="domain"><option value="refund">refund</option><option value="inventory">inventory allocation</option></select></label>
<label><input id="dispute" type="checkbox"> force dispute proof</label>
<label>Prove <select id="prove"><option value="simulate">simulation</option><option value="rail">same-case rail review</option></select></label>
<br><button id="run">Run stack</button>
<a id="download" class="download" download="agent-action-stack-run.json">Download run bundle</a></div>
<div class="panel" id="summary"></div>
<div class="panel" id="bindings"></div>
<pre id="output">Ready.</pre>
<div class="panel"><h2>Replay an imported case</h2>
<p>Import an exported case to inspect and re-verify it. Verification only: no action runs and no remedy is attempted. The imported case is reported separately from any live run above.</p>
<input id="case-file" type="file" accept="application/json,.json"> <button id="replay">Replay imported case</button>
<div id="import-status"></div>
<div id="import-result"></div></div>
<div class="panel"><h2>Case history and comparison</h2>
<p>Compare two persisted cases by identity, policy reference, component revisions, outcome, evidence digest, and review result. This view loads summaries only, never raw evidence, and never modifies or deletes a case.</p>
<button id="load-history">Load history</button>
<label>Left <select id="left-case"><option value="">(select a case)</option></select></label>
<label>Right <select id="right-case"><option value="">(select a case)</option></select></label>
<button id="compare">Compare selected cases</button>
<div id="history-list"></div>
<div id="compare-status"></div>
<div id="compare-result"></div></div>
<script>
${embedded}
const output=document.getElementById('output');
const summary=document.getElementById('summary');
const bindings=document.getElementById('bindings');
const runButton=document.getElementById('run');
const download=document.getElementById('download');
const importStatus=document.getElementById('import-status');
const importResult=document.getElementById('import-result');
const caseFile=document.getElementById('case-file');
const replayButton=document.getElementById('replay');
const historyList=document.getElementById('history-list');
const leftCase=document.getElementById('left-case');
const rightCase=document.getElementById('right-case');
const loadHistoryButton=document.getElementById('load-history');
const compareButton=document.getElementById('compare');
const compareStatus=document.getElementById('compare-status');
const compareResult=document.getElementById('compare-result');
let latestToken=0;
let importToken=0;
let compareToken=0;
let historyToken=0;
function clearComparison(){ compareToken++; compareResult.innerHTML=""; compareStatus.textContent=""; compareButton.disabled=false; }
leftCase.addEventListener("change",clearComparison);
rightCase.addEventListener("change",clearComparison);
function clearImported(){ importToken++; importResult.innerHTML=''; importStatus.textContent=''; replayButton.disabled=false; }
caseFile.addEventListener('change',clearImported);
runButton.addEventListener('click',async()=>{
  const token=++latestToken;
  runButton.disabled=true;
  download.style.display='none';
  download.removeAttribute('href');
  summary.innerHTML='';
  bindings.innerHTML='';
  clearImported();
  output.textContent='Running...';
  const query=new URLSearchParams({response:document.getElementById('response').value,fault:document.getElementById('fault').value,prove:document.getElementById('prove').value,domain:document.getElementById('domain').value});
  if(document.getElementById('dispute').checked) query.set('dispute','1');
  let runBody;
  try {
    const response=await fetch('/api/run?'+query,{method:'POST'});
    runBody=await response.json();
  } catch(error) { if(token!==latestToken) return; output.textContent='Request failed: '+error.message; runButton.disabled=false; return; }
  if(token!==latestToken) return;
  if(!runBody || typeof runBody.run_id!=='string') { output.textContent='Request failed: '+(runBody?.error ?? 'No run identity returned.'); runButton.disabled=false; return; }
  const runId=runBody.run_id;
  output.textContent=JSON.stringify(runBody.report ?? runBody,null,2);
  try { summary.innerHTML=summaryModel(runBody.report ?? {}); } catch(error) { summary.innerHTML='<p class="error">Summary unavailable.</p>'; }
  let bundle;
  try {
    const bundleResponse=await fetch('/api/bundle/'+encodeURIComponent(runId));
    bundle=await bundleResponse.json();
    if(bundleResponse.ok===false) throw new Error(bundle?.error ?? 'Bundle request failed.');
    validateRunBundle(bundle,runId);
  } catch(error) { if(token!==latestToken) return; bindings.textContent='Bundle unavailable: '+error.message; runButton.disabled=false; return; }
  if(token!==latestToken) return;
  try { bindings.innerHTML=await bindingsModel(bundle); } catch(error) { bindings.innerHTML='<p class="error">Bindings unavailable.</p>'; }
  if(token!==latestToken) return;
  download.href='/api/bundle/'+encodeURIComponent(runId);
  download.style.display='inline-block';
  runButton.disabled=false;
});
replayButton.addEventListener('click',async()=>{
  const token=++importToken;
  replayButton.disabled=true;
  importResult.innerHTML='';
  const file=caseFile.files&&caseFile.files[0];
  if(!file){ importStatus.textContent='Choose an exported case file first.'; replayButton.disabled=false; return; }
  if(file.size>${CHILD_JSON_LIMIT}) { importStatus.textContent='Imported case is too large (maximum ${CHILD_JSON_LIMIT} bytes).'; replayButton.disabled=false; return; }
  let text;
  try { text=await file.text(); }
  catch(error){ if(token!==importToken) return; importStatus.textContent='Cannot read that file.'; replayButton.disabled=false; return; }
  if(token!==importToken) return;
  importStatus.textContent='Replaying (verification only, no execution)...';
  let body;
  try {
    const response=await fetch('/api/replay',{method:'POST',headers:{'content-type':'application/json'},body:text});
    body=await response.json();
  } catch(error){ if(token!==importToken) return; importStatus.textContent='Replay request failed.'; replayButton.disabled=false; return; }
  if(token!==importToken) return;
  if(body && Array.isArray(body.checks)) { importResult.innerHTML=replayResultModel(body); importStatus.textContent=''; }
  else { importStatus.textContent='Replay rejected: '+(body&&body.error?body.error:'unknown error'); }
  replayButton.disabled=false;
});
async function refreshHistory(token){
  historyList.textContent='Loading history...';
  let body;
  try { const response=await fetch('/api/history'); body=await response.json(); if(response.ok===false || !Array.isArray(body?.cases)) throw new Error(body?.error ?? 'Invalid history response'); }
  catch(error){ if(token!==historyToken) return; historyList.textContent='History unavailable: '+error.message; return; }
  if(token!==historyToken) return;
  const cases=(body&&Array.isArray(body.cases))?body.cases:[];
  historyList.innerHTML=historyModel(cases);
  const options=renderCaseOptions(cases);
  const leftValue=leftCase.value;
  const rightValue=rightCase.value;
  leftCase.innerHTML='<option value="">(select a case)</option>'+options;
  rightCase.innerHTML='<option value="">(select a case)</option>'+options;
  if(cases.some(function(entry){return entry.run_id===leftValue;})) leftCase.value=leftValue;
  if(cases.some(function(entry){return entry.run_id===rightValue;})) rightCase.value=rightValue;
}
loadHistoryButton.addEventListener('click',function(){ refreshHistory(++historyToken); });
compareButton.addEventListener('click',async()=>{
  const token=++compareToken;
  compareButton.disabled=true;
  compareResult.innerHTML='';
  if(!leftCase.value||!rightCase.value){ compareStatus.textContent='Select two cases to compare.'; compareButton.disabled=false; return; }
  compareStatus.textContent='Comparing...';
  let body;
  try {
    const response=await fetch('/api/compare?a='+encodeURIComponent(leftCase.value)+'&b='+encodeURIComponent(rightCase.value));
    body=await response.json();
    if(response.ok===false || !body?.classification) throw new Error(body?.error ?? 'Invalid comparison response');
  } catch(error){ if(token!==compareToken) return; compareStatus.textContent='Comparison failed: '+error.message; compareButton.disabled=false; return; }
  if(token!==compareToken) return;
  compareResult.innerHTML=compareModel(body);
  compareStatus.textContent='';
  compareButton.disabled=false;
});
</script></body></html>`;
}

export function hasOnlySingleOptions(params, allowed) {
  return [...params.keys()].every((key) => allowed.has(key) && params.getAll(key).length === 1);
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

export function createGuiServer({
  runDemoFn = runDemo,
  outputRoot = DEFAULT_PATHS.outputRoot,
  runOptions = {},
  replayRunner,
  depsDir,
} = {}) {
  let activeWork = false;
  return createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    let ownsWork = false;
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
      if (request.method === "POST" && ["/api/run", "/api/replay"].includes(url.pathname)) {
        if (activeWork) {
          sendJson(response, 503, { error: "Another run or replay is already running; wait for it to finish." }, { "retry-after": "1" });
          return;
        }
        activeWork = true;
        ownsWork = true;
        // Keep the lease until the handler finishes, even if the client disconnects.
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
        const allowedKeys = new Set(["response", "fault", "dispute", "prove", "domain"]);
        if (!hasOnlySingleOptions(url.searchParams, allowedKeys)) {
          sendJson(response, 400, { error: "Invalid options" });
          return;
        }
        const selectedResponse = url.searchParams.get("response") ?? "pass";
        const selectedFault = url.searchParams.get("fault") ?? "none";
        const selectedProve = url.searchParams.get("prove") ?? "simulate";
        const selectedDomain = url.searchParams.get("domain") ?? "refund";
        if (!new Set(["pass", "fail"]).has(selectedResponse)
          || !new Set(["none", "duplicate"]).has(selectedFault)
          || !new Set([null, "1"]).has(url.searchParams.get("dispute"))
          || !new Set(["simulate", "rail"]).has(selectedProve)
          || !new Set(["refund", "inventory"]).has(selectedDomain)) {
          sendJson(response, 400, { error: "Invalid options" });
          return;
        }
        const args = ["--response", selectedResponse, "--fault", selectedFault, "--json"];
        if (url.searchParams.get("dispute") === "1") args.push("--dispute");
        if (selectedDomain !== "refund") args.push("--domain", selectedDomain);
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
      if (request.method === "POST" && url.pathname === "/api/replay") {
        try {
          assertFullStackNodeVersion(
            runOptions.nodeVersion === undefined ? {} : { version: runOptions.nodeVersion },
          );
        } catch (error) {
          sendJson(response, 500, { error: error.message });
          return;
        }
        let imported;
        try {
          imported = await readJsonRequest(request);
        } catch (error) {
          sendJson(response, error.status ?? 400, { error: error.message });
          if (error.closeAfterResponse === true) {
            response.once("finish", () => request.destroy());
          }
          return;
        }
        if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
          sendJson(response, 400, { error: "Imported case must be a JSON object." });
          return;
        }
        let result;
        try {
          result = replayBundle(imported, {
            ...(depsDir === undefined ? {} : { depsDir }),
            ...(replayRunner === undefined ? {} : { runner: replayRunner }),
          });
        } catch (error) {
          sendJson(response, 500, { error: error.message });
          return;
        }
        sendJson(response, replayHttpStatus(result), {
          ok: result.ok,
          run_id: result.runId,
          checks: result.checks,
          reason: result.reason ?? null,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/history") {
        sendJson(response, 200, { ok: true, cases: listRunSummaries({ outputRoot }) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/compare") {
        const left = url.searchParams.get("a");
        const right = url.searchParams.get("b");
        const valid = (value) => isValidRunId(value);
        if (!hasOnlySingleOptions(url.searchParams, new Set(["a", "b"])) || !valid(left) || !valid(right)) {
          sendJson(response, 400, { error: "Compare requires two valid run ids." });
          return;
        }
        const comparison = compareRuns(left, right, { outputRoot });
        sendJson(response, 200, { ok: true, ...comparison });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/bundle/")) {
        const runId = decodeURIComponent(url.pathname.slice("/api/bundle/".length));
        const bundle = exportRunBundle(runId, { outputRoot });
        sendJson(response, 200, bundle, {
          "content-disposition": `attachment; filename="agent-action-stack-${runId}.json"`,
        });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch {
      sendJson(response, 500, { error: "Request failed" });
    } finally {
      if (ownsWork) activeWork = false;
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
