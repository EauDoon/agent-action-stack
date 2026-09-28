# Changelog

All notable changes to Agent Action Stack are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `CONTRIBUTING.md` describing cross-repo coordination and the
  `stack-lock.json` policy.
- `CHANGELOG.md` (this file).
- Playwright setup note in the Quick start section of `README.md`.

### Fixed
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

### Changed
- `loadComponentLock` now rejects an `install` or `build` value other than the
  supported tokens (`npm-ci`, `npm-run-build`). Those fields are dispatched by
  exact string match, so an unrecognised value was skipped silently and
  `npm run bootstrap` still reported success for a component that had never
  been installed or built. The shipped `stack-lock.json` is unchanged.

### Changed
- `npm run gui:smoke` now requests `/api/health` and the workbench page over
  loopback HTTP and asserts the response status, the `text/html` content type,
  the content security policy header, and the presence of every embedded page
  helper. It previously started the server, closed it, and asserted nothing, so
  it passed even when the page renderer or a route was broken. The rendered
  helper list is now a single `PAGE_HELPERS` constant shared by `renderPage`
  and the smoke check.

[Unreleased]: https://github.com/EauDoon/agent-action-stack/compare/main...HEAD