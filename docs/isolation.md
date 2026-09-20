# Slot isolation — two agents, one laptop

<!-- Last edited: 2026-09-20 11:45 CDT -->

**TLDR:** Each running agent gets a slot number (0 or 1).
The slot picks a Docker Compose project name and a set of host ports, so two agents can run ChessBuddy's stack at the same time without sharing a database or fighting over a port.
The values reach the agent through the settings `env` block, which applies to every Bash call it makes.
Nothing in Marshall runs Docker; the skill does, with those values already in its environment.

## Slot → project → ports

`src/isolation.ts` owns the mapping. `slotEnv(slot, config)` returns:

| Var | Slot 0 | Slot 1 | Rule |
|---|---|---|---|
| `MARSHALL_SLOT` | `0` | `1` | the slot |
| `COMPOSE_PROJECT_NAME` | `marshall-0` | `marshall-1` | `marshall-<slot>` |
| `POSTGRES_HOST_PORT` | `5432` | `5532` | `base + slot × portOffsetPerSlot` |
| `ELASTICMQ_HOST_PORT` | `9324` | `9424` | same |
| `API_HOST_PORT` | `8000` | `8100` | same |

The service list and the offset live in `marshall.config.json`:

```json
"services": { "POSTGRES_HOST_PORT": 5432, "ELASTICMQ_HOST_PORT": 9324, "API_HOST_PORT": 8000 },
"portOffsetPerSlot": 100
```

Add a service to that map when ChessBuddy publishes a new port; the key is the env var its `docker-compose.yml` reads.
`slotEnv` throws when the slot is outside `[0, maxAgents)` or a port would pass 65535.

`implementEnv(issueId, issueUrl, slot, config)` adds `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, and `MARSHALL_MAX_CYCLES` on top; that is the full set `/marshall:implement` expects.

## How the env reaches the agent

Bash state does not persist between an agent's tool calls, so an `export` inside one call is gone in the next.
The runner therefore puts the record into the settings JSON it passes with `--settings` (`LaunchOpts.env` → `buildAgentSettings(runId, base, env)` → the `env` key).
Claude Code applies that block to every Bash call for the session.
A per-run key wins over one committed in `agent-settings.json`.

## Why it isolates

ChessBuddy's `docker-compose.yml` (branch `chore/compose-host-port-vars`) publishes `${POSTGRES_HOST_PORT:-5432}:5432` and the same for the other two.
Container-side ports and service-to-service URLs (`postgres:5432`, `elasticmq:9324`) never change.
`COMPOSE_PROJECT_NAME` overrides the file's `name: chessbuddy`, and Compose prefixes containers, the network, built images, and named volumes with the project name.
So `marshall-0_postgres-data` and `marshall-1_postgres-data` are two volumes: two databases, no shared rows.

The skill never passes `-p` or edits ports; the env does all of it.

## Observed (2026-09-20, Compose v2, two worktrees on `chore/compose-host-port-vars`)

```
$ env $(slotEnv 0) docker compose up --wait   # in worktree A
 Container marshall-0-api-1 Healthy
$ env $(slotEnv 1) docker compose up --wait   # in worktree B
 Container marshall-1-api-1 Healthy

$ curl localhost:8000/health ; curl localhost:8100/health
{"status":"ok"}
{"status":"ok"}

$ docker compose ls | grep marshall
marshall-0   running(4)   .../compose-host-port-vars/docker-compose.yml
marshall-1   running(4)   .../compose-slot1/docker-compose.yml

$ docker volume ls | grep marshall
local   marshall-0_postgres-data
local   marshall-1_postgres-data

$ docker ps --format '{{.Names}} {{.Ports}}' | grep marshall
marshall-1-api-1        0.0.0.0:8100->8000/tcp
marshall-1-postgres-1   0.0.0.0:5532->5432/tcp
marshall-1-elasticmq-1  0.0.0.0:9424->9324/tcp
marshall-0-api-1        0.0.0.0:8000->8000/tcp
marshall-0-postgres-1   0.0.0.0:5432->5432/tcp
marshall-0-elasticmq-1  0.0.0.0:9324->9324/tcp
```

Built images were `marshall-0-api`, `marshall-0-worker`, `marshall-1-api`, `marshall-1-worker`: one build per slot, about 1 minute each on first run.

## Cleanup

The skill runs `docker compose down -v` at the end of every run that brought the stack up; with the slot's env present, that targets the right project.
By hand, from any directory:

```bash
docker compose -p marshall-0 down -v --remove-orphans
docker compose -p marshall-1 down -v --remove-orphans
docker image rm marshall-0-api marshall-0-worker marshall-1-api marshall-1-worker   # optional, ~330 MB each
```

`docker compose ls` and `docker volume ls | grep marshall` should both come back empty afterwards.

## Not isolated (on purpose)

- Host-side dev servers: Vite picks the next free port when 5173 is taken, so `apps/web` needs no var.
- The Python test suite: ChessBuddy's tests use fake SQS clients and no database, so they run in any slot with no services up.
- Stockfish: one binary on `PATH`, read-only, shared.
