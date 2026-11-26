import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../../stack-lock.json", import.meta.url), "utf8"));

test("the workbench opens a read-only atlas with bookmarkable paths and pinned sources", async ({ page }) => {
  await page.goto("/");
  const calls = [];
  page.on("request", (r) => calls.push([r.method(), new URL(r.url()).pathname]));
  await page.getByRole("link", { name: "Explore the evidence atlas" }).click();
  await expect(page.getByRole("heading", { name: "Evidence atlas" })).toBeVisible();

  for (const { name, commit, expected_entrypoints } of lock.components) {
    const link = page.locator('[data-component="' + name + '"]');
    const href = new URL(await link.getAttribute("href"));
    expect(href.origin).toBe("https://github.com");
    const prefix = "/EauDoon/" + name + "/blob/" + commit + "/";
    expect(href.pathname.startsWith(prefix)).toBe(true);
    expect(expected_entrypoints).toContain(href.pathname.slice(prefix.length));
  }

  await page.getByRole("combobox", { name: "Trace", exact: true }).selectOption("refusal");
  await expect(page.locator("#path button")).toHaveText(["Response", "Policy gate", "Saved bundle"]);
  await page.getByRole("button", { name: "Policy gate" }).click();
  await expect(page.locator("#stage-name")).toHaveText("Policy gate");
  await expect(page).toHaveURL(/#trace=refusal&stage=decide$/);
  await page.reload();
  await expect(page.locator("#stage-name")).toHaveText("Policy gate");
  const graph = page.locator("canvas");
  const original = await graph.evaluate((el) => el.toDataURL());
  await graph.focus();
  await page.keyboard.press("ArrowRight");
  expect(await graph.evaluate((el) => el.toDataURL())).not.toEqual(original);
  await page.keyboard.press("Home");
  expect(await graph.evaluate((el) => el.toDataURL())).toEqual(original);

  await page.getByText("Inspect the route as JSON").click();
  const result = JSON.parse(await page.locator("#query-result").innerText());
  expect(result.data.route.edges).toEqual([{ from: "input", to: "decide" }, { from: "decide", to: "bundle" }]);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download result" }).click(),
  ]);
  expect(JSON.parse(readFileSync(await download.path(), "utf8"))).toEqual(result);
  expect(calls.filter(([method, path]) => method !== "GET" || path.startsWith("/api/"))).toEqual([]);
});

test("without JavaScript the atlas still documents every route and component", async ({ browser, baseURL }) => {
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 360, height: 740 } });
  try {
    await page.goto(baseURL + "/architecture/");
    await expect(page.getByRole("heading", { name: "Evidence paths" })).toBeVisible();
    await expect(page.locator("#routes dt")).toHaveCount(4);
    await expect(page.locator("#stages article")).toHaveCount(6);
    await expect(page.getByRole("link", { name: "Pinned reviewer" })).toBeVisible();
    await expect(page.locator(".interactive")).toBeHidden();
  } finally {
    await page.close();
  }
});
