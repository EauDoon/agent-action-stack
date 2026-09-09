# Release readiness

This checklist describes the evidence required before a public versioning update.

## Source and dependency gates

- [ ] Review the final raw tree and changed-file list.
- [ ] Confirm `stack-lock.json` still contains the approved public URLs and commits:
  - Constitutional Agent Testbench: `16b2faa71b0f92b9afa15b13afad8c48da8132f4`
  - Consequence Rail: `89811e423a1a41bad3ecb77e18ebf557615219f8`
  - MandateBound: `e526c4c32ac61571757a98ca1a69189821c3dce7`
- [ ] Run bootstrap from a clean workspace and verify detached, clean, exact dependency checkouts.
- [ ] Confirm no private repository, credential, or production endpoint is referenced.

## Quality gates

- [ ] `npm ci --ignore-scripts` completes on Windows and Ubuntu.
- [ ] `npm test` passes with lock mismatch, stale dependency, stage, child-process, and atomic-write coverage.
- [ ] `npm run gui:smoke` passes.
- [ ] `npm run integration` passes on Ubuntu and Windows (Node.js 22.12.0 and 24, Python 3.13).
- [ ] The public-copy scanner reports no punctuation or secret findings.
- [ ] The final tree contains no placeholders or generated dependency directories.

## Integration evidence, 2026-09-06 candidate

Candidate: this branch at the pin-update commit (`chore/update-stack-pins-202609`;
orchestrator base `a0e25144aaebff2885b67eb6b5b355c37a167f37`). Component pins
are the reviewed merge SHAs above: testbench PR #20 (`16b2faa7`), rail PR #20
(`64cb30`, includes the unknown-recourse receipt-refusal fix), MandateBound PR
#26 (`3682a24`, includes the fast-uri advisory fix). No component was upgraded
past its reviewed merge; the rail SHA supersedes the earlier `7cf59e79`
reference because it contains the new contract fix.

Runtimes used: Node.js v26.7.0 and v22.23.2 (macOS arm64), Python 3.13.15 for
the decide stage, system Python 3.9.6 for negative selection tests.
Orchestrator requirements stay Node.js 20+ and Python 3.11+; the built
MandateBound artifact targets ES2022 (runnable on Node.js 20+) while its own
build gate stays Node.js 22.12+ per its repository.

Clean-checkout proof (`/tmp/aas-clean`, fresh clone, no `deps/`, `dist/`, or
`.out/`; bootstrap from the committed lockfile only):

- `npm ci --ignore-scripts`: clean.
- `npm run bootstrap`: all three checkouts detached, clean, zero tracked
  modifications, HEAD equal to the pinned full SHA; remotes are the three
  public `EauDoon` repository URLs; MandateBound `npm ci` reports
  0 vulnerabilities and its `tsc` build produces `dist/cli.js`.
- `npm test`: 51 passed, 0 failed (includes the lock-provenance fixture that
  asserts the three pins above).
- `npm run gui:smoke`: passed.
- `node ./bin/aas.mjs demo`: pass path, `decide passed`, `act settled`,
  `CLOSED`, `flow: decide -> act`; bundle records stage artifacts plus
  component provenance at the exact pins (detached, clean).
- `node ./bin/aas.mjs demo --response fail`: policy refusal; `decide failed`,
  act and prove skipped; fail bundle contains only `stages/decide.json`, so no
  older stage artifact leaks across runs.
- `node ./bin/aas.mjs demo --fault duplicate`: `act compensated`,
  `prove passed` with scenario `operator`, `flow: decide -> act -> prove`.
- Python selection: with only Python 3.9 visible, the run stops before any
  stage with `decide stage requires Python 3.11+ ... found python3 is Python
  3.9, ...`; `AAS_PYTHON=/usr/bin/python3` is rejected with the same actionable
  message; exit code 1 with no bundle written.
- Same demo also passes under Node.js v22.23.2.

Component suites at the pinned revisions:

- constitutional-agent-testbench `16b2faa7`: `python -m unittest discover -s
  tests` with Python 3.13, 120 passed.
