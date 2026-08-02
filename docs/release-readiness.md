# Release readiness

This checklist describes the evidence required before a public versioning update.

## Source and dependency gates

- [ ] Review the final raw tree and changed-file list.
- [ ] Confirm `stack-lock.json` still contains the approved public URLs and commits:
  - Constitutional Agent Testbench: `a7a51907eaaab68a52b66edef28b3ee0fcb3ff97`
  - Consequence Rail: `d1bacc66618591231270902b657ffaa752954ee6`
  - MandateBound: `468fce7e0d4dcc1e86bad07a469b3d9217914bb0`
- [ ] Run bootstrap from a clean workspace and verify detached, clean, exact dependency checkouts.
- [ ] Confirm no private repository, credential, or production endpoint is referenced.

## Quality gates

- [ ] `npm ci --ignore-scripts` completes on Windows and Ubuntu.
- [ ] `npm test` passes with lock mismatch, stale dependency, stage, child-process, and atomic-write coverage.
- [ ] `npm run gui:smoke` passes.
- [ ] The public-copy scanner reports no punctuation or secret findings.
- [ ] The final tree contains no placeholders or generated dependency directories.

## Publication boundary

This document is a readiness checklist, not a publication approval. A separate
exact-tree, metadata, and remote verification approval is required before any
commit or GitHub mutation.
