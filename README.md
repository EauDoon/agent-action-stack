# Agent Action Stack

**One reference path across three public libraries: decide, act, prove.**

Agent Action Stack is a thin orchestrator. It does not re-implement the libraries. It runs them in a fixed order so a visitor can see how they compose.

![Reference workflow from policy evaluation through recourse-gated action and outcome verification, with an optional dispute evidence simulation. Policy failure stops execution.](.github/assets/project-overview.svg)

On policy failure the stack stops. On a clean `settled` outcome, MandateBound is skipped unless you pass `--dispute`.

> Experimental reference demo. Not legal advice, not a hosted service, not a safety certification.

## Libraries used

| Stage | Public repo | Role in this demo |
| --- | --- | --- |
| Decide | [constitutional-agent-testbench](https://github.com/EauDoon/constitutional-agent-testbench) | Evaluate refund-authorization JSON against a declared policy |
| Act | [consequence-rail](https://github.com/EauDoon/consequence-rail) | Reserve recourse, execute a synthetic refund, settle or compensate |
| Prove | [mandatebound](https://github.com/EauDoon/mandatebound) | Run a dispute-oriented evidence simulation when the rail outcome needs review |

## Requirements

- Node.js 22.12+ (the full-stack workflow shares the pinned MandateBound
  floor; Node.js 20 is not supported for any workflow, standalone or
  full-stack)
- Python 3.11+ (stdlib only; no pip install required for the testbench)
- git
- network access once, for `npm run bootstrap` (clones the three public repos into `deps/`)

Private repositories are never cloned or modified.

## Quick start

```bash
npm run bootstrap
npm run demo
```

Expected human output (pass path, no fault):

```text
stack: agent-action-stack
response: pass
decide: passed
decide_passed: true
act: passed
act_outcome: settled
act_state: CLOSED
act_fault: none
prove: skipped
prove_scenario: none
prove_triggered_by: none
prove_mode: none
flow: decide -> act
bundle: .out/runs/<run-id>
```

Fail closed at decide:

```bash
npm run demo:fail
```

Force the dispute path via a compensated rail outcome:

```bash
npm run demo:dispute
```

Expected flow line:

```text
flow: decide -> act -> prove
```

Review the same case instead of simulating one:

```bash
node ./bin/aas.mjs demo --fault duplicate --prove rail
```

The rail-review path persists the act-stage rail bundle, verifies it with the
rail's own verifier, and binds it into a MandateBound review record for the
same action id and digests. The review records the rail's verdict without
re-verifying rail signatures, source truth stays unknown, and legal effect
stays not determined: a recorded review proves the handoff, not the rail's
claims.

JSON report:

```bash
node ./bin/aas.mjs demo --fault duplicate --json
```

Export a run and replay its verification offline, without rerunning the
action:

```bash
node ./bin/aas.mjs demo --fault duplicate --prove rail
node ./bin/aas.mjs export "$(ls -t .out/runs | head -1)" --out case.json
node ./bin/aas.mjs replay case.json
```

Replay recomputes the evidence digest, re-runs the rail's own bundle
verification over the exported bytes, and re-executes the MandateBound
review, requiring a byte-identical review digest. It reports unavailable
evidence, conflicts, and unsupported verification explicitly, and exits
nonzero unless every check passes. Trust basis: the rail's synthetic demo
keys via its own verifier; nothing embedded in the bundle is trusted for
its own integrity. An exported case can also be imported in the GUI
("Replay an imported case"), which runs the same verification with no
action execution or remediation; imported identity is untrusted text and
the result proves no provenance or link to a local run.

## Reproducibility and run bundles

`stack-lock.json` records the reviewed public repository URLs, exact commits, and
expected entrypoints. Bootstrap uses detached checkouts, rejects substituted or
dirty pre-existing directories, runs `npm ci --ignore-scripts` for MandateBound,
then runs its explicit build command.

Each decide, act, and prove child is bounded by `AAS_CHILD_TIMEOUT_MS`
(default 30000). A hung child fails the stage instead of blocking the run.
Empty `AAS_CHILD_TIMEOUT_MS` and `AAS_GUI_PORT` values keep those defaults;
invalid integers are rejected.

The decide stage runs on the first Python 3.11+ interpreter found, because the
locked testbench declares `requires-python >= 3.11`. Set `AAS_PYTHON` to use a
specific interpreter; a missing interpreter, or one below 3.11, fails with an
actionable message instead of an unreadable traceback.

Each invocation writes one atomic bundle under `.out/runs/<run-id>/`:

- `manifest.json`: stage status and component provenance
- `report.json`: user-facing run report
- `stages/*.json`: output from stages that ran

`.out/latest.json` is an atomic pointer to the most recent complete bundle. A
failed or skipped stage cannot leave an older stage artifact looking current.

List runs newest-first with `aas runs`, inspect bounded case summaries with
`aas cases` (outcome, policy reference, review verdict, evidence digest, and
component revisions — never raw evidence), and compare two cases with
`aas compare <run-id> <run-id>`, which classifies the pair as identical,
different, or not comparable and lists the fields that differ. Comparison
states that differences do not establish causation and that matching
metadata does not prove matching evidence; it never mutates a case.

Remove oldest runs beyond a window with `aas prune --keep <n>` (`--dry-run`
previews). Pruning never deletes the run the latest pointer identifies, and
nothing is deleted without an explicit `--keep`. The GUI exposes the same
history and comparison through `Load history` and `Compare selected cases`.

## Guided local GUI

Run `npm run gui` and open the printed loopback URL. The GUI calls the same
orchestrator, shows a readable decide/act/prove summary with skip reasons, a
bindings panel (action identity, recomputed evidence digest, provenance, and
the review verdict with its limits), and downloads a JSON export of the
selected run bundle. The prove selector offers the canned simulation or the
same-case rail review; every result and export stays tied to its run id.
`npm run gui:smoke` checks the server without
starting a long-running process. The server binds only to `127.0.0.1` on port
8787 by default (`AAS_GUI_PORT` selects another loopback port), requires the
exact loopback Host and same-origin boundary, and uses POST for a run.

## Tests

```bash
npm test
npm run check
```

`npm test` is the unit suite (orchestrator and GUI models). `npm run
integration` proves the pinned components from a clean checkout, and
`npm run example:review-handoff` runs the integrator example.

Real browser workflow tests drive the GUI through actual clicks, file
selection, and asynchronous responses with Playwright (Chromium only, to
keep downloads bounded):

```bash
npm install
npx playwright install chromium
npm run bootstrap
npm run test:browser
```

They cover run → inspect → export → import → replay, refusal, repeated
runs, stale-result clearing, and malformed/unavailable/tampered imports.
Browser artifacts are written to `test-results/` and `playwright-report/`
(both ignored). Browsers cache under `~/.cache/ms-playwright`.

## Fixtures

- `fixtures/policy.json`: refund gate: accept, low/moderate risk, recourse required, not blocked
- `fixtures/response.pass.json`: passes the gate
- `fixtures/response.fail.json`: fails the gate; act and prove are skipped

## Design bounds

- Orchestration only. Behavior lives in the three libraries.
- Synthetic connectors and scenarios only.
- MandateBound’s prove step uses `simulate --scenario operator` as the dispute-oriented demo path. Full AP2 pack assemble/verify remains in MandateBound’s own CLI and docs.
- This repo does not read or write any private GitHub repositories.

## License

Apache-2.0

## Synthetic action domains

`--domain` selects the synthetic action domain; both use the same rail,
recourse, and review machinery:

- `refund` (default): the documented refund scenario.
- `inventory`: a bounded synthetic inventory allocation that reserves a
  declared quantity of one synthetic SKU for one synthetic order; its
  pre-reserved remedy reverses only the allocation bound to the action.

```bash
node ./bin/aas.mjs demo --domain inventory --fault duplicate --prove rail
```

Both domains keep their own policy fixture and their own remedy scope field
(`max_amount_minor` for refunds, `max_quantity` for allocations), so neither
is disguised as the other. Everything remains synthetic: no warehouse,
merchant, payment, or external provider integration is involved, and a
recorded review proves the handoff rather than any real-world reversibility.