- consequence-rail `64cb304`: `npm run check`, 142 passed, including the three
  unknown-recourse regression tests (also rerun inside the pinned
  `deps/consequence-rail` tree: 3 passed).
- mandatebound `3682a24`: `npm run verify` exit 0; 220 passed; coverage lines
  93.80 against threshold 90, functions 98.14 against threshold 90, branches
  87.85 against threshold 85; license check 12 packages, dependency check
  12 packages, package check 98 files.

Cross-repository CI and review references for the pinned merges: rail PR #20
(ubuntu and windows, Node 20/22/24, plus review), testbench PR #20 (ubuntu and
windows, Python 3.11 through 3.14, plus review), MandateBound PR #26 (Node
22.12.0 and 24.18.0, plus review), stack PR #16 (ubuntu and windows, Node
20/22, plus review). Node 20/24 and Windows runs are covered by that CI; local
macOS smoke covered Node 26 and 22.

Prove-stage boundary: the prove stage runs MandateBound
`simulate --scenario operator` on synthetic material (`case-synthetic`,
`legalEffect: "not-determined"`). A passing prove stage does not verify the
rail case and claims no evidence handoff or binding to the rail bundle.

## Integration evidence, Node-floor candidate (PR #18, merged `1f6577d`)

Component pins unchanged from the 2026-09-06 candidate above. This candidate
adds the Node.js 22.12.0 full-stack floor (bootstrap, CLI demo, and GUI run
preflight with actionable messages and injectable versions for tests),
reconciled README, CLI help, and `engines`, plus the committed
`scripts/integration-check.mjs` proof and integration CI.

Unit-test coverage (existing suites, no dependency checkouts): stack
`npm test` 57/57, including 6 new Node-floor boundary tests and 1 new GUI
rejection test.

Full-stack coverage (real integration, distinct from unit coverage): clean
install, bootstrap of the committed pins, exact-SHA and clean-tree
assertions, entrypoint checks, and pass, policy-refusal, and
compensated/dispute demo runs with structured-outcome, stage-gating, and
stale-artifact assertions, ending with the synthetic operator-simulation
boundary.

Job references: PR head run 34007181438 (4 unit jobs and 4 integration jobs
across Ubuntu and Windows on Node.js 22.12.0 and 24 with Python 3.13, plus
review, all passing) and post-merge main run 34007299058 (all 8 CI jobs
passing). Post-merge main `1f6577d` was additionally verified with a fresh
local clone running `npm run integration` to exit 0.

## Integration evidence, rail-review candidate (PR #20, merged `b1861590`)

Component pins: testbench `16b2faa7` and rail `64cb304` unchanged;
MandateBound moves to `06d3c93` (PR #27, `review` command). This candidate
adds the opt-in `--prove rail` path: the act stage persists the rail
settlement bundle, the prove stage verifies those bytes with the rail's own
`bundle verify`, and MandateBound `review` binds them into a deterministic
record for the same action id and digests. The default `--prove simulate`
path is unchanged.

Unit-test coverage: stack `npm test` 66/66 (9 new rail-handoff tests plus 1
new GUI prove-param test); mandatebound `npm run verify` exit 0, 228/228
(8 new review tests), coverage thresholds hold.

Full-stack coverage: `npm run integration` exit 0 on a clean tree, now also
exercising `demo --fault duplicate --prove rail` with digest recomputation
(review `evidenceDigest` recomputed from the persisted bundle bytes),
`review_verdict: recorded`, `legalEffect: not-determined`, and
prove/act/dispute artifact assertions. Post-merge main `b1861590` was
verified with a fresh local clone running `npm run integration` to exit 0.

Prove-stage boundary, updated: simulate mode runs the synthetic operator
scenario (no rail-case verification, as before); rail-review mode records a
handoff binding (same action id and digests, caller-asserted upstream
verdict) without re-verifying rail signatures, without establishing source
truth, and without legal effect. Neither mode relabels rail artifacts as
AP2/UCP evidence.

Job references: mandatebound PR #27 (Node 22.12.0 and 24.18.0, plus
review); stack PR #20 (4 unit jobs and 4 integration jobs across Ubuntu and
Windows on Node.js 22.12.0 and 24 with Python 3.13, plus review, all
passing on the head revision).

