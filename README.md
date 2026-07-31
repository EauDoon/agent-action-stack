# Agent Action Stack

**One reference path across three public libraries: decide → act → prove.**

Agent Action Stack is a thin orchestrator. It does not re-implement the libraries. It runs them in a fixed order so a visitor can see how they compose.

```text
structured agent JSON
        │
        ▼
┌───────────────────────────────┐
│ Decide                        │
│ constitutional-agent-testbench│
│ policy evaluate               │
└───────────────┬───────────────┘
                │ pass
                ▼
┌───────────────────────────────┐
│ Act                           │
│ consequence-rail              │
│ recourse-gated refund demo    │
└───────────────┬───────────────┘
                │ compensated / disputed / --dispute
                ▼
┌───────────────────────────────┐
│ Prove                         │
│ mandatebound                  │
│ simulate evidence readiness   │
└───────────────────────────────┘
```

On policy failure the stack stops. On a clean `settled` outcome, MandateBound is skipped unless you pass `--dispute`.

> Experimental reference demo. Not legal advice, not a hosted service, not a safety certification.

## Libraries used

| Stage | Public repo | Role in this demo |
| --- | --- | --- |
| Decide | [constitutional-agent-testbench](https://github.com/oonyl/constitutional-agent-testbench) | Evaluate refund-authorization JSON against a declared policy |
| Act | [consequence-rail](https://github.com/oonyl/consequence-rail) | Reserve recourse, execute a synthetic refund, settle or compensate |
| Prove | [mandatebound](https://github.com/oonyl/mandatebound) | Run a dispute-oriented evidence simulation when the rail outcome needs review |

## Requirements

- Node.js 20+
- Python 3.11+ (stdlib only; no pip install required for the testbench)
- git
- network access once, for `npm run bootstrap` (clones the three public repos into `deps/`)

Private repositories are never cloned or modified.

## Quick start

```bash
npm run bootstrap
npm run demo
```

Expected human output (pass path, no fault):

```text
stack: agent-action-stack
response: pass
decide: pass
decide_passed: true
act: ran
act_outcome: settled
act_state: CLOSED
act_fault: none
prove: skipped
flow: decide → act
```

Fail closed at decide:

```bash
npm run demo:fail
```

Force the dispute path via a compensated rail outcome:

```bash
npm run demo:dispute
```

Expected flow line:

```text
flow: decide → act → prove
```

JSON report:

```bash
node ./bin/aas.mjs demo --fault duplicate --json
```

## What each stage writes

Artifacts land in `.out/` (gitignored):

- `decide.json` — testbench evaluation
- `act.json` — Consequence Rail refund summary
- `prove.json` — MandateBound simulate payload (dispute path only)

## Fixtures

- `fixtures/policy.json` — refund gate: accept, low/moderate risk, recourse required, not blocked
- `fixtures/response.pass.json` — passes the gate
- `fixtures/response.fail.json` — fails the gate; act and prove are skipped

## Design bounds

- Orchestration only. Behavior lives in the three libraries.
- Synthetic connectors and scenarios only.
- MandateBound’s prove step uses `simulate --scenario operator` as the dispute-oriented demo path. Full AP2 pack assemble/verify remains in MandateBound’s own CLI and docs.
- This repo does not read or write any private GitHub repositories.

## License

Apache-2.0
