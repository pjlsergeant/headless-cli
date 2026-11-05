/**
 * A deliberately small reader for plain string settings at the root of a
 * TOML file (before the first table header), shared by the places that
 * inspect native Codex configuration without a full TOML parser.
 */
export class UninspectableTomlError extends Error {
  constructor() {
    super("TOML root setting is not a plain quoted string");
  }
}

/**
 * Returns the root-level string value of `key`, or undefined when the key is
 * absent. Bare and quoted keys match; assignments inside multiline strings
 * are skipped. Throws UninspectableTomlError when the key is present but its
 * value is not a single-line quoted string.
 */
export function rootTomlString(content: string | undefined, key: string): string | undefined {
  let multiline: string | undefined;
  for (const line of (content ?? "").split(/\r?\n/)) {
    if (multiline) {
      if (line.includes(multiline)) multiline = undefined;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    if (trimmed.startsWith("#")) continue;
    const assignment = trimmed.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const name = /^["']/.test(assignment[1] as string) ? tomlString(assignment[1] as string) : assignment[1];
    const rawValue = assignment[2] as string;
    const triple = rawValue.match(/^("""|''')/);
    if (triple) {
      if (name === key) throw new UninspectableTomlError();
      if (!rawValue.slice(3).includes(triple[1] as string)) multiline = triple[1];
      continue;
    }
    if (name !== key) continue;
    const single = rawValue.match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!single) throw new UninspectableTomlError();
    return tomlString(single[1] as string);
  }
  return undefined;
}

function tomlString(value: string): string {
  if (value.startsWith("'")) return value.slice(1, -1);
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new UninspectableTomlError();
  }
}
