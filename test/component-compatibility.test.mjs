import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { replayBundle, runProveRail } from "../bin/aas.mjs";
import { canonicalJson, digest } from "../deps/consequence-rail/src/canonical.js";
import { createDemoRuntime, buildRefundProposal, prepareRefund, runRefundDemo } from "../deps/consequence-rail/src/demo.js";
import { validateSettlementBundle } from "../deps/consequence-rail/src/bundle-validation.js";
import { MemoryEventStore } from "../deps/consequence-rail/src/event-store.js";
import { createDemoSigner, signArtifact } from "../deps/consequence-rail/src/signing.js";
import { canonicalize } from "../deps/mandatebound/dist/canonical.js";

// Run after bootstrap. These fixed expectations catch compatible-looking pins
// that bring back an upstream validation or canonicalization regression.
test("pinned producers retain independent canonical byte expectations", () => {
  assert.equal(canonicalJson({ "2": 2, "10": 10 }), '{"10":10,"2":2}');
  for (const codepoint of [0x2028, 0x2029]) {
    const separator = String.fromCodePoint(codepoint);
    assert.equal(canonicalize(separator), `"${separator}"`);
    assert.equal(canonicalize({ [separator]: separator }), `{"${separator}":"${separator}"}`);
  }
});

test("pinned rail rejects array currency at both public input boundaries", async () => {
  const runtime = createDemoRuntime();
  const proposal = buildRefundProposal(runtime.clock);
  proposal.parameters.currency = ["USD"];
  assert.throws(() => runtime.rail.propose(proposal), { code: "SCHEMA_INVALID" });
  assert.equal(runtime.rail.actions.size, 0);
  const { bundle } = await runRefundDemo();
  bundle.action.proposal.parameters.currency = ["USD"];
  assert.throws(() => validateSettlementBundle(bundle), { code: "BUNDLE_TAMPERED" });
});

test("same-case handoff refuses re-signed evidence for another currency", async () => {
  const { bundle } = await runRefundDemo();
  const signer = createDemoSigner();
  bundle.outcome_evidence[0].facts.currency = "EUR";
  bundle.outcome_evidence[0] = signArtifact(bundle.outcome_evidence[0], signer);
  const changedDigest = digest(bundle.outcome_evidence[0]);
  bundle.evidence_manifest = [changedDigest];
  for (const event of bundle.events) {
    if (event.payload?.evidence_digest) event.payload.evidence_digest = changedDigest;
  }
  let recordedAt;
  const events = new MemoryEventStore(signer, { now: () => recordedAt });
  bundle.events = bundle.events.map((event) => {
    recordedAt = event.recorded_at;
    return events.append(event.action_id, event.event_type, event.actor, event.payload);
  });
  bundle.settlement_receipt.evidence_digests = [changedDigest];
  bundle.settlement_receipt.event_chain_head = bundle.events.at(-1).event_hash;
  bundle.settlement_receipt = signArtifact(bundle.settlement_receipt, signer);
  assert.throws(() => runProveRail(bundle), (error) =>
    error.stage === "prove" && JSON.parse(error.stderr).code === "SEMANTIC_INVALID");
});

test("ordinary synthetic case exported by the previous pins still replays", () => {
  const legacy = JSON.parse(readFileSync(new URL("../fixtures/legacy-rail-review.json", import.meta.url), "utf8"));
  const previous = Object.fromEntries(legacy.manifest.component_provenance.map((entry) => [entry.name, entry.commit]));
  assert.equal(previous["consequence-rail"], "6c61e9fdcd1a4701afad1d2371abcb3f13bbab57");
  assert.equal(previous.mandatebound, "e526c4c32ac61571757a98ca1a69189821c3dce7");
  const result = replayBundle(legacy);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.checks.every((check) => check.passed));
});

test("moving-clock rail evidence survives the same-case handoff and replay", async () => {
  let tick = Date.parse("2035-01-01T00:00:00.000Z");
  const runtime = createDemoRuntime({ clock: { now: () => new Date(tick++).toISOString() } });
  const { actionId } = prepareRefund(runtime);
  await runtime.rail.execute(actionId, { fault: "duplicate" });
  await runtime.rail.verifyOutcome(actionId);
  await runtime.rail.remediate(actionId);
  const bundle = runtime.rail.exportBundle(actionId, { profile: "audit" });
  const proved = runProveRail(bundle);
  assert.equal(proved.ok, true);
  const replayed = replayBundle({
    report: { run_id: "moving-clock" },
    stages: { act: { action_id: actionId, rail_bundle: bundle }, prove: proved.raw },
  });
  assert.equal(replayed.ok, true, JSON.stringify(replayed));
});
