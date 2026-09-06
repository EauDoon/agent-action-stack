# Integrator examples

Runnable scripts that connect the pinned components through their supported
public interfaces. They transport bytes between component CLIs and check the
bindings between outputs; policy semantics stay in the testbench, execution
semantics in the rail, and review semantics in MandateBound.

Prerequisites: Node.js 22.12+, Python 3.11+ on `PATH`, and a bootstrapped
checkout (`npm run bootstrap`).

## review-handoff.mjs

One policy evaluation, one synthetic rail execution, rail verification of
the persisted bundle, and a MandateBound review bound to the same action
and digest:

```bash
npm run example:review-handoff
npm run example:review-handoff -- --response fail
```

The pass path exits 0 after every binding verifies. The refusal path exits
1 after the policy refuses, before anything executes.

What it establishes: the policy gate passed for this response, the rail
produced this outcome for this action, the rail's own verifier accepts the
persisted bytes under the synthetic demo trust keys, and the review record
binds the same action id and evidence digest.

What it does not establish: source truth, recovery success, legal effect,
or protocol compliance. The review records the handoff; it does not
re-verify rail signatures or interpret the receipt as a liability
conclusion.
