# Changelog

All notable changes to Agent Action Stack are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `aas --version` (also `aas version`, with `--json`) prints the orchestrator
  version from `package.json`. New runs record it as `stack_version` in
  `report.json` and `manifest.json`; `aas cases --json`, `aas inspect`, and
  the Markdown case review show it ("Orchestrator version"); and the GUI's
  `GET /api/health` returns it as `version`. The field is additive within the
  `agent-action-stack.run/v1` schema: cases saved before it was added load
  and verify unchanged and report it as unavailable. It is informational and
  is not one of the fields `aas compare` compares.
- `npm run check:version` (`scripts/check-version.mjs`), part of
  `npm run check` and CI's test job. It fails when `package-lock.json`, this
  changelog, the `docs/release-readiness.md` pin list, or a `--tag` disagree
  with the `package.json` version, and `--notes` extracts one release's
  section. It found and this change repairs two drifts: the lock still said
  0.2.0 after five patch bumps, and `[Unreleased]` carried three separate
  `### Changed` headings and a `compare/main...HEAD` link that compared
  nothing. `CONTRIBUTING.md` now describes the versioning and changelog
  rules.
- `CONTRIBUTING.md` describing cross-repo coordination and the
  `stack-lock.json` policy.
- `CHANGELOG.md` (this file).
- Playwright setup note in the Quick start section of `README.md`.

### Fixed
- `aas`, `aas-gui`, and `bootstrap` now run when launched through a link: an
  npm bin symlink, `npm link`, a macOS /tmp checkout, or a Windows junction.
  The entrypoint guard compared the realpathed module URL with the unresolved
  `process.argv[1]`, so a linked launch exited 0 without doing anything, and
  `npm run gui:smoke` through a link reported success without checking. The
  six scripts with a `#!/usr/bin/env node` line are now tracked as
  executable, so `./bin/aas.mjs` runs on a POSIX checkout.
- `aas demo` validates its options before it checks the runtime. With a broken
  `AAS_PYTHON`, a usage error such as `aas demo --bogus` exited 1 with the
  interpreter message, after up to seven interpreter probes, instead of the
  documented exit 2. `parseDemoOptions` now runs first, and `runDemo` uses
  the same parser, so the messages are unchanged.
- `aas export`, `verify`, `inspect`, and `latest` now report a missing saved
  case as `Saved case not found: <run-id>`, and a missing or unreadable file
  inside a case by its case-relative name. They printed the raw `ENOENT`
  error, including the absolute local path. The error code stays `ENOENT`,
  so the GUI's 404 responses are unchanged.
- After an act-stage error, `report.json` now records prove as skipped with
  reason `act_error`, matching `manifest.json`. The report kept its initial
  `not_reached`, so the GUI summary and the saved-case review disagreed about
  the same run. The GUI summary also labels the `act_failed` skip reason
  ("act failed") instead of printing the raw token.
- The workbench now reports run progress and failures in a visible status line
  under **Run stack** (`#run-status`, announced by screen readers): running,
  run not started (including the busy 503 and the `npm run bootstrap` hint
  when `deps/` is missing), request failed, finished with its flow, finished
  with a stage failure, and finished without a bundle. Those messages used
  to go only to the raw report inside a collapsed `<details>`, so a click on
  **Run stack** before bootstrapping appeared to do nothing. The raw report
  now holds only the run JSON.
- `npm run gui` now exits 1 with `Cannot listen on 127.0.0.1:<port>
  (EADDRINUSE). Set AAS_GUI_PORT to a free loopback port.` when the port is
  taken. It crashed with an unhandled `'error'` event and a stack trace.
- `GET /api/history` now answers a refused case store (a `runs` path that is
  not a regular directory) with HTTP 422, as `/api/compare` already did, and
  a worker failure with HTTP 500 `History could not be loaded.` instead of
  the generic `Request failed`. Its busy 503 now sends `Retry-After: 1`, like
  the run and replay routes.
- `npm run bootstrap` now clones each missing component into a hidden staging
  directory and moves it into `deps/<component>` only after checkout. A failed
  or interrupted first fetch used to leave a `.git` with an origin and no
  `HEAD` in the final directory, and every later bootstrap refused it with no
  way forward except deleting it by hand. A failure now removes the staging
  directory and says nothing was left; the refusal for an older
  half-initialized checkout names the directory to remove; a failed command
  now includes the tool's own error text; and bootstrap errors print
  `bootstrap failed: <reason>` instead of a stack trace.
