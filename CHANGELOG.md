# Changelog

## TBD

- Fixed Modal result recovery losing remote work: the result download gets its own 120s window after the agent deadline and is streamed to a private file with compressed and extracted size limits (`HEADLESS_MODAL_MAX_ARCHIVE_BYTES`, `HEADLESS_MODAL_MAX_EXTRACTED_BYTES`), and the workspace is recovered even when the agent execution fails. If the downloaded workspace cannot be extracted or applied, Headless saves it to `~/.headless/modal-recovery/<timestamp>-<id>.tar.gz` (private), prints how to extract it, terminates the sandbox and exits nonzero; conflicting paths left unapplied by sync-back also save the recovery archive. The sandbox is terminated only once the result is applied or the archive is saved to disk (otherwise it is left running and its id printed). Added `--modal-keep-sandbox` (also for `cron add` and the Python SDK's `modal_keep_sandbox=True`) to leave the sandbox running, with its id printed, when recovery fails; a kept sandbox keeps billing until terminated (created with a 24h lifetime).
- Fixed Modal sync-back: sandbox symlinks whose target is absolute or resolves outside the work dir are reported as conflicts and not created, targets containing a backslash are refused, every sandbox symlink is checked against the final tree before anything is changed locally, and paths that differ from a local path only by case or Unicode normalisation are treated as conflicts. Fixed Modal uploads failing before the agent started when a tracked file had been deleted from the worktree without staging the deletion.
- Fixed prompts starting with "-" (such as markdown lists) being parsed as options by the agent CLI: Claude (one-shot and interactive) and interactive Codex now get the prompt after `--`, and Gemini one-shot reads inline prompts from stdin.
- Fixed Docker runs mounting all of `~/.aws` when `AWS_PROFILE` is forwarded: the container now gets only the selected profile, the profiles it chains to through `source_profile`, their `sso-session` sections and matching SSO token cache files, staged in a private temporary directory removed after the run (Modal uses the same selection). Durable Docker session homes get a fresh `~/.aws` on every start.
- Fixed ACP file reads being unconfined: `fs/read_text_file` requests from an ACP server are now limited to the invocation work dir (resolved through symlinks), under every `--allow` mode; other paths are refused with an error the server sees.
- Fixed Docker runs to refuse a work dir that overlaps Headless state in either direction (`~/.headless`, the run store, cron root, session store, or Docker session root), comparing configured and canonical paths, since the work dir is mounted read-write into the container. Docker run nodes pin the canonical run directory at launch for their mailbox and the nodes it starts.
- Changed Docker run coordination so containers no longer get the host run directory: each Docker run node gets a mailbox (`/headless-mailbox`, requests read-write, replies and a run state snapshot read-only) and the host validates every request before applying it. Inside a container, `run view`/`list`/`wait` read the snapshot, `run message` starts an idle oneshot Docker target in its own container with the requester's Docker flags (other targets get the message recorded but not started), `run mark` is limited to the node itself, and launching new run nodes is refused. Docker orchestrator team children now run in their own containers instead of inside the orchestrator's.
- Fixed coordinated runs trusting their own run state: node log paths are now derived from the run and node ids instead of being read from `run.json`, node ids read from state are validated (invalid or traversal keys are dropped), log and node directories are created without following symlinks, `HEADLESS_RUN_DIR` only resolves its own run, an unreadable `run.json` is never replaced by an empty run, and `events.jsonl` receives every event of a multi-event update. Each node records the sandbox it was launched in, and Headless refuses to run a Docker or Modal node on the host (`run message`, or a direct relaunch without the same sandbox flag). Run state from earlier versions is not read.
- Fixed a signal arriving after the agent exited (while Headless persists sessions, updates run status, releases locks and removes temporary directories) killing Headless mid-cleanup: the cleanup now finishes first and Headless then exits with the signal, leaving `--keep-background` processes running.
- Fixed cron kill/stop/rm --force on Windows (taskkill /T /F of the recorded process tree), cron sweeps now respect a job's `--keep-background` after an ordinary exit, and an SDK ndjson consumer that stops reading can no longer stall Headless forever after the agent exits.
- Changed one-shot runs to terminate processes the agent left running when it exits on its own (after a one-grace-period output drain), so a finished run leaves no agent processes behind and a background process holding the agent's output no longer hangs a run without `--timeout`. Pass `--keep-background` (also for `cron add`, coordinated-run nodes, and the Python SDK's `keep_background=True`) to leave them running instead. Async run messages (`run message --async`) always clean up the node's process tree, so the flag has no effect there; it applies to direct node launches.
- Fixed termination of native agents on POSIX: Headless now always runs the agent in its own process group and forwards `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGQUIT` (and suspend/continue) to the whole group, with or without `--timeout`, escalating to `SIGKILL` after a shared grace period (`HEADLESS_KILL_GRACE_MS`, default 5s). `cron kill`/`stop`/`rm --force`, ACP server shutdown, and async run-message workers now terminate the full process tree with the same bounded escalation. Descendants that leave the group with `setsid` are tracked and killed too, cron reaches the agent's group even when Headless itself was killed, and `runCli` no longer returns while the tree is still dying.
- Added automatic bounded retries for native Codex model-capacity failures in local, Docker, and Modal runs, preserving sessions, billing policy, cancellation, deadlines, and per-attempt usage. Set `HEADLESS_CAPACITY_RETRIES=0` to disable.
- Fixed run coordination to recover stale run and node locks after owner crashes, retain async ownership for the full detached process tree, and handle Windows process probing and state replacement safely (#28).

## 0.6.1 - 2026-08-12

- Fixed Modal runs to use the immutable, verified v0.6.0 runtime image digest instead of a stale cached `latest` tag.

## 0.6.0 - 2026-08-12

- Added Codex profile selection with `--profile`, including local, cron, tmux, named-session, Docker, and Modal execution while preserving explicit Headless model overrides.
- Added remote Codex profile and model-catalog seeding plus automatic `SAKANA_API_KEY` forwarding for Fugu runs in Docker and Modal.
- Hardened durable Docker profile refreshes with private host-owned profile directories, bounded regular-file reads, symlink-safe atomic replacement, and stale provider-config cleanup.
- Added an explicit Fast-mode opt-in for Codex and Claude: `--fast` in the CLI and `fast=False` sync/async Python SDK arguments. Standard mode is explicitly enforced by default, including scheduled, Docker, Modal, and newly launched tmux runs; existing tmux sessions reject Fast changes they cannot apply.
- Fixed Antigravity one-shot runs to forward Headless's effective local, Docker, or Modal command timeout to `agy --print-timeout`, so long reasoning runs are not cut off by Agy's independent five-minute default.
- Updated the bundled Docker image to Antigravity CLI 1.1.8, using the official release assets and published SHA-256 digests for Linux AMD64 and ARM64.
- Thanks to Anant Garg (@anantgar) for contributing Antigravity timeout forwarding and the Docker image update.

## 0.5.0 - 2026-07-27

- Added multi-architecture GHCR image publishing for Linux AMD64 and ARM64 releases, with guarded manual recovery, immutable release and commit tags, serialized `latest` promotion, provenance, and SBOM attestations (#23).
- Thanks to Anant Garg (@anantgar) for contributing multi-architecture Docker image publishing.
- Added a typed Python SDK with synchronous and asynchronous clients, structured streaming, CLI namespace coverage, subprocess cancellation and process-tree cleanup, and a raw invocation escape hatch (#22).
- Added a versioned JSON/NDJSON SDK protocol for stable machine-readable CLI results, errors, traces, capability discovery, and structured session, run, cron, config, and diagnostic output (#22).
- Added Python 3.10 and 3.14 CI coverage plus guarded PyPI trusted publishing for the `headless-cli` package (#22).
- Fixed structured SDK errors to preserve actionable public messages without exposing forwarded environment values, filesystem paths, malformed configuration contents, or external command stderr (#22).
- Fixed SDK NDJSON streaming to honor output backpressure across local and Modal execution, including bounded Modal chunks, cancellable drain waits, timeout termination, and Antigravity descendant cleanup (#22).
- Fixed Python SDK protocol validation to reject boolean and floating-point versions in envelopes and sync/async capability negotiation (#22).
- Updated the transitive `protobufjs` dependency to its patched 7.6.5 release (#22).
- Added durable Docker sessions with `--docker --session <name>`, persisting each native agent home under `~/.headless/docker-sessions` for multi-turn conversations while keeping the default Docker mode ephemeral (#21).
- Thanks to Anant Garg (@anantgar) for contributing durable Docker sessions.
- Changed Docker auth seeding for Antigravity to mount only credential and settings files instead of copying its conversation and brain history into each container (#20).
- Thanks to Anant Garg (@anantgar) for contributing safer Antigravity Docker credential seeding.
- Added combined `--json --usage` output for one-shot runs: Headless streams the native trace unchanged, appends normalized usage after the native process exits, and does not require an extractable final assistant message (#18).
- Clarified accounting provenance with `usageStatus` and `costBasis`: missing usage stays unknown instead of becoming a priced zero, and native-reported costs are distinguished from API list-price estimates calculated from token counts and `models.dev` pricing (#18).
- Fixed local Antigravity `--usage` output to collect input, cache-read, cache-write, and output tokens from the documented status-line payload and price known models with API-equivalent models.dev rates, without modifying the user's Antigravity settings (#19).
- Thanks to Anant Garg (@anantgar) for contributing combined JSON traces with usage accounting.

## 0.4.0 - 2026-06-18

- Added Antigravity CLI (`agy`) harness support for one-shot prompts, model selection, read-only sandbox mode, native session aliases, tmux launches, `--tmux --wait`, transcript final-message extraction, setup checks, Docker packaging, and README/config documentation.
- Added README documentation for using `--tmux --wait --delete` as a native TUI completion path, including prompts that use TUI commands such as `\goal`.
- Changed Claude model overrides to normalize versioned `opus`, `sonnet`, and `haiku` shorthand such as `opus-4.8` or `sonnet-4.5` to Claude Code model IDs before execution.
- Changed Claude model normalization to also cover `fable` shorthand, mapping `fable-5` to `claude-fable-5`, including major-only versions without a minor component.
- Changed `--tmux --wait` to identify each run's native transcript without injecting a marker into the executed prompt, using a per-harness strategy: Claude and Gemini pin `--session-id`, Cursor mints and resumes a session id, OpenCode tags the session with a unique title, Pi isolates the run in its own `--session-dir`, and Codex claims the brand-new transcript under a per-(agent, working-directory) launch lock. This keeps transcript identification correct even when multiple headless runs execute concurrently, including in the same working directory. Set `HEADLESS_TMUX_WAIT_FORCE_MARKER=1` to restore the legacy prompt-marker behavior.
- Fixed Antigravity final-message extraction so JSON-shaped plain text answers are preserved instead of being mistaken for structured trace output.

## 0.3.2 - 2026-05-15

- Added `headless cron` for scheduled detached agent invocations, including interval and five-field cron schedules, per-user daemon control, private job/execution state, list/view observability, pause/resume/kill/remove lifecycle commands, collapsed pending ticks for long-running jobs, and README/usage documentation.
- Added `--tmux --wait` to wait for native transcript completion and print the final assistant message, plus `--delete` to kill the tmux session after capture; OpenCode wait mode now uses prompt-bearing interactive runs so sessions persist unless `--delete` is set.
- Added native transcript activity detection for Codex, Claude, Cursor, Gemini, OpenCode, and Pi, including running, waiting-for-input, and idle/completed signals.
- Changed tmux session listing to prefer native transcript state over tmux inactivity when available, so completed sessions can show `idle` and prompt-blocked sessions can show `waiting`.
- Changed coordinated tmux runs so `headless run view` and `headless run wait` reconcile node status from native transcript activity, and `headless run message` marks tmux nodes busy after sending input.
- Added a `waiting` run-node status for tmux nodes that are waiting on user input.

## 0.3.1 - 2026-05-12

- Added `[general]` settings in `~/.headless/config.toml` for default timeout, default agent, coordination mode, run status interval, and tmux waiting threshold.
- Added `--timeout <s>` for one-shot local, Docker, and Modal runs, with `--modal-timeout` still taking precedence for Modal.
- Added the bundled `headless-swarm` Codex skill for coordinating visible macOS Ghostty/tmux Headless agent swarms.
- Changed npm package contents to include bundled skills.
- Changed Headless tmux session listing to mark sessions waiting after 15 seconds of inactivity by default.
- Added README instructions for installing the bundled Codex skill with `npx`.
- Added `--print-command --json` for npx callers that need structured selected-agent, model, and reasoning-effort metadata.
- Fixed Claude runs to prefer existing Claude Code OAuth login over an inherited `ANTHROPIC_API_KEY`, while allowing explicit API-key auth with `HEADLESS_CLAUDE_AUTH=api`.
- Fixed Claude `--allow read-only` to keep normal answer mode instead of forcing Claude Code plan mode.

- Added ACP (`agentclientprotocol`) harness support via `@agentclientprotocol/sdk`, including registry-backed `--acp-agent` resolution, custom `--acp-command` launches such as `atlas alta agent run`, ACP registry overrides, setup checks, and README/usage examples.
- Thanks to Andy MacDonald (@andymac4182) for contributing the ACP harness.

## 0.3.0 - 2026-05-01

- Added API/OAuth credential signal reporting to `headless --check` for supported agent backends.
- Added named native session aliases for headless and tmux modes, stored per agent in `~/.headless/sessions.json`.
- Added role-aware coordinated runs with `--role orchestrator|explorer|worker|reviewer`, `--run`, `--node`, `--depends-on`, `--team`, and `--coordination session|tmux|oneshot`.
- Added `headless run list|view|mark|message|wait` for local run observability, run graph rendering, node status updates, message routing, async child launches, and wait handling.
- Added `headless attach` for attaching to the most recently active Headless tmux session, plus `headless attach --all` for tiled attachment to all active Headless tmux sessions.
- Added local run state under `~/.headless/runs`, including per-node logs, message/status events, usage metrics, private file permissions, and run-status stderr summaries for orchestrators.
- Added configurable role defaults in `~/.headless/config.toml`, including role-specific model, reasoning effort, allow mode, and base instruction prompts.
- Added `--effort` as a shorter alias for `--reasoning-effort`.
- Added `headless --version` and `headless -v` to print the packaged CLI version.
- Added an interactive wait spinner that shows the active agent, model, and reasoning effort while captured runs are in progress.
- Added a multi-agent role and run coordination spec in `docs/spec.md`.
- Added a local integration suite plus a tracked pre-push hook that builds the local CLI before running integration coverage.
- Added expanded Docker and Modal integration coverage for Codex `--json`, `--debug`, and `--usage` modes.
- Changed the pre-push hook to run Claude integration by default; set `HEADLESS_HOOK_ALL_AGENTS=1` to run all agents.
- Changed read-only agent modes to preserve search/read capabilities where supported while still denying edits and shell execution.
- Changed `headless --check`, `headless docker doctor`, and run views to use bordered, color-aware tables when appropriate.
- Changed `headless --check` to show configured model and reasoning effort defaults while using a compact `S` status column.
- Changed `headless --show-config` to render a bordered table with the selected agent's effective model, reasoning effort, config paths, and seed paths.
- Changed Docker run coordination to mount the host run directory into containers with `HEADLESS_RUN_DIR`.
- Changed orchestrator pre-push coverage so `HEADLESS_HOOK_ALL_AGENTS=1` enables the full multi-agent integration sweep.
- Fixed run and node ID validation to reject dot segments.
- Fixed run nodes to be marked failed when setup or execution errors occur after registration.
- Fixed `run message` so locked session/oneshot nodes do not record undelivered messages.
- Fixed async `run message` wrappers to preserve child stderr in node logs and clean up node locks via shell traps.
- Fixed the pre-push hook to run against the freshly built local CLI.
- Fixed Cursor headless runs to pass `--trust` so staged workspaces do not block on workspace trust prompts.
- Fixed Gemini session alias persistence to select the newest native session.

## 0.2.1 - 2026-04-27

- Added `~/.headless/config.toml` support for per-agent default `model` and `reasoning_effort` values, plus a packaged `config.toml.example` template and README setup docs.
- Added provider-specific default models for Cursor, Gemini, OpenCode, and Pi, including Gemini `gemini-3.1-pro-preview` and Pi `openai-codex/gpt-5.5`.
- Changed Pi model overrides to accept `provider/model` specs such as `openai-codex/gpt-5.4`, splitting them into native Pi provider and model flags.
- Changed Cursor model handling so base GPT model families and `--reasoning-effort` combine into Cursor model variants, while usage pricing falls back to the base model.
- Fixed Gemini headless runs to skip workspace trust prompts automatically.
- Fixed OpenCode final-message extraction for text-part output events.
- Fixed successful and failed runs to surface structured agent JSON errors before generic final-message extraction failures.
- Fixed `--usage` token accounting and pricing edge cases, including Cursor effort variants and provider defaults.
- Hardened CLI timing tests around slower local agent startup.

## 0.2.0 - 2026-04-26

- Added normalized `--reasoning-effort low|medium|high|xhigh` support across Claude, Codex, OpenCode one-shot, and Pi, with warnings for unsupported agent modes.
- Added `--usage` accounting for one-shot runs, with normalized token counts and native or models.dev-backed cost summaries across all six agents.
- Added Headless default models for omitted `--model` values: Codex uses `gpt-5.5`, and Claude uses `claude-opus-4-6`.
- Added managed named tmux sessions, tmux session state reporting, and `headless send` for sending follow-up prompts to existing sessions.
- Added Docker execution mode, Docker setup checks, local image builds, and packaged Docker image support.
- Added Modal CPU sandbox execution with workspace upload, sync-back, resource flags, env forwarding, and named Modal Secret support.
- Changed Codex command building to use the Headless default model when `--model` and `CODEX_MODEL` are unset.
- Fixed Docker credential mounting, Docker image metadata, Modal credential seeding, Modal workspace upload scope, Modal sync-back conflict handling, and Modal archive extraction hardening.
- Fixed default agent permission behavior so backend adapters default consistently to yolo/auto-approve mode.

## 0.1.1 - 2026-04-24

- Added `--debug` mode to stream the raw agent trace and append the extracted final assistant message.
- Changed `--json` mode to stream raw agent trace output in real time instead of printing one final buffered dump.

## 0.1.0 - 2026-04-24

- Initial npm release of Headless CLI as `@roberttlange/headless`.
- Added one CLI entrypoint for running Codex, Claude Code, Cursor, Gemini, OpenCode, and Pi in headless mode.
- Normalized prompts, prompt files, stdin prompts, model overrides, working directories, dry-run command printing, JSON output, and adapter config inspection across supported agents.
- Added tmux launch mode with detached interactive sessions, session listing, and agent-specific trust/prompt-submission handling.
- Added permission modes for read-only review and explicit yolo/auto-approve execution where supported by each agent.
- Added `headless --check` for local setup validation and agent version reporting.
- Added npm package metadata, release workflow, packaging checks, README usage docs, and TypeScript test coverage for CLI parsing, adapter command building, allow modes, output extraction, and setup checks.
