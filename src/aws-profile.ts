import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// AWS config files and SSO token cache entries are small; refuse anything
// larger rather than read an unbounded file (they may be symlinks).
const maxAwsFileBytes = 1024 * 1024;
const maxChainLength = 32;

/**
 * Writes into `<seedDir>/.aws/` only what the selected `profile` needs, so a
 * sandbox never gets every profile on the host:
 *  - the config sections of the profile and every profile it chains to via
 *    `source_profile`, and the credentials entries for those profiles;
 *  - the `sso-session` sections they reference, and only the matching SSO
 *    token cache files (`sso/cache/<sha1(session name)>.json`, or
 *    `<sha1(start url)>.json` for legacy profiles; both when present).
 * Config and credentials are read through symlinks, bounded in size.
 * Returns the written paths relative to `seedDir`.
 */
export function seedAwsProfileFiles(awsDir: string, seedDir: string, profile: string): string[] {
  const paths: string[] = [];
  const targetDir = join(seedDir, ".aws");
  const config = readBoundedFile(join(awsDir, "config"));
  const credentials = readBoundedFile(join(awsDir, "credentials"));

  const profiles = config ? profileChain(config.content, profile) : [profile];
  const write = (relPath: string, content: string, mode: number) => {
    const target = join(seedDir, relPath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, { mode });
    paths.push(relPath);
  };

  if (credentials) {
    const content = filterIniSections(credentials.content, new Set(profiles));
    if (content) {
      mkdirSync(targetDir, { recursive: true });
      write(".aws/credentials", content, credentials.mode);
    }
  }

  if (config) {
    const sections = new Set<string>();
    const cacheKeys = new Set<string>();
    for (const name of profiles) {
      for (const section of profileSectionNames(name)) {
        if (!hasIniSection(config.content, section)) continue;
        sections.add(section);
        const ssoSession = getIniSectionValue(config.content, section, "sso_session");
        if (ssoSession) {
          sections.add(`sso-session ${ssoSession}`);
          cacheKeys.add(ssoSession);
          const sessionStartUrl = getIniSectionValue(config.content, `sso-session ${ssoSession}`, "sso_start_url");
          if (sessionStartUrl) cacheKeys.add(sessionStartUrl);
        }
        const legacyStartUrl = getIniSectionValue(config.content, section, "sso_start_url");
        if (legacyStartUrl) cacheKeys.add(legacyStartUrl);
      }
    }
    const content = filterIniSections(config.content, sections);
    if (content) {
      mkdirSync(targetDir, { recursive: true });
      write(".aws/config", content, config.mode);
    }
    for (const key of cacheKeys) {
      const fileName = `${createHash("sha1").update(key).digest("hex")}.json`;
      const token = readBoundedFile(join(awsDir, "sso", "cache", fileName));
      if (token) {
        write(`.aws/sso/cache/${fileName}`, token.content, 0o600);
      }
    }
  }

  return paths;
}

/** The profile and the profiles it reaches through `source_profile`, in order, without cycles. */
function profileChain(config: string, profile: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = profile;
  while (current && !chain.includes(current) && chain.length < maxChainLength) {
    chain.push(current);
    let next: string | undefined;
    for (const section of profileSectionNames(current)) {
      next ??= getIniSectionValue(config, section, "source_profile");
    }
    current = next;
  }
  return chain;
}

function profileSectionNames(profile: string): string[] {
  return profile === "default" ? ["default", "profile default"] : [`profile ${profile}`];
}

/** Reads a regular file (following symlinks) of at most maxAwsFileBytes; undefined otherwise. */
function readBoundedFile(path: string): { content: string; mode: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxAwsFileBytes) return undefined;
    const buffer = Buffer.alloc(maxAwsFileBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxAwsFileBytes) return undefined;
    }
    return { content: buffer.subarray(0, length).toString("utf8"), mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

function filterIniSections(content: string, sectionNames: Set<string>): string | undefined {
  const selected: string[] = [];
  let keep = false;
  for (const line of content.split(/\r?\n/)) {
    const section = parseIniSectionName(line);
    if (section !== undefined) {
      keep = sectionNames.has(section);
    }
    if (keep) {
      selected.push(line);
    }
  }
  return selected.length > 0 ? `${selected.join("\n").replace(/\n+$/, "")}\n` : undefined;
}

function hasIniSection(content: string, sectionName: string): boolean {
  return content.split(/\r?\n/).some((line) => parseIniSectionName(line) === sectionName);
}

function getIniSectionValue(content: string, sectionName: string, key: string): string | undefined {
  let inSection = false;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)\\s*$`);
  for (const line of content.split(/\r?\n/)) {
    const section = parseIniSectionName(line);
    if (section !== undefined) {
      inSection = section === sectionName;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const match = keyPattern.exec(line);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function parseIniSectionName(line: string): string | undefined {
  return /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1].trim().replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
