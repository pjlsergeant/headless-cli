import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes `<seedDir>/.aws/{credentials,config}` holding only the sections for
 * `profile` (and the sso-session it references) from `awsDir`, so a sandbox
 * gets the selected profile and not every profile on the host. Returns the
 * written paths relative to `seedDir`.
 */
export function seedAwsProfileFiles(awsDir: string, seedDir: string, profile: string): string[] {
  const paths: string[] = [];
  const credentialsPath = join(awsDir, "credentials");
  const configPath = join(awsDir, "config");
  const targetDir = join(seedDir, ".aws");

  if (existsSync(credentialsPath) && lstatSync(credentialsPath).isFile()) {
    const content = filterIniSections(readFileSync(credentialsPath, "utf8"), new Set([profile]));
    if (content) {
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, "credentials");
      writeFileSync(target, content, { mode: lstatSync(credentialsPath).mode & 0o777 });
      paths.push(".aws/credentials");
    }
  }

  if (existsSync(configPath) && lstatSync(configPath).isFile()) {
    const config = readFileSync(configPath, "utf8");
    const profileSection = profile === "default" ? "default" : `profile ${profile}`;
    const sections = new Set([profileSection]);
    const ssoSession = getIniSectionValue(config, profileSection, "sso_session");
    if (ssoSession) {
      sections.add(`sso-session ${ssoSession}`);
    }
    const content = filterIniSections(config, sections);
    if (content) {
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, "config");
      writeFileSync(target, content, { mode: lstatSync(configPath).mode & 0o777 });
      paths.push(".aws/config");
    }
  }

  return paths;
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
  return /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
