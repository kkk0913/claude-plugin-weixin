import type { CodexBridge } from '../codex/bridge.js';
import { ClaudeActivityProvider } from './claude-activity-provider.js';
import { ClaudeUsageProvider } from './claude-usage-provider.js';
import { CodexRateLimitProvider } from './codex-rate-limit-provider.js';

export interface StatsServiceOptions {
  debug: (msg: string) => void;
  getCodexBridge: () => Promise<CodexBridge | null>;
  model?: string;
}

export class StatsService {
  private readonly claudeUsageProvider: ClaudeUsageProvider;
  private readonly claudeActivityProvider: ClaudeActivityProvider;
  private readonly codexRateLimitProvider: CodexRateLimitProvider;

  constructor(options: StatsServiceOptions) {
    this.claudeUsageProvider = new ClaudeUsageProvider(options.debug);
    this.claudeActivityProvider = new ClaudeActivityProvider();
    this.codexRateLimitProvider = new CodexRateLimitProvider(options);
  }

  async getCombinedStatsText(): Promise<string> {
    const [claudeUsage, codexRateLimits] = await Promise.all([
      this.claudeUsageProvider.getText(),
      this.codexRateLimitProvider.getText(),
    ]);
    return `${claudeUsage}${this.claudeActivityProvider.getText()}${codexRateLimits}`;
  }
}
