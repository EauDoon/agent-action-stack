# Integrator examples

Runnable scripts that connect the pinned components. `review-handoff.mjs`
spawns the real component CLIs, transports bytes between them, and checks the
bindings between outputs; policy semantics stay in the testbench, execution
semantics in the rail, and review semantics in MandateBound. Nothing in it is
mocked. `connector-conformance.mjs` instead drives the rail's synthetic
connector modules in-process (`src/mock-refund-connector.js` and
`src/mock-inventory-connector.js` in the pinned checkout); those are rail
internals, not a supported public interface, and the example moves with the
rail pin.

Prerequisites: Node.js 22.12+, Python 3.11+ on `PATH`, and a bootstrapped
checkout (`npm run bootstrap`).

```bash
npm run example:review-handoff
node examples/review-handoff.mjs --domain inventory
node examples/review-handoff.mjs --response fail   # exits 1, refusing
npm run example:connector-conformance
```

The options are passed to `node` directly: forwarding them through
`npm run ... -- --flag value` is unreliable on the Windows shell, which is
why CI invokes the script the same way.

## review-handoff.mjs

One journey across both synthetic domains (`--domain refund|inventory`):

1. policy evaluation with constitutional-agent-testbench, against the same
   gate `aas demo` uses: `fixtures/policy.json` (`aas-refund-gate-v1`) or
   `fixtures/inventory.policy.json` (`aas-inventory-gate-v1`). The example
   fails if step 1 or the orchestrated run in step 6 reports another policy.
2. execution with consequence-rail, which reserves recourse before the
   permit and persists the settlement bundle
3. evidence inspection: the observed facts and the receipt's digests
4. verification with the rail's own bundle verifier
5. same-case review bound to the same action id and digest in MandateBound
6. offline replay of the exported case, without rerunning the action

The pass path exits 0 after every binding verifies. The refusal path exits 1
after the policy refuses, before anything executes.

This is the primary same-case demonstration. The separate `--prove simulate`
mode runs an unrelated canned dispute scenario. The testbench pass is a gate
over a response fixture, not a signed authorization of the rail proposal.

What it establishes: the policy gate passed for this response, the rail
produced this outcome for this action, recourse was reserved before the
effect, the rail's verifier accepts the persisted bytes under the synthetic
demo trust keys, the review record binds the same action id and evidence
digest, and the exported case replays offline.

What it does not establish: source truth, recovery success, legal effect,
protocol compliance, or that any real-world action is reversible or safe.

## connector-conformance.mjs

The connector contract, exercised rule by rule against both synthetic
connectors (refund and inventory), measuring the effect rather than only the
return values:

1. capability advertisement: connector, actions, remedies, and custody
2. recourse reservation: a valid scope is accepted, and an unknown
   capability, an undersized scope, and a cross-domain action are refused
3. at-most-once execution: two executes with one idempotency key leave
   exactly one active refund, and take the allocated quantity off on-hand
   stock once
4. reconciliation: `status` returns the recorded result without another
   execute call or any change to the effect
5. remedy: the inventory remedy returns on-hand stock exactly to its
   baseline; the refund remedy voids only the duplicate refund created by
   the duplicate fault and keeps the primary, and a clean refund remediates
   to `no_change`. Replaying the same remedy key returns the same result,
   and a second key is refused with `RECOURSE_NOT_ACTIVE`
6. remedy status: the recorded remedy result is confirmed, and an unknown
   key reports `unknown`

Each rule prints `ok <rule> (refund, inventory)`; the first violation exits 1.

It is a synthetic self-check of the shipped connectors. It does not certify
any real connector, provider, or external effect.

## Connector responsibilities

A connector owns the external effect and its remedy. It must:

- advertise its connector name, supported actions and remedies, and whether
  it holds exclusive downstream credential custody
- reserve recourse for a declared capability and scope, refusing unknown
  capabilities, undersized scope, and actions from another domain
- apply the declared effect at most once per idempotency key, and report the
  recorded result when asked to reconcile instead of retrying
- reverse only the effect bound to the action, exactly once, and never
  another order's or action's effect
- keep its own domain invariants (for example: inventory never goes negative)

The rail supplies ordering, recourse gating, evidence freshness, receipts,
and refusal behavior. It never retries an unknown outcome, and it never
treats an observed effect as proof of external truth.

## Trust assumptions

- Demonstration trust comes from the rail's synthetic demo keys and the
  connector's synthetic demo key. Verifier trust is supplied by the caller;
  nothing embedded in a bundle is trusted for its own integrity.
- Caller-owned anchors (expected digests, expected action identity) are
  separate from exported untrusted material. Digest recomputation always runs
  over the actual bytes.
- Source truth is never established. A recorded review proves the handoff
  and the digest binding, not the underlying external state.

## Refusal and compatibility boundaries

- A refused policy stops the run before execution; no permit or effect
  follows.
- Unknown action types, unsupported scope fields, and cross-domain artifacts
  are rejected, not coerced. Each domain keeps its own remedy scope field
  (`max_amount_minor` for refunds, `max_quantity` for allocations).
- Review reports unavailable, conflicting, and unsupported results
  explicitly; it never reports success for an unverified binding.
- Legal effect is always `not-determined`. These examples make no claim of
  AP2/UCP compliance or of real-world reversibility.

The review-handoff example uses the same bounded Python discovery as the CLI, including AAS_PYTHON and the Windows py launcher. An invalid explicit override fails before any component executes.
