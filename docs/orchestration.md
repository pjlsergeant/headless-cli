# Multi-Agent Workflows

Headless can coordinate multiple local agents through roles, a shared run store, and message routing commands.

## Roles and Runs

Pass `--role orchestrator|explorer|worker|reviewer` to prepend role-specific coordination instructions. `explorer` and `reviewer` default to `--allow read-only` unless `--allow` is explicit; `worker` and `orchestrator` keep the normal edit-capable default.

Add `--run <name>` and optional `--node <name>` to track local state in `~/.headless/runs/<name>/run.json`, with per-node logs under `nodes/<node>/`.

```bash
headless codex --role orchestrator --run auth --node orchestrator --prompt "Build auth"
```

## Role Config

Role defaults live in `~/.headless/config.toml` under `[roles.<name>]`. Use this to add or override settings for another supported role, including its default model, reasoning effort, permission mode, and base instruction prompt.

```toml
[roles.reviewer]
model = "claude-opus-4-6"
reasoning_effort = "high"
allow = "read-only"
base_instruction_prompt = """
Role: reviewer.
Stay read-only. Review for bugs, regressions, security risks, and missing tests.
Lead with findings ordered by severity and include file and line references.
"""
```

Then invoke the role normally:

```bash
headless claude --role reviewer --run auth --node reviewer --prompt "Review the current diff"
```

Supported role names are currently fixed: `orchestrator`, `explorer`, `worker`, and `reviewer`. Config sections for arbitrary names such as `[roles.scout]` are rejected.

## Team Declarations

Orchestrators can declare prompt-only teams with repeatable `--team` specs:

- `explorer`
- `worker=2`
- `claude/reviewer`
- `codex/worker=3`

Example:

```bash
headless codex \
  --role orchestrator \
  --run auth \
  --node orchestrator \
  --team explorer \
  --team worker=2 \
  --prompt "Build auth"
```

## Coordination Modes

Use `--coordination session|tmux|oneshot` to choose how a run node receives later messages.

- `session`: resume native Headless sessions.
- `tmux`: send through the existing tmux buffer flow.
- `oneshot`: launch a fresh stateless invocation.

## Run Commands

Run commands operate on local run state:

- `headless run list`: list known runs.
- `headless run view <run>`: render the graph, recent messages, and exact message/log/attach commands.
- `headless run mark <run> <node> --status planned|starting|busy|idle|done|failed|unknown`: manually adjust status.
- `headless run message <run> <node> --prompt "..." [--async]`: route a prompt using stored node metadata.
- `headless run wait <run>`: wait until no nodes are `busy` or `starting`.

Example:

```bash
headless run view auth
headless run message auth worker-1 --prompt "Continue with refresh token tests"
headless run message auth reviewer --prompt "Review the diff" --async
headless run wait auth
```

## Status Logs

When an orchestrator run executes locally or through Docker, Headless writes compact lifecycle logs to stderr while it runs. The stream reports node status changes and message routes without printing prompt text, uses short timestamps and ANSI colors on TTYs unless `NO_COLOR` is set, and leaves stdout reserved for final answers or JSON/debug output.

Tune polling with `HEADLESS_RUN_STATUS_INTERVAL_MS`. Modal orchestrator runs rely on final synced run state and node logs for status.

## Docker Run Coordination

A Docker run node never sees the host run directory. Each one gets a private mailbox instead:

| Host path | Container path | Access |
| --- | --- | --- |
| `~/.headless/runs/<run>/mailboxes/<node>/requests` | `/headless-mailbox/requests` | read-write |
| `~/.headless/runs/<run>/mailboxes/<node>/replies` | `/headless-mailbox/replies` | read-only |

`HEADLESS_RUN_MAILBOX=/headless-mailbox` tells the `headless` inside the container to use it. There, the run commands work against the node's own run only:

- `run view`, `run list`, and `run wait` read `replies/run.json`, a snapshot of the run state the host refreshes while the node runs.
- `run message <run> <node> --prompt "..." [--async]` submits a request. If the target is an idle `oneshot` Docker node, the host starts it in its own container, with the same `--docker-image`, `--docker-arg`, and `--docker-env` flags the requesting node was launched with, and the work dir, permissions, and model from the host's run state. Without `--async` the command waits for the target to finish and prints its final message. A message to a host, Modal, tmux, session, or busy node is recorded in run state (so `run view` shows it) but not started; the command says so and exits 1.
- `run mark <run> <own-node> --status ...` can change only the container's own node.
- Launching a new run node from inside the container (`headless <agent> --run ...`) is refused.

The host process that launched the container reads each request file, validates it strictly (a regular file of at most 256 KiB, a known operation with exactly its fields, a valid known target node id, a prompt of at most 100,000 characters, at most 16 requests per poll and 500 per container), and applies it under the run lock. Rejected requests are logged to the node's `latest.stderr.log` and answered with an error reply. Nothing a container writes is used as a host path, command, work dir, permission mode, or environment variable.

Containerized run nodes currently support `oneshot` coordination only; explicit `--docker --coordination session` and `--docker --session` run-node combinations are rejected because follow-up `run message` invocations do not persist Docker launch options.

Each node records the sandbox it was launched in (`none`, `docker`, or `modal`). Headless never runs a Docker or Modal node on the host: a host-side `run message` to one is refused, and relaunching it directly must use the same sandbox flag.

```bash
headless codex --role orchestrator --run auth --node orchestrator --team worker=2 --docker --prompt "Build auth"
```
