# One Day

Known non-show-stopper issues in process lifecycle handling, kept for later.

- Ctrl-Z: the agent's own session makes its group orphaned, so a forwarded SIGTSTP (`src/cli.ts:2316`) is discarded by the kernel for agents without a SIGTSTP handler.
- New-session and double-fork escapes: descendants that leave via a new session and are reparented before headless looks are not cleaned up. Verified: Claude Code's Bash tool starts commands in a new session. Same for setsid, `tmux new-session -d`, pm2. Possible fix: a Linux subreaper supervisor (`PR_SET_CHILD_SUBREAPER`) so orphans reparent to headless.
- Window between `spawn()` and writing `agent.pgid` (`src/cli.ts:2080`): a SIGKILL of headless there (or a failed write) leaves the agent's group unknown to cron.
- A signal inside the billing/retry wrapper after an attempt finishes but before `runWithBilling` returns (`src/cli.ts:4937`) still ends headless immediately, skipping wrap-up.
- Node drops queued stdout data on exit when stdout is a socket pair (Node `spawn` pipes) and the reader is slow; affects Node consumers of `--sdk-format ndjson`, not real pipes (Python SDK).
- Docker runs only clean up the host-side `docker` client tree; processes the agent leaves inside the container are not touched.
- Modal runs: post-exit cleanup and `--keep-background` are no-ops (the agent runs remotely).
- Async run messages (`run message --async`) always clean up the node's tree; a node's stored `--keep-background` is ignored there (`src/async-run-message.ts:216`).
- Run and node store locks (`src/run-storage.ts`) still use proper-lockfile's mtime staleness: two waiters that both see a stale lease can both reclaim it. Not moved onto `src/owner-lock.ts` because node locks hand ownership to another process tree and judge liveness by that tree, which the owner lock does not model.
- Lock directories (`~/.headless/launch-locks/<key>`, `cron/locks/jobs/<id>`) are never removed, by design (removing one would break atomic reclaim); `cron rm` leaves its small lock directory behind.
- Lock holders on another host (shared filesystem) count as alive indefinitely; a crashed remote holder needs its lock directory removed by hand.
- A Docker session's store lock lives in the container-writable session home, so the container can make that session's store writes time out.
- The session store drops records that fail validation the next time it is written (now for the local store too, not only Docker session stores).
- Cron reconcile can mark an execution `killed`/`stale` when the post-exit sweep of its agent group outlasts a daemon tick, though it had finished normally.
- A daemon tick already in progress at shutdown can start an execution after the shutdown kill passed that job; the next daemon's reconcile cleans it up.
- `cron stop` sends SIGTERM and returns without waiting for the daemon to exit.
