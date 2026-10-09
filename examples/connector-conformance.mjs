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
 * drives the rail's synthetic connector modules in-process and exits nonzero
 * on the first violated rule. Every rule runs against both connectors and
 * measures the effect itself: the inventory on hand for allocations, and the
 * active refunds bound to the action for refunds.
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

// Each call runs in a fresh process with fresh connectors, so one rule's
// effects never leak into the next rule's measurements.
function run(statement, { args = [] } = {}) {
  const script = `
    const { MockRefundConnector } = await import("./src/mock-refund-connector.js");
    const { MockInventoryConnector } = await import("./src/mock-inventory-connector.js");
    const { buildRefundProposal } = await import("./src/demo.js");
    const { buildInventoryProposal } = await import("./src/inventory-demo.js");
    const { ManualClock } = await import("./src/clock.js");
    const clock = new ManualClock();
    const refund = new MockRefundConnector(clock);
    const inventory = new MockInventoryConnector(clock);
    const refundProposal = buildRefundProposal(clock);
    const inventoryProposal = buildInventoryProposal(clock);
    // Effect probes: what the connector actually changed.
    const onHand = () => inventory.inventory.get(inventoryProposal.parameters.sku);
    const baseline = inventory.onHandBaseline;
    const quantity = inventoryProposal.parameters.quantity;
    const boundRefunds = () => refund.refunds.filter((item) => item.execution_key === refundProposal.idempotency_key);
    const activeRefunds = () => boundRefunds().filter((item) => item.status === "active").length;
    const remedyRequest = {
      action_digest: "sha256:x", kind: "reverse", remedy_window_seconds: 120, max_attempts: 1, idempotency_key: "remedy:x",
    };
    const refundRequest = (overrides = {}) => ({
      ...remedyRequest, connector: "mock-refund-processor", capability: "void-duplicate-refund",
      capability_reference: "demo-capability:void-duplicate-refund", expires_at: refundProposal.expires_at,
      max_amount_minor: refundProposal.parameters.amount_minor, ...overrides,
    });
    const inventoryRequest = (overrides = {}) => ({
      ...remedyRequest, connector: "mock-inventory-service", capability: "release-allocation",
      capability_reference: "demo-capability:release-allocation", expires_at: inventoryProposal.expires_at,
      max_quantity: quantity, ...overrides,
    });
    const refusalCode = (call) => { try { call(); return null; } catch (error) { return error.code ?? "uncoded"; } };
    const asyncRefusalCode = async (call) => { try { await call(); return null; } catch (error) { return error.code ?? "uncoded"; } };
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
}

function pass(rule) {
  process.stdout.write(`ok   ${rule} (refund, inventory)\n`);
}

function main() {
  process.stdout.write(`connector conformance: ${RULES.length} rules, each on the refund and inventory connectors\n`);

  const capabilities = run(`out({ refund: refund.capabilities(), inventory: inventory.capabilities() });`);
  check(RULES[0],
    capabilities.refund.connector === "mock-refund-processor"
      && capabilities.refund.exclusive_credential_custody === true
      && capabilities.refund.actions.includes("demo.refund.issue/v1")
      && capabilities.refund.remedies.includes("void-duplicate-refund")
      && capabilities.inventory.connector === "mock-inventory-service"
      && capabilities.inventory.exclusive_credential_custody === true
      && capabilities.inventory.actions.includes("demo.inventory.allocate/v1")
      && capabilities.inventory.remedies.includes("release-allocation"),
    `capabilities must name the connector, its actions and remedies, and custody (saw ${JSON.stringify(capabilities)})`);
  pass(RULES[0]);

  const refusal = run(`
    out({
      refund: {
        // A positive control: the base request is valid, so each refusal
        // below is caused by the one field it changes.
        valid: refund.reserveRecourse(refundProposal, refundRequest()).status,
        unknownCapability: refusalCode(() => refund.reserveRecourse(refundProposal, refundRequest({ capability: "other" }))),
        undersized: refusalCode(() => refund.reserveRecourse(refundProposal, refundRequest({ max_amount_minor: refundProposal.parameters.amount_minor - 1 }))),
        crossDomain: refusalCode(() => refund.reserveRecourse(inventoryProposal, refundRequest())),
      },
      inventory: {
        valid: inventory.reserveRecourse(inventoryProposal, inventoryRequest()).status,
        unknownCapability: refusalCode(() => inventory.reserveRecourse(inventoryProposal, inventoryRequest({ capability: "other" }))),
        undersized: refusalCode(() => inventory.reserveRecourse(inventoryProposal, inventoryRequest({ max_quantity: quantity - 1 }))),
        crossDomain: refusalCode(() => inventory.reserveRecourse({ ...inventoryProposal, action_type: "demo.refund.issue/v1" }, inventoryRequest())),
      },
    });
  `);
  for (const name of ["refund", "inventory"]) {
    const seen = refusal[name];
    check(RULES[1],
      seen.valid === "active"
        && seen.unknownCapability === "RECOURSE_UNAVAILABLE"
        && seen.undersized === "RECOURSE_SCOPE_INSUFFICIENT"
        && seen.crossDomain === "RECOURSE_UNAVAILABLE",
      `the ${name} connector must accept a valid scope and refuse unsafe ones (saw ${JSON.stringify(seen)})`);
  }
  pass(RULES[1]);

  const execution = run(`
    const refundFirst = await refund.execute(refundProposal, refundProposal.idempotency_key);
    const refundSecond = await refund.execute(refundProposal, refundProposal.idempotency_key);
    const inventoryFirst = await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    const inventorySecond = await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    out({
      refund: {
        calls: refund.executeCalls, status: refundFirst.status,
        sameResult: JSON.stringify(refundFirst) === JSON.stringify(refundSecond),
        active: activeRefunds(), created: refund.refunds.length,
      },
      inventory: {
        calls: inventory.executeCalls, status: inventoryFirst.status,
        sameResult: JSON.stringify(inventoryFirst) === JSON.stringify(inventorySecond),
        onHand: onHand(), expected: baseline - quantity,
      },
    });
  `);
  check(RULES[2],
    execution.refund.calls === 2 && execution.refund.status === "executed" && execution.refund.sameResult === true
      && execution.refund.active === 1 && execution.refund.created === 1,
    `two executes with one key must create exactly one refund (saw ${JSON.stringify(execution.refund)})`);
  check(RULES[2],
    execution.inventory.calls === 2 && execution.inventory.status === "executed" && execution.inventory.sameResult === true
      && execution.inventory.onHand === execution.inventory.expected,
    `two executes with one key must allocate the quantity once (saw ${JSON.stringify(execution.inventory)})`);
  pass(RULES[2]);

  const reconcile = run(`
    const refundResult = await refund.execute(refundProposal, refundProposal.idempotency_key);
    const inventoryResult = await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    const before = { refundCalls: refund.executeCalls, refunds: activeRefunds(), inventoryCalls: inventory.executeCalls, onHand: onHand() };
    const refundStatus = await refund.status(refundProposal.idempotency_key);
    const inventoryStatus = await inventory.status(inventoryProposal.idempotency_key);
    out({
      refund: {
        unchanged: refund.executeCalls === before.refundCalls && activeRefunds() === before.refunds,
        recorded: JSON.stringify(refundStatus) === JSON.stringify(refundResult),
        unknown: (await refund.status("never-executed")).status,
      },
      inventory: {
        unchanged: inventory.executeCalls === before.inventoryCalls && onHand() === before.onHand,
        recorded: JSON.stringify(inventoryStatus) === JSON.stringify(inventoryResult),
        unknown: (await inventory.status("never-executed")).status,
      },
    });
  `);
  for (const name of ["refund", "inventory"]) {
    const seen = reconcile[name];
    check(RULES[3],
      seen.unchanged === true && seen.recorded === true && seen.unknown === "unknown",
      `status on the ${name} connector must report the recorded result without executing or changing the effect (saw ${JSON.stringify(seen)})`);
  }
  pass(RULES[3]);

  const inventoryRemedy = run(`
    const reservation = inventory.reserveRecourse(inventoryProposal, inventoryRequest());
    await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    const afterExecute = onHand();
    const first = await inventory.remediate(inventoryProposal, { connector_commitment: reservation }, "remedy:a");
    const afterRemedy = onHand();
    const replay = await inventory.remediate(inventoryProposal, { connector_commitment: reservation }, "remedy:a");
    const secondError = await asyncRefusalCode(() => inventory.remediate(inventoryProposal, { connector_commitment: reservation }, "remedy:b"));
    out({
      afterExecute, afterRemedy, baseline, quantity, final: onHand(),
      first: first.status, sameResult: JSON.stringify(first) === JSON.stringify(replay),
      recourse: inventory.recourseStatus(reservation.reservation_token).status, secondError,
    });
  `);
  check(RULES[4],
    inventoryRemedy.afterExecute === inventoryRemedy.baseline - inventoryRemedy.quantity
      && inventoryRemedy.first === "remediated" && inventoryRemedy.afterRemedy === inventoryRemedy.baseline
      && inventoryRemedy.sameResult === true && inventoryRemedy.recourse === "consumed"
      && inventoryRemedy.secondError === "RECOURSE_NOT_ACTIVE" && inventoryRemedy.final === inventoryRemedy.baseline,
    `the inventory remedy must restore on-hand stock to the baseline exactly once (saw ${JSON.stringify(inventoryRemedy)})`);

  const refundRemedy = run(`
    const reservation = refund.reserveRecourse(refundProposal, refundRequest());
    const remedy = { connector_commitment: reservation, capability: "void-duplicate-refund" };
    const executed = await refund.execute(refundProposal, refundProposal.idempotency_key, "duplicate");
    const afterExecute = activeRefunds();
    const first = await refund.remediate(refundProposal, remedy, "remedy:a");
    const replay = await refund.remediate(refundProposal, remedy, "remedy:a");
    const secondError = await asyncRefusalCode(() => refund.remediate(refundProposal, remedy, "remedy:b"));
    const primary = refund.refunds.find((item) => item.refund_id === executed.external_id);
    const voided = boundRefunds().filter((item) => item.status === "voided");
    out({
      afterExecute, first: first.status, active: activeRefunds(),
      voided: voided.map((item) => item.synthetic_reference.split(":").at(-1)),
      voidedIsReported: voided.length === 1 && voided[0].refund_id === first.external_id,
      primary: primary?.status ?? null,
      sameResult: JSON.stringify(first) === JSON.stringify(replay),
      recourse: refund.recourseStatus(reservation.reservation_token).status, secondError,
    });
  `);
  check(RULES[4],
    refundRemedy.afterExecute === 2 && refundRemedy.first === "remediated" && refundRemedy.active === 1
      && JSON.stringify(refundRemedy.voided) === JSON.stringify(["duplicate"]) && refundRemedy.voidedIsReported === true
      && refundRemedy.primary === "active" && refundRemedy.sameResult === true && refundRemedy.recourse === "consumed"
      && refundRemedy.secondError === "RECOURSE_NOT_ACTIVE",
    `the refund remedy must void only the duplicate, once, and keep the primary (saw ${JSON.stringify(refundRemedy)})`);

  const cleanRefund = run(`
    const reservation = refund.reserveRecourse(refundProposal, refundRequest());
    const executed = await refund.execute(refundProposal, refundProposal.idempotency_key);
    const result = await refund.remediate(refundProposal, { connector_commitment: reservation, capability: "void-duplicate-refund" }, "remedy:a");
    out({
      result: result.status, active: activeRefunds(),
      primary: refund.refunds.find((item) => item.refund_id === executed.external_id)?.status ?? null,
      recourse: refund.recourseStatus(reservation.reservation_token).status,
    });
  `);
  check(RULES[4],
    cleanRefund.result === "no_change" && cleanRefund.active === 1 && cleanRefund.primary === "active"
      && cleanRefund.recourse === "active",
    `a refund without a duplicate must not be voided by the remedy (saw ${JSON.stringify(cleanRefund)})`);
  pass(RULES[4]);

  const remedyStatus = run(`
    const refundReservation = refund.reserveRecourse(refundProposal, refundRequest());
    await refund.execute(refundProposal, refundProposal.idempotency_key, "duplicate");
    await refund.remediate(refundProposal, { connector_commitment: refundReservation, capability: "void-duplicate-refund" }, "remedy:a");
    const inventoryReservation = inventory.reserveRecourse(inventoryProposal, inventoryRequest());
    await inventory.execute(inventoryProposal, inventoryProposal.idempotency_key);
    await inventory.remediate(inventoryProposal, { connector_commitment: inventoryReservation }, "remedy:a");
    out({
      refund: { recorded: (await refund.remedyStatus("remedy:a")).status, unknown: (await refund.remedyStatus("remedy:missing")).status },
      inventory: { recorded: (await inventory.remedyStatus("remedy:a")).status, unknown: (await inventory.remedyStatus("remedy:missing")).status },
    });
  `);
  for (const name of ["refund", "inventory"]) {
    const seen = remedyStatus[name];
    check(RULES[5],
      seen.recorded === "remediated" && seen.unknown === "unknown",
      `remedyStatus on the ${name} connector must confirm the recorded result (saw ${JSON.stringify(seen)})`);
  }
  pass(RULES[5]);

  process.stdout.write("connector conformance: all rules hold for the synthetic connectors\n");
  process.stdout.write("this conformance is a synthetic self-check: it does not certify any real "
    + "connector, provider, or external effect\n");
}

main();
