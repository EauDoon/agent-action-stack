import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
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

async function runStack(page, { response = "pass", fault = "none", prove = "simulate", dispute = false } = {}) {
  await page.selectOption("#response", response);
  await page.selectOption("#fault", fault);
  await page.selectOption("#prove", prove);
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
