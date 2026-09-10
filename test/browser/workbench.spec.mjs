import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real browser workflow tests: actual clicks, file selection, downloads,
 * and asynchronous responses against the real orchestrator and pinned
 * components (no mocked responses).
 */

function caseFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), "aas-browser-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

async function runStack(page, { response = "pass", fault = "none", prove = "simulate", domain = "refund", dispute = false } = {}) {
  await page.selectOption("#response", response);
  await page.selectOption("#fault", fault);
  await page.selectOption("#prove", prove);
  await page.selectOption("#domain", domain);
  if (dispute) await page.check("#dispute");
  else await page.uncheck("#dispute");
  await page.click("#run");
  await expect(page.locator("#run")).toBeEnabled({ timeout: 120_000 });
}

test("run, inspect, export, import, and replay through the real UI", async ({ page, request, baseURL }) => {
  await page.goto("/");
  await runStack(page, { fault: "duplicate", prove: "rail" });

  await expect(page.locator("#summary")).toContainText("decide: passed");
  await expect(page.locator("#summary")).toContainText("mode rail-review");
  await expect(page.locator("#summary")).toContainText("review recorded");
  await expect(page.locator("#bindings")).toContainText("recomputed match");

  const runId = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/run?response=pass&fault=duplicate&prove=rail`, {
      method: "POST",
      headers: { origin },
    });
    const body = await response.json();
    return body.run_id;
  }, baseURL);

  const bundleResponse = await request.get(`/api/bundle/${runId}`);
  expect(bundleResponse.status()).toBe(200);
  const exported = await bundleResponse.text();
  const path = caseFile("case.json", exported);

  await page.setInputFiles("#case-file", path);
  await page.click("#replay");
  await expect(page.locator("#import-result")).toContainText("Imported case", { timeout: 120_000 });
  // "not verified" also contains "verified", so assert the headline exactly.
  await expect(page.locator("#import-result h3")).toHaveText(/— replay verified under synthetic demo keys$/);
  await expect(page.locator("#import-result")).toContainText("identity-binding: pass");
  await expect(page.locator("#import-result")).toContainText("review-replay: pass");
  await expect(page.locator("#import-result")).toContainText("no action execution or remediation runs");
});

test("refusal shows policy refusal and skips act and prove", async ({ page }) => {
  await page.goto("/");
  await runStack(page, { response: "fail" });
  await expect(page.locator("#summary")).toContainText("decide: failed");
  await expect(page.locator("#summary")).toContainText("act: skipped");
  await expect(page.locator("#summary")).toContainText("prove: skipped");
  await expect(page.locator("#bindings")).toContainText("action: none");
});

test("repeated runs replace the previous summary instead of stacking", async ({ page }) => {
  await page.goto("/");
  await runStack(page, { response: "fail" });
  await expect(page.locator("#summary")).toContainText("decide: failed");
  await runStack(page, { fault: "duplicate", prove: "rail" });
  await expect(page.locator("#summary")).toContainText("decide: passed");
  await expect(page.locator("#summary")).toContainText("mode rail-review");
  const summaries = await page.locator("#summary ul").count();
  expect(summaries).toBe(1);
});

test("imported results are cleared when a new run starts", async ({ page }) => {
  await page.goto("/");
  await runStack(page, { fault: "duplicate", prove: "rail" });
  const junk = caseFile("junk.json", "{not json");
  await page.setInputFiles("#case-file", junk);
  await page.click("#replay");
  await expect(page.locator("#import-status")).toContainText("Replay rejected");
  await runStack(page, { response: "pass" });
  await expect(page.locator("#import-result")).toBeEmpty();
  await expect(page.locator("#import-status")).toBeEmpty();
});

test("malformed and unavailable imports report explicit reasons", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#case-file", caseFile("junk.json", "{not json"));
  await page.click("#replay");
  await expect(page.locator("#import-status")).toContainText("Replay rejected");

  const noEvidence = JSON.stringify({ report: { run_id: "sim-only" }, stages: { act: {}, prove: {} } });
  await page.setInputFiles("#case-file", caseFile("sim.json", noEvidence));
  await page.click("#replay");
  await expect(page.locator("#import-result h3")).toHaveText(/— not verified$/);
  await expect(page.locator("#import-result")).toContainText("unavailable");
});

test("an oversized import is rejected by the server", async ({ page }) => {
  await page.goto("/");
  const oversized = JSON.stringify({ pad: "x".repeat(1024 * 1024 + 1024) });
  await page.setInputFiles("#case-file", caseFile("big.json", oversized));
  await page.click("#replay");
  await expect(page.locator("#import-status")).toContainText("too large");
});

test("case history loads and two cases can be compared through the UI", async ({ page }) => {
  await page.goto("/");
  await runStack(page, { fault: "duplicate", prove: "rail" });
  await runStack(page, { response: "pass" });

  await page.click("#load-history");
  await expect(page.locator("#history-list li").first()).toContainText("outcome settled");
  // The placeholder option plus at least the two runs made here (a shared
  // checkout may hold older cases, so this is a lower bound).
  const optionCount = await page.locator("#left-case option").count();
  expect(optionCount).toBeGreaterThanOrEqual(3);

  const values = await page.locator("#right-case option").evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
  expect(values.length).toBeGreaterThanOrEqual(2);
  await page.selectOption("#left-case", values[0]);
  await page.selectOption("#right-case", values[1]);
  await page.click("#compare");

  await expect(page.locator("#compare-result h3")).toHaveText(/Comparison: (identical|different|not-comparable)/);
  await expect(page.locator("#compare-result")).toContainText("differences do not establish causation");
  await expect(page.locator("#compare-result")).toContainText("matching metadata does not prove matching evidence");
});

test("the inventory domain runs through the UI with its own policy", async ({ page }) => {
  await page.goto("/");
  await runStack(page, { domain: "inventory", fault: "duplicate", prove: "rail" });
  await expect(page.locator("#summary")).toContainText("decide: passed");
  await expect(page.locator("#summary")).toContainText("policy aas-inventory-gate-v1");
  await expect(page.locator("#summary")).toContainText("mode rail-review");
  await expect(page.locator("#bindings")).toContainText("recomputed match");
});

test("comparison reports an explicit error when a selection is missing", async ({ page }) => {
  await page.goto("/");
  await page.click("#compare");
  await expect(page.locator("#compare-status")).toContainText("Select two cases");
});

test("tampered evidence is reported as conflicting, not verified", async ({ page }) => {
  await page.goto("/");
  const tampered = JSON.stringify({
    report: { run_id: "tampered-case" },
    stages: {
      act: { action_id: "act_t", rail_bundle: { action: { action_id: "act_t" }, settlement_receipt: { outcome: "settled" } } },
      prove: { result: { verdict: "recorded", actionId: "act_t", evidenceDigest: "sha256:stale", legalEffect: "not-determined", upstream: {} } },
    },
  });
  await page.setInputFiles("#case-file", caseFile("tampered.json", tampered));
  await page.click("#replay");
  await expect(page.locator("#import-result h3")).toHaveText(/— not verified$/);
  await expect(page.locator("#import-result")).toContainText("conflicting");
  await expect(page.locator("#import-result")).toContainText("digest-binding: FAIL");
});

test("guided inventory cases can be searched inspected and downloaded on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.selectOption('#domain','inventory');
  await page.selectOption('#scenario','compensated');
  await page.click('#apply-scenario');
  await expect(page.locator('#scenario-note')).toContainText('compensated');
  await expect(page.locator('#domain')).toHaveValue('inventory');
  await page.click('#run');
  await expect(page.locator('#run')).toBeEnabled({timeout:120000});
  await expect(page.locator('#summary')).toContainText('domain: inventory');
  await expect(page.locator('#bindings')).toContainText('recomputed match');
  await page.click('#load-history');
  await expect(page.locator('#left-case option')).not.toHaveCount(1);
  const id=await page.locator('#left-case option').nth(1).getAttribute('value');
  await page.fill('#history-search',id);
  await expect(page.locator('#history-list li')).toHaveCount(1);
  await page.selectOption('#left-case',id);
  await page.click('#inspect-case');
  await expect(page.locator('#saved-status')).toContainText('Inspection only');
  await expect(page.locator('#saved-summary')).toContainText('inventory');
  const downloading=page.waitForEvent('download');
  await page.click('#saved-download');
  const download=await downloading;
  expect(download.suggestedFilename()).toContain(id);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('saved case review supports keyboard lookup verification handoff and local bookmarks', async ({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  let executions=0;page.on('request',request=>{if(request.url().includes('/api/run?')) executions++;});
  await runStack(page,{domain:'inventory',fault:'duplicate',prove:'rail'});
  const runId=(await page.locator('#download').getAttribute('href')).split('/').at(-1);
  await page.fill('#saved-case-id',runId);await page.locator('#lookup-case').focus();await page.keyboard.press('Enter');
  await expect(page.locator('#saved-summary')).toContainText('inventory');
  await page.locator('#saved-artifacts details').first().locator('summary').click();
  await expect(page.locator('#saved-artifacts pre').first()).toBeVisible();
  await page.selectOption('#domain','refund');await page.click('#restore-settings');await expect(page.locator('#domain')).toHaveValue('inventory');
  expect(executions).toBe(1);
  await page.click('#replay-saved');await expect(page.locator('#saved-review-result h3')).toContainText('Saved case');
  await expect(page.locator('#saved-review-result h3')).toContainText('replay verified under synthetic demo keys');
  expect(executions).toBe(1);
  const downloading=page.waitForEvent('download');await page.click('#saved-report');
  const report=await downloading;expect(readFileSync(await report.path(),'utf8')).toContain('This export performs no receipt verification.');
  await page.click('#saved-link');await page.reload();await expect(page.locator('#saved-case-id')).toHaveValue(runId);expect(executions).toBe(1);
  await page.fill('#saved-case-id','missing-case');await page.click('#lookup-case');await expect(page.locator('#saved-status')).toContainText('not found');await expect(page.locator('#saved-report')).toBeHidden();
  await runStack(page,{response:'fail'});const second=(await page.locator('#download').getAttribute('href')).split('/').at(-1);
  await page.click('#load-history');await expect(page.locator('#left-case option')).not.toHaveCount(1);
  await page.selectOption('#left-case',runId);await page.selectOption('#right-case',second);await page.click('#compare');
  await expect(page.locator('#comparison-download')).toBeVisible();
  const comparing=page.waitForEvent('download');await page.click('#comparison-download');const comparison=await comparing;
  expect(readFileSync(await comparison.path(),'utf8')).toContain('Differences do not establish causation.');
  await page.selectOption('#right-case',runId);await expect(page.locator('#comparison-download')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
