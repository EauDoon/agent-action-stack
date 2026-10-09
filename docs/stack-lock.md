# stack-lock.json policy

`stack-lock.json` is the single source of truth for which versions of the
three sibling libraries the orchestrator is allowed to compose. Schema:
`agent-action-stack.lock/v1`. It pins each sibling's public URL, exact
reviewed commit, expected entrypoints, and where applicable the build hooks.

## What it pins

One record per sibling. The current lock has three:

- `constitutional-agent-testbench` (decide). Public URL, one reviewed
  commit. Expected entrypoints `pyproject.toml` and
  `src/constitutional_agent_testbench/cli.py`. No install or build step.
- `consequence-rail` (act). Public URL, one reviewed commit. Expected
  entrypoints `package.json` and `cmd/crctl.js`. No install or build step.
- `mandatebound` (prove). Public URL, one reviewed commit. Expected
  entrypoints `package.json`, `package-lock.json`, `src/cli.ts`. Post-build
  entrypoint `dist/cli.js`; `install` hook `npm-ci`; `build` hook
  `npm-run-build`. Bootstrap runs `npm ci --ignore-scripts` then the build.
The lock also pins, by construction, the public-only origin: every record
points at the public EauDoon GitHub repo. Substituting a private URL or
editing `deps/` directly is out of scope.

## How the lock is enforced

`scripts/bootstrap.mjs` loads the lock, asserts the full-stack Node version,
and prepares each dependency under `deps/`:

1. If `deps/<component>` is present, `inspectDependencyDirectory` verifies it
   is a regular directory, detached (`HEAD` matches the pinned commit
   exactly), clean, and contains every expected entrypoint. Substituted or
   dirty pre-existing directories are rejected.
2. If absent, bootstrap clones the public URL at the pinned commit into a
   hidden staging directory beside it (`deps/.tmp-` plus six characters,
   shorter than any component name so Windows path limits are no tighter than
   for the final checkout), checks out detached, and only then moves it to
   `deps/<component>` and verifies the entrypoints. A failed fetch removes the
   staging directory, so a network error never leaves a half-initialized
   repository that the next bootstrap would refuse. A process killed mid-clone
   can leave only a hidden staging directory, which is safe to delete and does
   not block the next run.
3. For components with an `install` hook, bootstrap runs the declared
   step (`npm-ci`, which runs `npm ci --ignore-scripts`, for MandateBound).
4. For components with a `build` hook, bootstrap runs the declared step
   (`npm-run-build` for MandateBound), then verifies post-build entrypoints.
   Both hook fields accept only those exact tokens; `loadComponentLock` rejects
   any other value rather than skipping the step, because a silently ignored
   hook would report a successful bootstrap for an unprepared component.
The orchestrator records each component's provenance on every run bundle. A
checkout that disagrees with the lock (origin, commit, detached state, local
changes, or entrypoints) stops the run before any stage and writes no bundle,
so recorded provenance always shows detached, clean, pinned checkouts.

## When to update

Changing a pinned component is a coordinated cross-repo change. Do not bump
the lock on its own.

1. Land the upstream change in the sibling repo first; it must pass that
   sibling's own CI and review.
2. Bump the matching `commit` field to the reviewed merge SHA.
3. Update `expected_entrypoints`, `post_build_entrypoints`, `install`, or
   `build` only if the sibling's published contract actually changed.
4. Run `npm run integration` locally on Ubuntu and Windows. The CI
   integration job runs the same proof on every push and pull request.
5. Update the pin list in `docs/release-readiness.md` in the same pull
   request. `npm run check:version` fails while that list is missing a
   locked commit.
Security fixes follow the same path. The schema version (`schema_version`)
is bumped only when the shape changes in a way that requires loader
changes; existing tools keep reading older versions until the bump lands
across all consumers.

The integration proof also runs `test/component-compatibility.test.mjs` against
the prepared components. It checks canonical bytes independently of producer
round trips, both currency validation boundaries, and refusal of re-signed
synthetic evidence whose currency contradicts the proposal. The historical
`fixtures/legacy-rail-review.json` was exported using Rail `6c61e9f` and
MandateBound `e526c4c`; it pins replay compatibility for an ordinary synthetic
refund. `fixtures/previous-pins-inventory-review.json` was saved by `main` at
`8179e59` using Rail `c430383` and MandateBound `708256d`, the pins before the
0.3.0 refresh; it pins replay compatibility for a compensated inventory case
already in a case store. Their public demonstration signatures establish no
real-world provenance.

The current Rail pin also binds a receipt's close time to its terminal event,
so a clock advancing between reads still produces evidence that survives the
same-case handoff and replay. The MandateBound pin rejects weak Ed25519 keys in
caller-pinned CasePack checkpoint trust snapshots using its existing strict key
validator. Ordinary valid evidence retains the same format; neither update
rewrites old artifacts.

Since 0.3.0 the pins are the component releases of 2026-10-09: Consequence Rail
0.3.0, MandateBound 2.0.0, and Constitutional Agent Testbench 0.6.0, each at
its release merge commit. Rail 0.3.0 also binds a receipt's outcome and
configured postcondition result to the terminal `CLOSED` event for every bundle
profile, and a receipt-profile `closed_at` to that event's time within 1000 ms,
so receipts from Rail 0.2.20 and earlier still verify. MandateBound 2.0.0 is a
major release for its CLI and package API, but the `simulate` and `review`
commands the stack runs, the review record, and engine `1.0.0` are unchanged,
so a same-case review recorded under either the previous or the current pins
replays under the other. Testbench 0.6.0 adds `--version`, command help, and
Apache-2.0 package metadata; `evaluate` and its Python 3.11 floor are
unchanged. No entrypoint or hook in the lock changed.

An older artifact with numeric-looking object keys may contain signatures made
with the former Rail canonical ordering. The current verifier does not try that
obsolete ordering after verification fails. Preserve the original artifact and
its recorded producer revision for historical inspection; do not rewrite its
signatures or describe a newly generated case as the same evidence. A successful
legacy fixture replay establishes compatibility for that fixture, not every
previously accepted artifact or an alternate canonical profile.

The MandateBound pin also corrects U+2028/U+2029 bytes under its existing
RFC8785 profile. Legacy proofs containing those separators can fail current
integrity checks. Keep original bytes and the exact producer commit for
historical replay; version labels alone do not identify the affected behavior.
There is no alternate-byte verification or automatic migration. Follow the
[producer's compatibility guidance](https://github.com/EauDoon/mandatebound/blob/b51fe137958afe26eee052c5a129e5481ccae560/docs/PROTOCOL.md)
before reissuing affected artifacts.

## Who can update

The lock is owned by the Agent Action Stack maintainers. Updates land via
pull request on `imp/<short-topic>-<date>` branches. PRs that change
`stack-lock.json` must cite the sibling repo, PR, and reviewed merge SHA;
show a passing `integration` job on both Ubuntu and Windows; and show a
passing `test` job (lock-load and dependency helpers live in the unit
suite).
Do not bypass the lockfile. Editing `deps/` directly, swapping a remote
URL, or relaxing the dirty-checkout rejection are out of scope. A PR that
needs any of those should propose a permanent fix in `scripts/bootstrap.mjs`
or in this policy document.

## What is out of scope

Real connectors, real secrets, real payment or merchant integrations;
changes that would read or write private repositories; policy or rail
rules that should live in their owning library. The lock pins reviewable
public artifacts. Anything else belongs in the sibling that owns it.
