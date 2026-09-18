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

## Pull requests

- One branch, one focused change.
- Branch names: `imp/<short-topic>-<date>`.
- Ship via a pull request; do not push to `main` directly.
- Keep the orchestrator thin. If a change adds real behavior, it usually
  belongs in one of the three sibling repos, not here.

## Local checks

```bash
npm test
npm run integration
npm run example:review-handoff
```

`npm run test:browser` requires Playwright Chromium:

```bash
npx playwright install chromium
npm run test:browser
```

## What not to contribute here

- Real connectors, real secrets, real payment or merchant integrations.
- Changes that would read or write private repositories.
- Policy or rail rules that should live in their owning library.