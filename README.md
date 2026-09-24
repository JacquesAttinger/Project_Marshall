<!-- Last edited: 2026-09-24 -->

<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/JacquesAttinger/Project_Marshall">
    <img src="images/logo.png" alt="Logo" width="80" height="80">
  </a>

<h3 align="center">Marshall</h3>

  <p align="center">
    A Linear autopilot that runs Claude Code agents on your issues — plan, implement, and hand off a pull request, while you sleep.
    <br />
    <a href="docs/project_marshall_plan.md"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://github.com/JacquesAttinger/Project_Marshall/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/JacquesAttinger/Project_Marshall/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#commands">Commands</a></li>
        <li><a href="#agent-runner">Agent runner</a></li>
        <li><a href="#plugin-and-skills">Plugin and skills</a></li>
        <li><a href="#scheduler">Scheduler</a></li>
        <li><a href="#master-agent">Master agent</a></li>
        <li><a href="#further-documentation">Further documentation</a></li>
      </ul>
    </li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

[![Marshall status output][product-screenshot]](images/screenshot.png)

Before Marshall, every Linear issue started the same way.
I opened a terminal, started a Claude Code session by hand, and pasted in the issue.
Marshall removes that step.

It watches a Linear board and picks up issues on its own.
For each one, it runs a Claude Code agent through the full loop: plan, implement, hand off a pull request, and post the result back to Linear.
I create the issue. Marshall does the rest, even while I sleep.
I review the pull request when it lands.

