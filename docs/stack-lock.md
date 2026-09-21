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
2. If absent, bootstrap clones the public URL at the pinned commit, checks
   out detached, and verifies the entrypoints.
3. For components with an `install` hook, bootstrap runs the declared
   command (`npm ci --ignore-scripts` for MandateBound).
4. For components with a `build` hook, bootstrap runs the declared command
   (`npm-run-build` for MandateBound), then verifies post-build entrypoints.
The orchestrator records each component's provenance on every run bundle. A
run resolving components whose checkout disagrees with the lock surfaces the
disagreement in its manifest.

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
Security fixes follow the same path. The schema version (`schema_version`)
is bumped only when the shape changes in a way that requires loader
changes; existing tools keep reading older versions until the bump lands
across all consumers.

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