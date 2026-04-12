import { homedir } from 'node:os';
import { join } from 'node:path';

export function getClaudeConfigDir(): string {
  const configured = process.env.WEIXIN_CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    return configured;
  }
  return join(homedir(), '.claude');
}

export function getClaudeConfigPath(fileName: string): string {
  return join(getClaudeConfigDir(), fileName);
}