## Integration evidence, capability-declaration pin (PR #22, merged `58d1f46`)

Component pins: testbench `16b2faa7` and rail `64cb304` unchanged;
MandateBound moves to `e526c4c` (PR #28, conformance declaration for the
`review` command; no behavior change to any integrated path). Post-merge
main `58d1f46` was verified with a fresh local clone running
`npm run integration` to exit 0 across pass, refusal, dispute, and
rail-review paths.

## Integration evidence, audit-ordering pin (PR #24, merged `cc952ab`)

Component pins: testbench `16b2faa7` and mandatebound `e526c4c` unchanged;
Consequence Rail moves to `89811e4` (PR #21, audit-before-mutation on every
lifecycle path; behavior-compatible for all previously valid flows). The
stack suite stands at 66/66 and the rail suite at 150/150. Post-merge main
`cc952ab` was verified with a fresh local clone running
`npm run integration` to exit 0 across pass, refusal, dispute, and
rail-review paths.

## Integration evidence, capability batch (GUI review workspace, portable replay, integrator example)

Component pins unchanged (`16b2faa7` / `89811e4` / `e526c4c`); no contract
changes since the audit-ordering pin. Covered merges: stack PR #26 (GUI
prove-mode selector, summary, bindings, run-id isolation), PR #27
(`export`/`replay` with six explicit checks), PR #28 (runnable integrator
example in pass and refusal modes).

Unit-test coverage: stack suite 81/81. Full-stack coverage: `npm run
integration` plus the integrator example in both modes, on Ubuntu and
Windows with Node.js 22.12.0 and 24 and Python 3.13. Post-merge mains for
each merge were verified with fresh local clones running
`npm run integration` to exit 0; the replay round-trip and the GUI rail
path were additionally exercised live against real child processes.

## Integration evidence, review-workspace batch (GUI #26, replay #27, example #28, settled-review #30)

Component pins unchanged (`16b2faa7` / `89811e4` / `e526c4c`); no contract
changes. The GUI gained a prove-mode selector, a readable summary, a
bindings panel with recomputed digests, run-id isolation, and export
parity with the CLI. Portable `export`/`replay` reproduce verification
offline with six explicit checks. The runnable integrator example covers
pass and refusal modes. The integration proof additionally covers forced
review of a settled act.

Unit-test coverage: stack suite 81/81. Full-stack coverage: `npm run
integration` plus the integrator example in both modes, on Ubuntu and
Windows with Node.js 22.12.0 and 24 and Python 3.13. Post-merge mains
were verified with fresh local clones running `npm run integration` to
exit 0; the replay round-trip, the GUI rail path, and the settled-review
path were exercised live against real child processes. No browser
harness exists in this repository; DOM event dispatch is covered through
a stub-DOM test of the real page script.

## Integration evidence, review-workspace and domain batch

Component pins: testbench `16b2faa7` and mandatebound `e526c4c` unchanged;
Consequence Rail at `6c61e9f` (inventory-allocation domain, PR #22). This
batch covers the GUI review workspace (PR #26), portable replay (PR #27),
the integrator example (PR #28), settled-review integration coverage
(PR #30), case history and comparison (PR #35), the inventory domain in the
stack (PR #36), the integrator extension guide and connector conformance
example (PR #37), and the pending run-lifecycle and replay-stdin entries
from PRs #32 and #33.

Unit-test coverage: stack suite 107/107; consequence-rail 162/162;
mandatebound 228/228; testbench 120/120. Full-stack coverage: `npm run
integration` (pass, refusal, dispute, settled-review, rail-review, and
inventory paths plus export/replay and history/compare), the integrator
example and connector-conformance example, and 10 real browser workflow
tests, on Ubuntu and Windows with Node.js 22.12.0 and 24 and Python 3.13.

Browser tests are a distinct category from component and orchestrator unit
tests: they drive real clicks, file selection, and asynchronous responses
against the pinned components, and are the only evidence for UI behaviour.

## Publication boundary

This document is a readiness checklist, not a publication approval. A separate
exact-tree, metadata, and remote verification approval is required before any
commit or GitHub mutation.
