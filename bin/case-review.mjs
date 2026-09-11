import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PATHS, UsageError, exportRunBundle, isValidRunId, summarizeRun } from "./aas.mjs";

export function listCasePage({ outputRoot = DEFAULT_PATHS.outputRoot, before = null, limit = 25, domain = null, outcome = null, search = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("History limit must be an integer from 1 to 50.");
  if (before !== null && (!isValidRunId(before) || before.length > 200)) throw new Error("Invalid history cursor.");
  if (domain !== null && !['refund','inventory','unknown'].includes(domain)) throw new Error('Domain filter must be refund, inventory, or unknown.');
  if (outcome !== null && !['settled','compensated','none'].includes(outcome)) throw new Error('Outcome filter must be settled, compensated, or none.');
  if (search !== null && (typeof search !== 'string' || !search.trim() || search.length > 200)) throw new Error('Search must contain 1 to 200 characters.');
  let entries;
  try { entries = readdirSync(join(outputRoot, "runs"), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { cases: [], next_cursor: null, scanned: 0, unavailable: [] }; throw error; }
  const ids = entries.filter((entry) => entry.isDirectory() && isValidRunId(entry.name) && (!before || entry.name < before))
    .map((entry) => entry.name).sort().reverse();
  const candidates = ids.slice(0, limit);
  const cases = [], unavailable = [];
  for (const runId of candidates) {
    try {
      const summary = summarizeRun(runId, { outputRoot });
      if (domain !== null && (summary.domain ?? 'unknown') !== domain) continue;
      if (outcome !== null && (summary.outcome ?? 'none') !== outcome) continue;
      if (search !== null && !['run_id','domain','policy_id','action_id','outcome','review_verdict','evidence_digest'].some(key => typeof summary[key] === 'string' && summary[key].toLowerCase().includes(search.trim().toLowerCase()))) continue;
      cases.push(summary);
    }
    catch { unavailable.push(runId); }
  }
  return { cases, next_cursor: ids.length > limit ? candidates.at(-1) : null, scanned: candidates.length, unavailable };
}

export function parseCasePageArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--json") continue;
    if (!["--before", "--limit", "--domain", "--outcome", "--search"].includes(key) || i + 1 >= args.length || Object.hasOwn(result, key.slice(2))) throw new Error("Usage: aas cases [--before run-id] [--limit 1..50] [--json]");
    const value = args[++i];
    if (key === '--domain' && !['refund','inventory','unknown'].includes(value)) throw new Error('Invalid domain filter.');
    if (key === '--outcome' && !['settled','compensated','none'].includes(value)) throw new Error('Invalid outcome filter.');
    if (key === '--search' && (!value.trim() || value.length > 200)) throw new Error('Search must contain 1 to 200 characters.');
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
  const failedRules = (Array.isArray(bundle.stages.decide?.rule_results) ? bundle.stages.decide.rule_results : []).filter(rule => rule?.passed === false);
  const policyFailures = { total: failedRules.length, omitted: Math.max(0, failedRules.length - 50), rules: failedRules.slice(0, 50).map(rule => Object.fromEntries(['rule_id','path','kind','reason_code'].map(key => [key, typeof rule[key] === 'string' ? rule[key].slice(0, 300) : null]))) };
  const computed = rail && typeof rail === 'object' ? 'sha256:' + createHash('sha256').update(JSON.stringify(rail)).digest('hex') : null;
  let readiness;
  if (!rail || typeof rail !== 'object' || Array.isArray(rail)) readiness = {state:'unavailable',reason:'No same-case rail bundle was saved.',next_step:'Inspect stage records. A skipped action or simulation-only case has no same-case evidence to verify.'};
  else if (review?.verdict !== 'recorded') readiness = {state:'unavailable',reason:'No recorded same-case review was saved.',next_step:'Inspect the prove stage diagnostic. Existing evidence cannot be repaired by rerunning verification.'};
  else if (computed !== review.evidenceDigest || typeof bundle.stages.act?.action_id !== 'string' || review.actionId !== bundle.stages.act.action_id) readiness = {state:'conflicting',reason:'Recorded review identity or digest differs from the saved action evidence.',next_step:'Preserve the case and compare it with the original handoff; do not treat it as verified.'};
  else readiness = {state:'ready',reason:'The saved action identity and evidence digest agree. Receipts remain unverified.',next_step:'Run aas verify '+runId+' with the correct --root and installed pinned components.'};
  return {
    verification_readiness: readiness,
    schema_version: 'agent-action-stack.case-review/v1', run_id: runId,
    created_at: bundle.manifest.created_at ?? null, domain: report.domain ?? null,
    requested_options: report.requested_options ?? null,
    policy_failures: policyFailures,
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
  const stageHeading = lines.splice(-2);
  lines.push('## Requested settings', '');
  for (const key of ['response','domain','fault','prove','dispute']) {
    const value = review.requested_options?.[key];
    lines.push('- '+key+': '+markdownText(typeof value === 'string' || typeof value === 'boolean' ? value : null));
  }
  lines.push('', '## Policy failures', '');
  if (!review.policy_failures?.total) lines.push('No failed rule records are available; this alone does not prove a policy pass.');
  for (const rule of review.policy_failures?.rules ?? []) lines.push('- '+markdownText(rule.rule_id)+': '+markdownText(rule.path)+'; '+markdownText(rule.kind)+'; '+markdownText(rule.reason_code));
  if (review.policy_failures?.omitted) lines.push(review.policy_failures.omitted+' additional failures omitted; inspect the decide artifact for all records.');
  lines.push('', ...stageHeading);
  for(const stage of review.stages??[]) lines.push('- '+markdownText(stage.name)+': '+markdownText(stage.status)+'; artifact '+(stage.artifact_available?'present':'absent')+'; reason '+markdownText(stage.reason)+'; code '+markdownText(stage.code));
  lines.push('', '## Evidence binding', '', '- Recorded digest: '+markdownText(review.recorded_evidence_digest), '- Recomputed digest: '+markdownText(review.recomputed_evidence_digest), '- Digests match: '+markdownText(review.digest_matches), '', '## Component revisions', '');
  for(const entry of review.component_provenance??[]) lines.push('- '+markdownText(entry.name)+': '+markdownText(entry.commit));
  lines.push('', '## Verification next step', '', '- Readiness: '+markdownText(review.verification_readiness?.state), '- Reason: '+markdownText(review.verification_readiness?.reason), '- Next step: '+markdownText(review.verification_readiness?.next_step));
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

export function renderComparisonMarkdown(result) {
  const lines=['# Saved case comparison','','- Classification: '+markdownText(result.classification),'- Left case: '+markdownText(result.left?.run_id),'- Right case: '+markdownText(result.right?.run_id),'','## Compared differences',''];
  if(!result.differences?.length) lines.push(result.classification==='not-comparable'?'Comparison unavailable.':'No compared field differs.');
  for(const difference of result.differences??[]) lines.push('- '+markdownText(difference.field)+': '+markdownText(JSON.stringify(difference.left))+' vs '+markdownText(JSON.stringify(difference.right)));
  if(result.errors?.length){lines.push('','## Unavailable evidence','');for(const error of result.errors) lines.push('- '+markdownText(error));}
  lines.push('','## Limits','','- Differences do not establish causation.','- Matching metadata does not prove matching evidence.','- No receipt verification, action execution, or remediation was performed.');
  return lines.join('\n')+'\n';
}
