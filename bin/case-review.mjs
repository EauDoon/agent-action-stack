import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PATHS, UsageError, exportRunBundle, isValidRunId, summarizeRun } from "./aas.mjs";

export function listCasePage({ outputRoot = DEFAULT_PATHS.outputRoot, before = null, limit = 25 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("History limit must be an integer from 1 to 50.");
  if (before !== null && (!isValidRunId(before) || before.length > 200)) throw new Error("Invalid history cursor.");
  let entries;
  try { entries = readdirSync(join(outputRoot, "runs"), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { cases: [], next_cursor: null, scanned: 0, unavailable: [] }; throw error; }
  const ids = entries.filter((entry) => entry.isDirectory() && isValidRunId(entry.name) && (!before || entry.name < before))
    .map((entry) => entry.name).sort().reverse();
  const candidates = ids.slice(0, limit);
  const cases = [], unavailable = [];
  for (const runId of candidates) {
    try { cases.push(summarizeRun(runId, { outputRoot })); }
    catch { unavailable.push(runId); }
  }
  return { cases, next_cursor: ids.length > limit ? candidates.at(-1) : null, scanned: candidates.length, unavailable };
}

export function parseCasePageArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--json") continue;
    if (!["--before", "--limit"].includes(key) || i + 1 >= args.length || Object.hasOwn(result, key.slice(2))) throw new Error("Usage: aas cases [--before run-id] [--limit 1..50] [--json]");
    const value = args[++i];
    if (key === "--limit" && !/^[1-9][0-9]?$/.test(value)) throw new Error("Invalid history limit.");
    result[key.slice(2)] = key === "--limit" ? Number(value) : value;
  }
  return result;
}

export function inspectCase(runId, options = {}) {
  const bundle = exportRunBundle(runId, options);
  const report = bundle.report;
  const review = bundle.stages.prove?.result;
  const rail = bundle.stages.act?.rail_bundle;
  const computed = rail && typeof rail === 'object' ? 'sha256:' + createHash('sha256').update(JSON.stringify(rail)).digest('hex') : null;
  return {
    schema_version: 'agent-action-stack.case-review/v1', run_id: runId,
    created_at: bundle.manifest.created_at ?? null, domain: report.domain ?? null,
    requested_options: report.requested_options ?? null,
    stages: ['decide','act','prove'].map(name => ({ name, status: bundle.manifest.stages[name]?.status ?? 'unknown', reason: bundle.manifest.stages[name]?.reason ?? null, code: bundle.manifest.stages[name]?.code ?? null, artifact_available: Object.hasOwn(bundle.stages,name) })),
    policy_id: report.stages?.decide?.policy_id ?? null,
    action_id: bundle.stages.act?.action_id ?? null, outcome: report.stages?.act?.outcome ?? null,
    review_verdict: review?.verdict ?? null,
    recorded_evidence_digest: review?.evidenceDigest ?? null, recomputed_evidence_digest: computed,
    digest_matches: computed && typeof review?.evidenceDigest === 'string' ? computed === review.evidenceDigest : null,
    component_provenance: (Array.isArray(report.component_provenance)?report.component_provenance:[]).map(entry=>({name:entry.name??null,commit:entry.commit??null})),
    limits: ['Receipt verification was not performed by this report.', 'A matching digest binds bytes only; it does not prove source truth.', 'Synthetic demo keys only; legal effect is not determined.'],
  };
}

export function markdownText(value) {
  const punctuation = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '.', '!', '|', '-']);
  return [...String(value ?? 'unavailable')].map(character => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '\r' || character === '\n') return ' ';
    return punctuation.has(character) ? '\\' + character : character;
  }).join('');
}

export function renderCaseMarkdown(review) {
  const lines = ['# Saved case review', '', 'Read-only summary of persisted synthetic evidence. This export performs no receipt verification.', '',
    '- Run ID: '+markdownText(review.run_id), '- Created: '+markdownText(review.created_at), '- Domain: '+markdownText(review.domain),
    '- Policy: '+markdownText(review.policy_id), '- Action: '+markdownText(review.action_id), '- Outcome: '+markdownText(review.outcome),
    '- Recorded review verdict: '+markdownText(review.review_verdict), '', '## Stage record', ''];
  for(const stage of review.stages??[]) lines.push('- '+markdownText(stage.name)+': '+markdownText(stage.status)+'; artifact '+(stage.artifact_available?'present':'absent')+'; reason '+markdownText(stage.reason)+'; code '+markdownText(stage.code));
  lines.push('', '## Evidence binding', '', '- Recorded digest: '+markdownText(review.recorded_evidence_digest), '- Recomputed digest: '+markdownText(review.recomputed_evidence_digest), '- Digests match: '+markdownText(review.digest_matches), '', '## Component revisions', '');
  for(const entry of review.component_provenance??[]) lines.push('- '+markdownText(entry.name)+': '+markdownText(entry.commit));
  lines.push('', '## Limits', '');
  for(const limit of review.limits??[]) lines.push('- '+markdownText(limit));
  return lines.join('\n')+'\n';
}

export function parseInspectArgs(args) {
  let runId=null, outputRoot=DEFAULT_PATHS.outputRoot, format=null, seenRoot=false;
  for(let index=0;index<args.length;index++) {
    const token=args[index];
    if(token==='--root') {
      if(seenRoot || !args[index+1] || args[index+1].startsWith('--')) throw new UsageError('inspect requires one output root path.');
      seenRoot=true;outputRoot=args[++index];
    } else if(token==='--json'||token==='--markdown') {
      if(format!==null) throw new UsageError('Choose one inspect output format.');
      format=token.slice(2);
    } else if(token.startsWith('-') || runId!==null || !isValidRunId(token) || token.length>200) {
      throw new UsageError('Usage: aas inspect <run-id> [--root output-dir] [--json|--markdown]');
    } else runId=token;
  }
  if(runId===null) throw new UsageError('inspect requires a saved run ID.');
  return {runId,outputRoot,format:format??'markdown'};
}
