# Contributing

Agent Action Stack is a thin orchestrator wrapping three sibling repositories:

- [constitutional-agent-testbench](https://github.com/EauDoon/constitutional-agent-testbench) (decide)
- [consequence-rail](https://github.com/EauDoon/consequence-rail) (act)
- [mandatebound](https://github.com/EauDoon/mandatebound) (prove)

All behavior lives in those libraries. This repo only sequences them and
records run bundles. Contributions here should preserve that boundary.

## Cross-repo coordination

`stack-lock.json` (schema `agent-action-stack.lock/v1`) pins each sibling to
one reviewed commit plus its expected entrypoints. `npm run bootstrap` checks
out those exact commits, rejects substituted or dirty pre-existing
directories, runs `npm ci --ignore-scripts` where declared, and runs each
component's explicit build command.

Changing a pinned component is a coordinated change:

1. Land the upstream change in the sibling repo first.
2. Bump the matching `commit` in `stack-lock.json` here.
3. Update `expected_entrypoints`, `post_build_entrypoints`, `install`, or
   `build` only if the sibling's published contract actually changed.
4. Run `npm run integration` to prove the new pin still composes from a clean
   checkout.

Do not bypass the lockfile. Editing `deps/` directly, swapping a remote URL,
or relaxing the dirty-checkout rejection are all out of scope for normal
contributions.

## Versioning and changelog

`package.json` `version` is the single source of truth. `npm run
check:version` (part of `npm run check` and CI's test job) fails when
`package-lock.json`, `CHANGELOG.md`, `docs/release-readiness.md`, or a release
tag disagrees with it.

- Feature and fix pull requests add one bullet under the matching category
  of the existing `## [Unreleased]` section (Added, Changed, Deprecated,
  Removed, Fixed, or Security; each at most once per section). They do not
  bump the version.
- Prefix a breaking change with `BREAKING:`. The project is pre-1.0, so a
  breaking change or a new feature takes a minor bump and a fix a patch.
- A release pull request runs `npm version X.Y.Z --no-git-tag-version
  --ignore-scripts`, renames `[Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, opens
  a new empty `## [Unreleased]` above it, and updates the link definitions at
  the bottom of the file. After it merges, the merge commit is tagged `vX.Y.Z`.

Cutting a release after the release pull request merges (with a merge
commit, so the reviewed commits stay on `main`):

1. `git fetch origin && git checkout main && git pull --ff-only`.
2. `node scripts/check-version.mjs --tag vX.Y.Z` must print `consistent`.
3. `git tag -a vX.Y.Z -m "Agent Action Stack X.Y.Z"` and
   `git push origin vX.Y.Z`.
4. The tag push runs `.github/workflows/release.yml`, which re-verifies the
   tagged commit and publishes the GitHub Release from the CHANGELOG section.
   Confirm with `gh run list -w release.yml -L 1` and `gh release view vX.Y.Z`.

Never move or delete a pushed tag. If a release is wrong, fix it forward in
the next patch version. Nothing is published to npm.

## Pull requests

- One branch, one focused change.
- Branch names: `imp/<short-topic>-<date>`.
- Ship via a pull request; do not push to `main` directly.
- Work through the checklist in `.github/PULL_REQUEST_TEMPLATE.md`, which
  GitHub fills into every new pull request.
- Keep the orchestrator thin. If a change adds real behavior, it usually
  belongs in one of the three sibling repos, not here.

## Local checks

```bash
npm run check
npm run integration
npm run example:review-handoff
```

`npm run check` is the unit suite (`npm test`) followed by the syntax gate
(`npm run check:syntax`), which parses every tracked JavaScript module.
`.gitattributes` keeps every text file LF, including on Windows checkouts.

`npm run test:browser` requires Playwright Chromium:

```bash
npx playwright install chromium
npm run test:browser
```

## What not to contribute here

- Real connectors, real secrets, real payment or merchant integrations.
- Changes that would read or write private repositories.
- Policy or rail rules that should live in their owning library.