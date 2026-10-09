# Security

This repository is a local reference demo. It clones three public libraries into `deps/` and runs synthetic scenarios only.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x | Yes: the latest release only |
| Earlier than 0.3.0 | No: these versions receive no fixes |

`node bin/aas.mjs --version` prints the version of a checkout, and each saved run records it as `stack_version`.

## Reporting

Report security issues for:

- this orchestrator: open a GitHub issue on this repository, or contact the maintainer through the GitHub profile
- [constitutional-agent-testbench](https://github.com/EauDoon/constitutional-agent-testbench/security)
- [consequence-rail](https://github.com/EauDoon/consequence-rail/security)
- [mandatebound](https://github.com/EauDoon/mandatebound/security)

Issues on this repository are public. Do not include exploit details, proof-of-concept code, or reproduction steps for an unfixed vulnerability in a public issue; open an issue asking for a private contact instead, and share the details once one is arranged.

Do not submit real credentials, personal data, production transaction evidence, or private repository contents in issues or fixtures.
