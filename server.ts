#!/usr/bin/env node

import { loadProjectEnv, getEnvSummary } from './src/runtime/env.js';

loadProjectEnv();

function debugLog(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function getServerRole(): 'daemon' | 'proxy' {
  if (process.env.WEIXIN_SERVER_ROLE === 'daemon' || process.argv.includes('--daemon')) {
    return 'daemon';
  }
  if (process.env.WEIXIN_SERVER_ROLE === 'proxy') {
    return 'proxy';
  }
  return process.stdin.isTTY ? 'daemon' : 'proxy';
}

async function main(): Promise<void> {
  const { ensureStateDirReady } = await import('./src/runtime/state-dir.js');
  const stateDir = ensureStateDirReady();
  const bridgeSocketPath = `${stateDir}/daemon.sock`;

  if (getServerRole() === 'daemon') {
    process.stderr.write(`${getEnvSummary()}\n`);
    const { runWeixinDaemon } = await import('./src/runtime/daemon.js');
    await runWeixinDaemon();
    return;
  }

  const { runClaudeProxy } = await import('./src/claude/proxy.js');
  await runClaudeProxy({
    bridgeSocketPath,
    debug: debugLog,
  });
}

void main().catch(err => {
  process.stderr.write(`weixin channel: fatal: ${err}\n`);
  process.exit(1);
});
