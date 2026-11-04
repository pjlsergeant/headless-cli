# One Day

Known non-show-stopper issues in process lifecycle handling, kept for later.

- PID/PGID reuse: stored PIDs/PGIDs are signalled without an identity check (`TODO(phase-2)` at `src/cron.ts:352`, `src/cron.ts:547`, `src/cron.ts:590`).
- The run-storage lock probe counts zombies as alive (`process.kill(-rootPid, 0)`, `src/run-storage.ts:364`), so a lock can stay blocked where PID 1 never reaps.
- `processAlive` semantics differ per module: `src/cron.ts:528` treats EPERM as dead; `src/run-storage.ts:340` and `src/launch-lock.ts:267` treat it as alive. Consolidate into one zombie-aware, identity-checking helper.
- Ctrl-Z: the agent's own session makes its group orphaned, so a forwarded SIGTSTP (`src/cli.ts:2316`) is discarded by the kernel for agents without a SIGTSTP handler.
- New-session and double-fork escapes: descendants that leave via a new session and are reparented before headless looks are not cleaned up. Verified: Claude Code's Bash tool starts commands in a new session. Same for setsid, `tmux new-session -d`, pm2. Possible fix: a Linux subreaper supervisor (`PR_SET_CHILD_SUBREAPER`) so orphans reparent to headless.
- Window between `spawn()` and writing `agent.pgid` (`src/cli.ts:2080`): a SIGKILL of headless there (or a failed write) leaves the agent's group unknown to cron.
- A signal inside the billing/retry wrapper after an attempt finishes but before `runWithBilling` returns (`src/cli.ts:4937`) still ends headless immediately, skipping wrap-up.
- Node drops queued stdout data on exit when stdout is a socket pair (Node `spawn` pipes) and the reader is slow; affects Node consumers of `--sdk-format ndjson`, not real pipes (Python SDK).
- Docker runs only clean up the host-side `docker` client tree; processes the agent leaves inside the container are not touched.
- Modal runs: post-exit cleanup and `--keep-background` are no-ops (the agent runs remotely).
- Async run messages (`run message --async`) always clean up the node's tree; a node's stored `--keep-background` is ignored there (`src/async-run-message.ts:216`).
