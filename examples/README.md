# Integrator examples

Runnable scripts that connect the pinned components through their supported
public interfaces. They transport bytes between component CLIs and check the
bindings between outputs; policy semantics stay in the testbench, execution
semantics in the rail, and review semantics in MandateBound. Nothing is
mocked: every step spawns the real component CLI.

Prerequisites: Node.js 22.12+, Python 3.11+ on `PATH`, and a bootstrapped
checkout (`npm run bootstrap`).

```bash
npm run example:review-handoff
npm run example:review-handoff -- --domain inventory
npm run example:review-handoff -- --response fail   # exits 1, refusing
npm run example:connector-conformance
```

## review-handoff.mjs

One journey across both synthetic domains (`--domain refund|inventory`):

1. policy evaluation with constitutional-agent-testbench
2. execution with consequence-rail, which reserves recourse before the
   permit and persists the settlement bundle
3. evidence inspection: the observed facts and the receipt's digests
4. verification with the rail's own bundle verifier
5. same-case review bound to the same action id and digest in MandateBound
6. offline replay of the exported case, without rerunning the action

The pass path exits 0 after every binding verifies. The refusal path exits 1
after the policy refuses, before anything executes.

What it establishes: the policy gate passed for this response, the rail
produced this outcome for this action, recourse was reserved before the
effect, the rail's verifier accepts the persisted bytes under the synthetic
demo trust keys, the review record binds the same action id and evidence
digest, and the exported case replays offline.

What it does not establish: source truth, recovery success, legal effect,
protocol compliance, or that any real-world action is reversible or safe.

## connector-conformance.mjs

The connector contract, exercised against both real synthetic connectors:
capability advertisement, recourse reservation refusals (unknown capability,
undersized scope, cross-domain action), at-most-once execution per
idempotency key, reconciliation without re-execution, a remedy that reverses
only the effect bound to the action and only once, and remedy status
confirmation.

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
  separate from exported untrusted material. Rethem recomputation always runs
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