- The review-handoff example now gates refunds on the stack's own policy,
  `fixtures/policy.json` (`aas-refund-gate-v1`, 6 rules), with the stack's
  response fixtures. It used the testbench checkout's 5-rule example policy,
  so step 1 did not demonstrate the gate that `aas demo` in step 6 applies.
  The example now fails if step 1 or the orchestrated run reports a policy
  other than the domain's gate.
- Saved-case review now includes persisted stage stderr. `aas inspect` and
  the Markdown review omitted the diagnostic that the run report already
  stored, so a failed act looked like it had no child output.
- `runAct` now rejects a domain other than `refund` or `inventory` before it
  spawns the rail CLI. Any other value was passed through as the demo
  command.
- An act result that explicitly reports `fault: null` is stored as null. The
  report used to replace that null with the requested fault, so a cleared
  fault was recorded as `duplicate` when `--fault duplicate` was passed.
- The integrator example now removes its scratch directory when decide fails
  or policy refuses the response. `process.exit` skipped the cleanup, so each
  failed run left an `aas-integrator-` directory behind.
- `aas inspect --root` now rejects a blank path, matching the other saved-case
  commands. A whitespace root used to be treated as a directory and failed
  with a filesystem error.
- The act stage now reads the rail bundle file with the same byte cap and
  symlink refusal as a saved case. The previous read followed a link and
  accepted a file larger than the child stdout cap.
- Bootstrap and provenance now refuse a `deps` directory that is a symlink.
  Checkout and later reads followed the link, so a planted `deps` link was
  accepted as the component root.
- Saved-case GUI paths with malformed percent-encoding now return HTTP 400.
  `decodeURIComponent` used to throw, and the request became HTTP 500.
- The workbench comparison panel now says the comparison is unavailable when
  the pair is not comparable. It previously said no compared field differs,
  which disagreed with the Markdown download for the same result.
- Comparison and case summaries now refuse a `runs` directory that is a
  symlink, matching list, export, and prune. The comparison path used to
  follow the link and read the target tree. The GUI compare route returns
  HTTP 422 for that refusal.
- Verify saved case now returns HTTP 422 when the saved case is structurally
  invalid, the same distinction inspect already makes with 404 and 422. The
  route used to report that failure as HTTP 500.
- Bootstrap now refuses a pre-existing dependency directory that is a symlink.
  `existsSync` follows the link, so a symlink whose git metadata matched the
  lock was accepted as the component checkout.
- Listing, export, and prune now refuse a `runs` directory that is a symlink.
  Those paths followed the link, so prune deleted runs in the target tree.
- `runCapture` no longer lets caller options enable a shell or replace the
  stdout cap. Those fields were applied before `...opts`, so `shell: true` or
  a larger `maxBuffer` overrode the limits. Timeout remains caller-set.
- `runDecide` now rejects a domain other than `refund` or `inventory`. Any
  other value used to load the refund policy and could report a pass for the
  wrong gate.
- `GET /api/compare` now sets `ok` to false when the pair is not comparable,
  matching `aas compare --json`. It previously reported `ok: true` for a
  missing or unreadable pair. The HTTP status stays 200 so the workbench can
  still render the classification.
- The GUI import endpoint now requires one JSON document. It used the child
  stdout parser, so a log line followed by an object was accepted and replayed.
- `persistRunBundle` now uses the same run-id rule as readers. The old check
  accepted `.`, `..`, and `...`, and `RegExp.test` stringified non-strings, so
  a run id of `..` resolved outside `runs/`.
- `npm test` now runs every declared test. The default process-isolation
  runner carries test events on stdout, and this suite also writes captured
  CLI output there, so the parent only reported the last few dozen tests and
  turned any earlier failure into a nameless "test failed". In-process
  reporting keeps the full count and the failing test's name.
- A structured act failure now keeps the child stderr on the run report and in
  the manifest. Decide and prove already did; act returned the text and then
  dropped it, so `report.json`, `aas` human output, and later case summaries
  showed a failed act with no diagnostic.
- A prove-stage error no longer wipes the act result from the run report. The
  error path rebuilt `report.stages.act` from the internal stage record, so
  `outcome`, `state`, `fault`, `action_id`, `assurance_mode`, and
  `bundle_verification` disappeared from `report.json`, from the human output,
  and from `aas runs`/`aas cases`/`aas compare` summaries for any run whose
  proof failed. Only the raw child payload is stripped now.

