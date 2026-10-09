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

The decide stage evaluates a response fixture. Its pass gates whether the act
stage runs, but it is not a signed authorization over the rail proposal. The
act stage constructs its own synthetic action inside the rail demo. Same-case
binding begins with that rail bundle and its subsequent review and replay.

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

- `manifest.json`: stage status, component provenance, and the orchestrator
  version that wrote it (`stack_version`, null in bundles that predate it)
- `report.json`: user-facing run report, which carries the same
  `stack_version`
- `stages/<stage>.json`: captured output from each stage that ran

`.out/latest.json` is an atomic pointer to the most recent complete bundle.

## Provenance

The orchestrator resolves component provenance from `stack-lock.json` and the
checked-out `deps/` directories. Provenance is recorded on every run:
repository URL, commit, detached checkout flag, clean checkout flag, and
expected entrypoints present. The orchestrator never re-verifies the
components; the sibling CLIs and the rail's own verifier do that.

## CI and release boundary

`.github/workflows/ci.yml` stays verify-only. It runs on pushes to `main` and
on pull requests, requests only `contents: read`, and has three jobs: `test`
(unit suite, syntax gate, version consistency check, GUI smoke), `integration`
(clean checkout bootstrap plus the integrator examples, including one Python
3.11 leg), and `browser` (Playwright real-browser workflow tests). It has no
publish, deploy, push, or release step.

`.github/workflows/release.yml` runs only when a `vX.Y.Z` tag is pushed. Its
single job re-runs `npm run check` and the integration proof on the tagged
commit, confirms with `scripts/check-version.mjs --tag` that the tag,
`package.json`, `package-lock.json`, and `CHANGELOG.md` agree, and creates a
GitHub Release whose notes are that version's CHANGELOG section. That job
alone holds `contents: write`, restores no cache, and keeps the checkout
token out of `.git/config`. It never publishes to a package registry, and
`package.json` is `"private": true`, so `npm publish` refuses the package.

`.github/dependabot.yml` only opens pull requests for GitHub Actions and npm
updates; they pass through the same CI and are merged by hand.

## Local write targets

Local verification does write files. Use a disposable checkout for integration
and browser tests. The commands do not publish, deploy, or operate real accounts.

| Command | Local writes |
| --- | --- |
| `npm ci --ignore-scripts` | Root `node_modules/` and npm's configured cache/log directory |
| `npm run bootstrap` | Pinned public clones under `deps/`, MandateBound `node_modules/` and `dist/`, and npm cache/log files |
| `aas demo`, GUI **Run stack**, integrator examples | `.out/runs/`, `.out/latest.json`, temporary handoff directories under the OS temporary directory, and Python bytecode caches under `deps/constitutional-agent-testbench/src/constitutional_agent_testbench/__pycache__/` unless bytecode writing is disabled |
| `npm test`, `npm run gui:smoke` | Test fixtures, temporary case stores, and child-process scratch files under the OS temporary directory where needed |
| `npm run integration` | Root install, dependency bootstrap/build, the demo writes above (including Python bytecode), and temporary copied verifier runtimes; invokes npm and Git |
| Playwright install and `npm run test:browser` | Configured browser cache, `test-results/`, `playwright-report/`, temporary test case stores, and the GUI **Run stack** writes above (including `.out/` and Python bytecode) |
| `aas runs`, `cases`, `compare`, `inspect`, `latest` | Read saved cases only; shell redirection can write the printed report |
| `aas replay`, `verify`, GUI verification | Read the case store or import, write temporary verifier inputs, and remove scratch files afterward; do not execute an action or alter saved cases |
| `aas export --out` | Writes the named export; existing files require explicit `--overwrite` |
| `aas prune --keep` | Deletes eligible old runs under the selected output root; `--dry-run` previews without deletion |

Saved-case commands honor `--root`. npm and Playwright honor their own cache
configuration, and temporary directories use the operating system's configured
temporary location. Interrupted processes can leave temporary files behind.
