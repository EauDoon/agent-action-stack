#!/usr/bin/env node
/** Lightweight local GUI for the Agent Action Stack orchestrator. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_PATHS, runDemo } from "./aas.mjs";

export function renderPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Action Stack</title>
<style>body{font:16px system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#17202a}button{padding:10px 14px;margin:4px 0;cursor:pointer}select{padding:9px;margin:4px}pre{background:#f3f5f7;padding:16px;overflow:auto;border-radius:6px}.state{margin:16px 0}.download{display:none}</style></head>
<body><h1>Agent Action Stack</h1><p>Run the local decide, act, and prove flow using the reviewed component lock.</p>
<div class="state"><label>Response <select id="response"><option value="pass">pass</option><option value="fail">fail</option></select></label>
<label>Fault <select id="fault"><option value="none">none</option><option value="duplicate">duplicate</option></select></label>
<label><input id="dispute" type="checkbox"> force dispute proof</label><br><button id="run">Run stack</button>
<a id="download" class="download" download="agent-action-stack-run.json">Download run bundle</a></div>
<pre id="output">Ready.</pre>
<script>
const output=document.getElementById('output');
document.getElementById('run').addEventListener('click',async()=>{
  output.textContent='Running...';
  const query=new URLSearchParams({response:document.getElementById('response').value,fault:document.getElementById('fault').value});
  if(document.getElementById('dispute').checked) query.set('dispute','1');
  try { const response=await fetch('/api/run?'+query,{method:'POST'}); const body=await response.json(); output.textContent=JSON.stringify(body,null,2); if(body.run_id){const link=document.getElementById('download');link.href='/api/bundle/'+encodeURIComponent(body.run_id);link.style.display='inline-block';} }
  catch(error){ output.textContent=JSON.stringify({error:error.message},null,2); }
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
      if (requestBoundaryFailure(request) !== null) {
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
        const allowedKeys = new Set(["response", "fault", "dispute"]);
        if ([...url.searchParams.keys()].some((key) => !allowedKeys.has(key))) {
          sendJson(response, 400, { error: "Invalid options" });
          return;
        }
        const selectedResponse = url.searchParams.get("response") ?? "pass";
        const selectedFault = url.searchParams.get("fault") ?? "none";
        if (!new Set(["pass", "fail"]).has(selectedResponse)
          || !new Set(["none", "duplicate"]).has(selectedFault)
          || !new Set([null, "1"]).has(url.searchParams.get("dispute"))) {
          sendJson(response, 400, { error: "Invalid options" });
          return;
        }
        const args = ["--response", selectedResponse, "--fault", selectedFault, "--json"];
        if (url.searchParams.get("dispute") === "1") args.push("--dispute");
        const result = await runDemoFn(args, { ...runOptions, paths: { ...(runOptions.paths ?? {}), outputRoot } });
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

export async function startGui({ port = 8787, host = "127.0.0.1", ...options } = {}) {
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
  await startGui({ port: Number(process.env.AAS_GUI_PORT ?? "8787") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
    process.exitCode = 1;
  });
}