### Changed
- `npm run check` now runs the unit suite and a syntax gate,
  `npm run check:syntax`, which parses every module `git ls-files` reports
  with `node --check`. CI's test job runs the same gate in place of a
  hand-written list of nine files, which had already drifted once. A new
  `.gitattributes` pins LF line endings, so a Windows checkout no longer
  turns every tracked file into a CRLF modification.
- CI now tests the documented Python 3.11 floor: the integration matrix adds
  a fifth leg on Ubuntu with Node.js 22.12.0 and Python 3.11, next to the four
  Python 3.13 legs. The pinned workflow actions move to their current
  releases (checkout v7.0.1, setup-node v7.0.0, setup-python v7.0.0), still
  pinned by commit SHA, and `.github/dependabot.yml` proposes weekly grouped
  updates for GitHub Actions and npm. A test fails if any workflow step uses
  an action without a full commit SHA and version comment. The browser job's
  install step no longer claims a cache it does not have.
- `aas help` now documents the whole CLI surface. The usage block listed
  neither `aas runs` nor `aas prune` although both are dispatched, the command
  list omitted `help`, and the option reference omitted nine accepted flags:
  `--out`, `--overwrite`, `--before`, `--limit`, `--outcome`, `--search`,
  `--keep`, `--dry-run`, and `--markdown`.
- `aas cases --search` no longer accepts a value that begins with `-`.
  `aas cases --search --json` used to consume `--json` as the search term and
  exit 0 with an unfiltered listing, so a mistyped or reordered flag silently
  changed the result set. It now reports a missing value and exits 2, matching
  every other value-taking option in the CLI. The `aas cases` usage message
  also lists the `--domain`, `--outcome`, and `--search` filters it accepts.
- `loadComponentLock` now rejects an `install` or `build` value other than the
  supported tokens (`npm-ci`, `npm-run-build`). Those fields are dispatched by
  exact string match, so an unrecognised value was skipped silently and
  `npm run bootstrap` still reported success for a component that had never
  been installed or built. The shipped `stack-lock.json` is unchanged.
- `npm run gui:smoke` now requests `/api/health` and the workbench page over
  loopback HTTP and asserts the response status, the `text/html` content type,
  the content security policy header, and the presence of every embedded page
  helper. It previously started the server, closed it, and asserted nothing, so
  it passed even when the page renderer or a route was broken. The rendered
  helper list is now a single `PAGE_HELPERS` constant shared by `renderPage`
  and the smoke check.
- The connector conformance example now runs rules 2 to 6 on both synthetic
  connectors and measures the effect itself: active refunds bound to the
  action, and inventory on hand against the connector's baseline. It used to
  touch the refund connector only for capability advertisement and checked
  only call counts and equal return values, so it could not see a second
  effect or an incomplete reversal. The refund remedy check covers the
  duplicate fault (only the duplicate is voided, the primary stays active)
  and a clean refund (`no_change`).
- Documentation now matches the code. `aas help` and the export and prune
  usage errors list the `--root` option both commands accept, the `--root`
  reference names every command that takes it, and the flow line says
  `consequence-rail demo <domain>` rather than always `refund`.
  `docs/stack-lock.md` now says a lock mismatch stops the run before any
  stage and writes no bundle; it claimed the mismatch was recorded in the
  manifest. The examples README uses the direct `node` invocation CI uses and
  says the conformance example drives rail modules in-process. The pull
  request template drops issue-form front matter that rendered as text, and
  its checklist now follows `CONTRIBUTING.md` instead of forbidding the
  changelog and CI edits this repository requires.

### Security
- Every CI checkout now sets `persist-credentials: false`. The integration and
  browser jobs run `npm ci` and builds inside the pinned components, and the
  job token used to stay in `.git/config` while that code ran.
- The workbench content security policy no longer allows `'unsafe-inline'`
  script or style. The page's one script and one stylesheet are static per
  process, so `script-src` and `style-src` now pin their SHA-256 hashes, and
  the policy adds `object-src 'none'`. Imported and saved case data still
  reaches the page only through `escapeHtml`; an injected inline script would
  now also be refused by the browser. The script is hashed after CRLF is
  normalized to LF, so a Windows checkout serves a matching hash, and
  `npm run gui:smoke` checks the served policy against the page content.

[Unreleased]: https://github.com/EauDoon/agent-action-stack/compare/c9e89c001f51b48f1ebda6716996680546033a8b...HEAD