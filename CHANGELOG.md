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
- `npm test` now runs every declared test. The default process-isolation
  runner carries test events on stdout, and this suite also writes captured
  CLI output there, so the parent only reported the last few dozen tests and
  turned any earlier failure into a nameless "test failed". In-process
  reporting keeps the full count and the failing test's name.
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