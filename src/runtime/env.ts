import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadProjectEnv(cwd = process.cwd()): void {
  const envPath = process.env.WEIXIN_ENV_FILE?.trim() || join(cwd, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1]!;
    const value = stripWrappingQuotes(match[2]!.trim());
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
