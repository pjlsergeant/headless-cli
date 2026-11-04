import type { Env } from "./types.js";

/**
 * Set (to "1") in every container headless starts with --docker. Inside one,
 * headless refuses what must run on the host: the cron daemon, and nested
 * --docker runs. Their locks have no maximum hold time and are judged
 * stale only by probing a same-host holder, so a holder in a container
 * that died would wedge them forever.
 */
export const IN_CONTAINER_ENV = "HEADLESS_IN_CONTAINER";

export function runningInHeadlessContainer(env: Env): boolean {
  return env[IN_CONTAINER_ENV] === "1";
}

export function hostOnlyError(what: string): Error {
  return new Error(`${what} must run on the host, not inside a headless Docker container (${IN_CONTAINER_ENV}=1)`);
}
