# Release readiness

This checklist describes the evidence required before a public versioning update.

## Source and dependency gates

- [ ] Review the final raw tree and changed-file list.
- [ ] Confirm `stack-lock.json` still contains the approved public URLs and commits:
  - Constitutional Agent Testbench: `16b2faa71b0f92b9afa15b13afad8c48da8132f4`
  - Consequence Rail: `64cb304381006c69a03ec375da7b192122b463db`
  - MandateBound: `3682a242e3add6bea2ef0157be75112b83a4cbf9`
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

## Publication boundary

This document is a readiness checklist, not a publication approval. A separate
exact-tree, metadata, and remote verification approval is required before any
commit or GitHub mutation.