Iteration 1 runs one repo on a laptop, driven by [Linear](https://linear.app) and [Claude Code](https://claude.com/claude-code).
The goal is bigger than that.
A background agent that never stops picking up new work turns my job from writing code into writing issues — one step toward a fully autonomous software engineer that works around the clock.
See the [roadmap](#roadmap) for where that's headed.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![Bun][Bun.sh]][Bun-url]
* [![TypeScript][TypeScript.org]][TypeScript-url]
* [![SQLite][SQLite.org]][SQLite-url]
* [![Linear][Linear.app]][Linear-url]
* [![Claude][Claude.ai]][Claude-url]
* [![Biome][Biome.dev]][Biome-url]
* Zod, Husky, and lint-staged for schema validation and pre-commit checks.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

* [Bun](https://bun.sh)
* A [Linear](https://linear.app) workspace and a personal API key
* [Claude Code](https://claude.com/claude-code), signed in

### Installation

```bash
bun install
cp .env.example .env      # put the target workspace's key in MARSHALL_LINEAR_API_KEY
bun run migrate           # creates ~/.marshall/marshall.db
bin/marshall linear setup # creates the Needs Verification state and the marshall labels (once)
bin/marshall status       # prints config, state dir, schema version, row counts
```

The Linear key is `MARSHALL_LINEAR_API_KEY`, not `LINEAR_API_KEY`.
This keeps a different, already-exported `LINEAR_API_KEY` from leaking into the wrong workspace.
See [`docs/linear_setup.md`](docs/linear_setup.md) for the manual steps and the conventions.

State lives in `~/.marshall/` (override with `MARSHALL_HOME`).
Config is `marshall.config.json` at the repo root (override with `--config <path>` or `MARSHALL_CONFIG`).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->
## Usage

Point `marshall.config.json` at a repo and a Linear team, then start the daemon (`bin/marshall run`, or `scripts/install-launchd.sh` for an always-on laptop service).
From there, the workflow is: create a Linear issue, let Marshall pick it up, and review the pull request it opens.

### Commands

| Command | What it does |
|---|---|
| `bin/marshall status [--json]` | Show config and DB state. Never writes. |
| `bin/marshall db migrate` | Create the state dir and apply pending migrations. |
| `bin/marshall linear setup [--json]` | Create the Linear states and labels Marshall needs. Idempotent. Refuses a key from another workspace. |
| `bin/marshall plan <identifier> --cwd <worktree> [--revise] [--json]` | Plan one issue in an existing worktree: classify, launch the planner, verify, post to Linear. |
| `bin/marshall plan check <file>` | Check a plan file for the required sections, in order. |
| `bin/marshall handoff check <file>` | Check a hand-off file: six sections in order, the section 5 sub-lists, a PR URL and a branch in section 6. |
| `bin/marshall queue [--json]` | Dry-run one scheduler tick: the ordered pickable list and why each issue would or would not start now. Never writes. |
| `bin/marshall run [--once]` | The orchestrator: reconcile, then poll Linear and drive the master agents until Ctrl-C. `--once` does one reconcile + pulse + tick and exits. |
| `bun test` | Run the test suite. |
| `bun run lint` / `bun run format` | Biome check / fix. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run check:size` | 500 lines per file, 75 per function. |

The pre-commit hook runs lint-staged (Biome + size check), typecheck, and tests.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Agent runner

Each agent launch passes a `--settings` JSON whose hooks append one JSON line per event to `~/.marshall/events/<runId>.jsonl`.
The runner watches that folder, writes the lines into the `events` table, and runs `claude stop` when the agent's turn ends.
`bun test` covers the runner with a fake `claude` shim.
`MARSHALL_LIVE=1 bun test tests/runner.live.test.ts` runs four real agents against the daemon (about 30 s, needs `claude` logged in).
See [`docs/runner.md`](docs/runner.md) for the exact command line and what each lifecycle state looks like.

### Plugin and skills

`plugin/` is a Claude Code plugin named `marshall` (`plugin/.claude-plugin/plugin.json`).
Agents launch with `--setting-sources project,local`, which never loads `~/.claude/skills/`, so every skill an agent needs lives under `plugin/skills/` here and is loaded per launch with `--plugin-dir <repo>/plugin`.
It is not the repo root because a plugin root's `bin/` goes on the agent's `PATH`, and `bin/marshall` is not for agents.

| Skill | Does |
|---|---|
| `/marshall:plan <brief>` | The autonomous planner; see [`docs/planning.md`](docs/planning.md). |
| `/marshall:implement <plan-path> <ISSUE-ID>` | Plan → commits → local gate → PR → CI → `/marshall:review` → fixes, up to `maxFixCycles` times. Always ends with a PR; a red run leaves a draft whose body starts with `## Still failing`. |
| `/marshall:review <plan-path>` | The built-in `/code-review` bug hunt plus a Spec pass against the plan. `CONFIRMED` findings and spec gaps block; `PLAUSIBLE` ones are notes. |
| `/marshall:handoff <plan-path> <ISSUE-ID>` | The read-only hand-off writer: six sections from the plan, the diff, and the PR into `~/.marshall/handoffs/<ISSUE-ID>.md`; see [`docs/handoff.md`](docs/handoff.md). |
| `/marshall:resolve-conflicts <plan-path> <ISSUE-ID> <conflict\|ci>` | After a sibling PR merged: finish the rebase the orchestrator started (conflict mode) or fix the red CI it left (ci mode), then the full done gate. |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Scheduler

`src/scheduler/` is the loop that decides when work starts.
`startLoop` reconciles once, then ticks every `pollSeconds`.
A tick lists the pickable issues (Todo, assigned to me), orders them by priority then age, and for each one in turn:

1. Skips it while a claim row is still live, or blocks it when it has bounced `maxBounces` times.
2. Checks the caps in `src/caps.ts`: `maxAgents` live claims, `dailyStartCap` starts on the local calendar day, `windowStartCap` starts in the last `windowHours`.
3. Writes a `claiming` row, claims in Linear, creates the worktree (a sibling `<repo>-<branch>` off `origin/<baseBranch>` with `.env` copied in), and starts the agent.

`bin/marshall queue` shows exactly what the next tick would do.

### Master agent

`src/master-agent.ts` runs one issue through plan → implement → hand-off, enforces the wall-clock limit, resumes a stalled agent, and rebases parked pull requests when a sibling merges.
Every state lives on the claim's row, so `bin/marshall run` after a crash reconciles and continues from where each issue was.
See [`docs/state_machine.md`](docs/state_machine.md) for the full diagram.

### Further documentation

- [`docs/project_marshall_plan.md`](docs/project_marshall_plan.md) — the spec.
- [`docs/steps/`](docs/steps/) — iteration 1 build steps.
- [`docs/linear_setup.md`](docs/linear_setup.md) — what is configured in Linear and why.
- [`docs/planning.md`](docs/planning.md) — planning phase: the brief, the skill, the classifier, the post-run checks.
- [`docs/isolation.md`](docs/isolation.md) — slot → Compose project → ports, and how the env reaches an agent.
- [`docs/handoff_template.md`](docs/handoff_template.md) — what each of the six hand-off sections is for.
- [`plugin/README.md`](plugin/README.md) — the skills agents run, and how to try them by hand.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

- [x] Iteration 1 — Linear autopilot on one repo: poller, planner, implementer, reviewer, hand-off package, ntfy.sh push
- [ ] Iteration 2 — Web dashboard (queue, hand-off cards, kill switch), raise the agent cap, Linear OAuth status
- [ ] Iteration 3 — Voice intake: an iOS Shortcut turns a spoken note into a well-formed Linear issue
- [ ] Iteration 4 — Marshall proper: open-ended goals split into issues on their own, two-way chat instead of a CLI, an always-on machine
- [ ] Later — a Testing agent that scans the repo, finds bugs on its own, and proposes fixes the same way the Innovate agent proposes features

See [`docs/project_marshall_plan.md`](docs/project_marshall_plan.md) for the full plan and the [open issues](https://github.com/JacquesAttinger/Project_Marshall/issues) for what's in flight now.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

This started as a personal tool, but suggestions and pull requests are welcome.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

The pre-commit hook (lint, typecheck, tests) runs on every commit — see [Commands](#commands).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

Jacques Attinger - [@JacquesAttinger](https://github.com/JacquesAttinger) - jacques.attinger@gmail.com

Project Link: [https://github.com/JacquesAttinger/Project_Marshall](https://github.com/JacquesAttinger/Project_Marshall)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/JacquesAttinger/Project_Marshall.svg?style=for-the-badge
[contributors-url]: https://github.com/JacquesAttinger/Project_Marshall/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/JacquesAttinger/Project_Marshall.svg?style=for-the-badge
[forks-url]: https://github.com/JacquesAttinger/Project_Marshall/network/members
[stars-shield]: https://img.shields.io/github/stars/JacquesAttinger/Project_Marshall.svg?style=for-the-badge
[stars-url]: https://github.com/JacquesAttinger/Project_Marshall/stargazers
[issues-shield]: https://img.shields.io/github/issues/JacquesAttinger/Project_Marshall.svg?style=for-the-badge
[issues-url]: https://github.com/JacquesAttinger/Project_Marshall/issues
[product-screenshot]: images/screenshot.png
[Bun.sh]: https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white
[Bun-url]: https://bun.sh
[TypeScript.org]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[SQLite.org]: https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white
[SQLite-url]: https://www.sqlite.org/
[Linear.app]: https://img.shields.io/badge/Linear-5E6AD2?style=for-the-badge&logo=linear&logoColor=white
[Linear-url]: https://linear.app
[Claude.ai]: https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white
[Claude-url]: https://claude.com/claude-code
[Biome.dev]: https://img.shields.io/badge/Biome-60A5FA?style=for-the-badge&logo=biome&logoColor=white
[Biome-url]: https://biomejs.dev/
