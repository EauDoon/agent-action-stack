# Orchestrator architecture

Agent Action Stack is a thin orchestrator. It does not re-implement policy
evaluation, recourse rails, or dispute evidence simulation. It sequences three
public sibling libraries in a fixed order and persists one isolated run
bundle per invocation.

This document describes the architecture the code in this repository actually
implements. It does not describe behavior owned by the sibling libraries;
their documentation is the source of truth for those.

## Bounded responsibility

- Orchestration only. Policy, recourse, and proof logic live in the three
  sibling repositories.
- Synthetic connectors and scenarios only. No real account, merchant,
  payment, or external provider integration.
- One run, one bundle. Each invocation writes an atomic bundle under
  `.out/runs/<run-id>/` and updates `.out/latest.json` only on a complete
  bundle; a failed or skipped stage cannot leave an older artifact looking
  current.
- Public dependencies only. `stack-lock.json` pins the three sibling repos
  to exact public commits. Nothing private is cloned or modified.

## Stage flow: decide then act then prove

The `runDemo` function in `bin/aas.mjs` is the orchestrator. It runs three
stages in order. Each stage returns a child result captured from a spawned
process, and the orchestrator records the stage status into the report.

```
   decide (Constitutional Agent Testbench, Python)
        |
        | passed?
        |--- no ---> stop (policy_failed)
        v yes
   act (Consequence Rail, Node)
        |
        | ok?
        |--- no ---> stop (act_failed)
        v ok
        | outcome != "settled" or --dispute?
        |--- no (and not --dispute) ---> skip (no_dispute)
        v yes
   prove (MandateBound, Node): dispute scenario or rail review
```

The `flow` field in the report records the actual path taken:

- `decide -> stop (policy failed)` when decide returns non-ok
- `decide -> act -> stop (act failed)` when act returns non-ok
- `decide -> act` when act settles cleanly and `--dispute` was not passed
- `decide -> act -> prove` when the rail outcome needs review or `--dispute`
  forces the prove path
- `decide -> error` or `decide -> act error` or `decide -> act -> prove
  error` when a stage throws

The prove stage has two modes, selected by `--prove`:

- `simulate` (default): runs MandateBound's canned dispute scenario. For the
  demo the scenario is `operator`.
- `rail`: re-opens the act-stage rail bundle, verifies it with the rail's
  own verifier, and binds it into a MandateBound review record for the same
  action id and digests. The review records the rail's verdict without
  re-verifying rail signatures; source truth stays unknown and legal effect
  stays not determined.

## Child execution and timeouts

Each decide, act, and prove child is spawned with a bounded timeout. Default
is 30000 ms (`AAS_CHILD_TIMEOUT_MS`); empty values keep the default and
invalid integers are rejected at parse time. A hung child fails the stage
with code `AAS_CHILD_TIMEOUT` instead of blocking the run.

Child stdout is capped (`CHILD_JSON_LIMIT`) so a runaway tool cannot inflate
the run bundle. Captured stderr is clipped (`STDERR_LIMIT`) before it is
persisted with the stage record.

The decide stage runs on the first Python 3.11+ interpreter found, because
the locked Constitutional Agent Testbench declares `requires-python >= 3.11`.
Set `AAS_PYTHON` to use a specific interpreter; a missing interpreter or one
below 3.11 fails with an actionable message.

## Run bundle layout

Each invocation writes one atomic bundle under `.out/runs/<run-id>/`:

- `manifest.json`: stage status and component provenance
- `report.json`: user-facing run report
- `stages/<stage>.json`: captured output from each stage that ran

`.out/latest.json` is an atomic pointer to the most recent complete bundle.

## Provenance

The orchestrator resolves component provenance from `stack-lock.json` and the
checked-out `deps/` directories. Provenance is recorded on every run:
repository URL, commit, detached checkout flag, clean checkout flag, and
expected entrypoints present. The orchestrator never re-verifies the
components; the sibling CLIs and the rail's own verifier do that.

## Verify-only CI boundary

GitHub Actions in `.github/workflows/ci.yml` runs three jobs and nothing
else: `test` (unit suite plus syntax check plus GUI smoke), `integration`
(clean checkout bootstrap plus the integrator examples), and `browser`
(Playwright real-browser workflow tests). CI has no publish, deploy, push,
or release step. It does not write to any registry, package index, or
hosted target. `contents: read` is the only permission requested.

The same boundary holds locally: `npm test`, `npm run integration`,
`npm run example:review-handoff`, and `npm run test:browser` are read-only
with respect to anything outside `.out/`. The orchestrator writes only to
`.out/` for run bundles and to `.out/latest.json` for the latest pointer.