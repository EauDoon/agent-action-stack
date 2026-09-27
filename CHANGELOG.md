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
- A prove-stage error no longer wipes the act result from the run report. The
  error path rebuilt `report.stages.act` from the internal stage record, so
  `outcome`, `state`, `fault`, `action_id`, `assurance_mode`, and
  `bundle_verification` disappeared from `report.json`, from the human output,
  and from `aas runs`/`aas cases`/`aas compare` summaries for any run whose
  proof failed. Only the raw child payload is stripped now.

[Unreleased]: https://github.com/EauDoon/agent-action-stack/compare/main...HEAD