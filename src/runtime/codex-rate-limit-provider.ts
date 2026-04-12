import type { CodexBridge } from '../codex/bridge.js';
import { formatCodexRateLimitsText } from './stats-format.js';

const CODEX_RATE_LIMIT_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface CodexRateLimitProviderOptions {
  debug: (msg: string) => void;
  getCodexBridge: () => Promise<CodexBridge | null>;
  model?: string;
}

export class CodexRateLimitProvider {
  private readonly debug: (msg: string) => void;
  private readonly getCodexBridge: () => Promise<CodexBridge | null>;
  private readonly model?: string;

  constructor(options: CodexRateLimitProviderOptions) {
    this.debug = options.debug;
    this.getCodexBridge = options.getCodexBridge;
    this.model = options.model;
  }

  async getText(): Promise<string> {
    try {
      this.debug('stats: reading Codex rate limits');
      const bridge = await withTimeout(
        this.getCodexBridge(),
        CODEX_RATE_LIMIT_TIMEOUT_MS,
        'getCodexBridge',
      );
      if (!bridge) {
        this.debug('stats: Codex bridge unavailable');
        return '\n🤖 Codex Rate Limit: Codex 未启动';
      }

      const rateLimits = await withTimeout(
        bridge.getRateLimits(),
        CODEX_RATE_LIMIT_TIMEOUT_MS,
        'codex rate limits',
      );
      if (!rateLimits) {
        this.debug('stats: Codex rate limits unavailable');
        return '\n🤖 Codex Rate Limit: 暂时不可用';
      }

      this.debug('stats: Codex rate limits refreshed');
      return formatCodexRateLimitsText(rateLimits, this.model);
    } catch (err) {
      this.debug(`stats: Codex rate limits failed: ${err instanceof Error ? err.message : String(err)}`);
      return '\n🤖 Codex Rate Limit: 查询超时或失败';
    }
  }
}
