import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { LocalUsageCache } from '../state/usage-cache-repository.js';
import { UsageCacheRepository } from '../state/usage-cache-repository.js';
import { getClaudeConfigPath } from './claude-config.js';
import { USAGE_CACHE_FILE } from './paths.js';
import { formatClaudeUsageText } from './stats-format.js';

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const usageCacheRepository = new UsageCacheRepository(USAGE_CACHE_FILE);

interface ClaudeOauthCredentials {
  accessToken: string;
  subscriptionType: string;
}

function parseClaudeCredentials(raw: string): ClaudeOauthCredentials | null {
  try {
    const data = JSON.parse(raw);
    const oauth = data?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    const expiresAt = oauth.expiresAt;
    if (expiresAt != null && expiresAt <= Date.now()) return null;
    return {
      accessToken: oauth.accessToken,
      subscriptionType: oauth.subscriptionType ?? '',
    };
  } catch {
    return null;
  }
}

function readCredentialsFile(path: string): ClaudeOauthCredentials | null {
  try {
    if (!existsSync(path)) return null;
    return parseClaudeCredentials(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function readKeychainToken(): ClaudeOauthCredentials | null {
  try {
    const raw = execFileSync('security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-w',
    ], { timeout: 3000 }).toString().trim();
    return parseClaudeCredentials(raw);
  } catch {
    return null;
  }
}

function readClaudeOauthCredentials(debug?: (msg: string) => void): ClaudeOauthCredentials | null {
  const path = getClaudeConfigPath('.credentials.json');
  const creds = readCredentialsFile(path);
  if (creds) {
    debug?.(`stats: using Claude OAuth credentials from ${path}`);
    return creds;
  }

  const keychainCreds = readKeychainToken();
  if (keychainCreds) {
    debug?.('stats: using Claude OAuth credentials from macOS keychain');
    return keychainCreds;
  }

  debug?.('stats: unable to locate valid Claude OAuth credentials');
  return null;
}

function fetchOAuthUsage(accessToken: string): Promise<{
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
} | null> {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1',
      },
      timeout: 10000,
    }, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function clampPercent(v: number | undefined | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(Math.max(0, Math.min(100, v)));
}

function getPlanName(subscriptionType: string): string {
  const t = subscriptionType.toLowerCase();
  if (t.includes('pro')) return 'Pro';
  if (t.includes('max')) return 'Max';
  if (t.includes('team')) return 'Team';
  if (t.includes('enterprise')) return 'Enterprise';
  return subscriptionType || 'Pro';
}

export class ClaudeUsageProvider {
  private readonly debug?: (msg: string) => void;

  constructor(debug?: (msg: string) => void) {
    this.debug = debug;
  }

  async getText(): Promise<string> {
    const cached = usageCacheRepository.load();
    let staleCache: LocalUsageCache | null = null;
    if (cached) {
      if (Date.now() - cached.timestamp < USAGE_CACHE_TTL_MS) {
        this.debug?.('stats: serving Claude usage from fresh cache');
        return formatClaudeUsageText(cached);
      }
      staleCache = cached;
      this.debug?.('stats: Claude usage cache is stale; refreshing from API');
    }

    const creds = readClaudeOauthCredentials(this.debug);
    if (!creds) {
      this.debug?.('stats: Claude usage unavailable because credentials could not be read');
      return staleCache
        ? `${formatClaudeUsageText(staleCache)}⚠️ 数据来自缓存 (凭据读取失败)\n`
        : '❌ 用量信息: 无法读取凭据';
    }

    const apiData = await fetchOAuthUsage(creds.accessToken);
    if (!apiData) {
      this.debug?.('stats: Claude usage API request failed');
      return staleCache
        ? `${formatClaudeUsageText(staleCache)}⚠️ 数据来自旧缓存 (API 暂时不可用)\n`
        : '❌ 用量信息: API 暂时不可用';
    }

    const result: LocalUsageCache = {
      planName: getPlanName(creds.subscriptionType),
      fiveHour: clampPercent(apiData.five_hour?.utilization),
      sevenDay: clampPercent(apiData.seven_day?.utilization),
      fiveHourResetAt: apiData.five_hour?.resets_at ?? null,
      sevenDayResetAt: apiData.seven_day?.resets_at ?? null,
      timestamp: Date.now(),
    };

    usageCacheRepository.save(result);
    this.debug?.('stats: Claude usage refreshed from OAuth API');
    return formatClaudeUsageText(result);
  }
}
