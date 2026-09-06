#!/usr/bin/env node
/**
 * Executable connector conformance example: the responsibilities a
 * connector must satisfy, demonstrated against the two real synthetic
 * connectors rather than described in prose.
 *
 * Prerequisite: `npm run bootstrap`.
 *
 * A connector owns the external effect and its remedy. The rail supplies
 * ordering, recourse gating, evidence handling, and receipts. This script
 * exercises the conformance rules with real calls and exits nonzero on the
 * first violated rule.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const railDir = join(root, "deps", "consequence-rail");

const RULES = [
  "capabilities: advertise connector, actions, remedies, and credential custody",
  "reserveRecourse: refuse unknown capabilities and undersized or cross-domain scope",
  "execute: apply the declared effect at most once per idempotency key",
  "reconcile: report the recorded result instead of re-executing",
  "remediate: reverse only the effect bound to the action, once",
  "remedyStatus: confirm the recorded remedy result",
];

function fail(rule, reason) {
  process.stderr.write(`connector conformance failed: ${rule}\n  ${reason}\n`);
  process.exit(1);
}

function run(statement, { args = [] } = {}) {
  const script = `
    const { MockRefundConnector } = await import("./src/mock-refund-connector.js");
    const { MockInventoryConnector, measureMockInventoryRecoveryImplementation } = await import("./src/mock-inventory-connector.js");
    const { buildRefundProposal } = await import("./src/demo.js");
    const { buildInventoryProposal } = await import("./src/inventory-demo.js");
    const { ManualClock } = await import("./src/clock.js");
    const clock = new ManualClock();
    const refund = new MockRefundConnector(clock);
    const inventory = new MockInventoryConnector(clock);
    const refundProposal = buildRefundProposal(clock);
    const inventoryProposal = buildInventoryProposal(clock);
    const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    ${statement}
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...args], {
    cwd: railDir,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) fail("harness", `cannot run the connector (${result.error.code ?? "spawn-error"})`);
  if (result.status !== 0) fail("harness", result.stderr.slice(-400));
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

function check(rule, condition, reason) {
  if (condition !== true) fail(rule, reason);
  process.stdout.write(`ok   ${rule}\n`);
}

function main() {
  process.stdout.write(`connector conformance: ${RULES.length} rules\n`);

  const capabilities = run(`out({ refund: refund.capabilities(), inventory: inventory.capabilities() });`);
  check(RULES[0],
    capabilities.refund.connector === "mock-refund-processor"
      && capabilities.refund.exclusive_credential_custody === true
      && capabilities.inventory.connector === "mock-inventory-service"
      && capabilities.inventory.remedies.includes("release-allocation"),
    "capabilities must name the connector, its remedies, and custody");

  const refusal = run(`
    const base = {
      action_digest: "sha256:x", kind: "reverse",
      capability_reference: "demo-capability:release-allocation",
      expires_at: inventoryProposal.expires_at, remedy_window_seconds: 120,
      max_attempts: 1, idempotency_key: "remedy:x",
    };
    const results = {};
    try { inventory.reserveRecourse(inventoryProposal, { ...base, connector: "mock-inventory-service", capability: "other", max_quantity: 4 }); results.unknownCapability = null; }
    catch (error) { results.unknownCapability = error.code; }
    try { inventory.reserveRecourse(inventoryProposal, { ...base, connector: "mock-inventory-service", capability: "release-allocation", max_quantity: 1 }); results.undersized = null; }
    catch (error) { results.undersized = error.code; }
    try { inventory.reserveRecourse({ ...inventoryProposal, action_type: "demo.refund.issue/v1" }, { ...base, connector: "mock-inventory-service", capability: "release-allocation", max_quantity: 4 }); results.crossDomain = null; }
    catch (error) { results.crossDomain = error.code; }
    out(results);
  `);
  check(RULES[1],
    refusal.unknownCapability === "RECOURSE_UNAVAILABLE"
      && refusal.undersized === "RECOURSE_SCOPE_INSUFFICIENT"
      && refusal.crossDomain === "RECOURSE_UNAVAILABLE",
    `reserveRecourse must refuse unsafe scopes (saw ${JSON.stringify(refusal)})`);

  const execution = run(`
    const first = await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    const second = await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    out({
      calls: inventory.executeCalls,
      sameResult: JSON.stringify(first) === JSON.stringify(second),
      status: first.status,
      onHand: inventory.inventory.get("sku_demo_1"),
    });
  `);
  check(RULES[2],
    execution.calls === 2 && execution.sameResult === true && execution.status === "executed",
    "repeat execute must return the recorded result without a second effect");

  const reconcile = run(`
    await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    const before = inventory.executeCalls;
    const status = await inventory.status(inventoryProposal.idempotency_key);
    out({ before, after: inventory.executeCalls, status: status.status });
  `);
  check(RULES[3],
    reconcile.before === reconcile.after && reconcile.status === "executed",
    "status must report the recorded result without re-executing");

  const remedy = run(`
    const reservation = inventory.reserveRecourse(inventoryProposal, {
      action_digest: "sha256:x", kind: "reverse", connector: "mock-inventory-service",
      capability: "release-allocation", capability_reference: "demo-capability:release-allocation",
      expires_at: inventoryProposal.expires_at, remedy_window_seconds: 120, max_attempts: 1,
      max_quantity: inventoryProposal.parameters.quantity, idempotency_key: "remedy:x",
    });
    await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    const first = await inventory.remediate(inventoryProposal, { connector_commitment: reservation }, "remedy:a");
    const onHandAfterFirst = inventory.inventory.get("sku_demo_1");
    const second = await inventory.remediate(inventoryProposal, { connector_commitment: reservation }, "remedy:b");
    out({
      first: first.status, second: second.status,
      restoredOnce: inventory.inventory.get("sku_demo_1") === onHandAfterFirst,
      onHand: inventory.inventory.get("sku_demo_1"),
    });
  `);
  check(RULES[4],
    remedy.first === "remediated" && remedy.second === "failed" && remedy.restoredOnce === true,
    `the remedy must reverse once and refuse a second restoration (saw ${JSON.stringify(remedy)})`);

  const remedyStatus = run(`
    const reservation = inventory.reserveRecourse(inventoryProposal, {
      action_digest: "sha256:x", kind: "reverse", connector: "mock-inventory-service",
      capability: "release-allocation", capability_reference: "demo-capability:release-allocation",
      expires_at: inventoryProposal.expires_at, remedy_window_seconds: 120, max_attempts: 1,
      max_quantity: inventoryProposal.parameters.quantity, idempotency_key: "remedy:x",
    });
    await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    await inventory.remediate(inventoryProposal, { connector_commitment: reservation }, "remedy:a");
    const recorded = await inventory.remedyStatus("remedy:a");
    const unknown = await inventory.remedyStatus("remedy:missing");
    out({ recorded: recorded.status, unknown: unknown.status });
  `);
  check(RULES[5],
    remedyStatus.recorded === "remediated" && remedyStatus.unknown === "unknown",
    `remedyStatus must confirm the recorded result (saw ${JSON.stringify(remedyStatus)})`);

  process.stdout.write("connector conformance: all rules hold for the synthetic connectors\n");
  process.stdout.write("this conformance is a synthetic self-check: it does not certify any real "
    + "connector, provider, or external effect\n");
}

main();
