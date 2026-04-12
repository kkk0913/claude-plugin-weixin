import { readFileSync } from 'node:fs';
import { getClaudeConfigPath } from './claude-config.js';

interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface StatsCache {
  dailyActivity: DailyActivity[];
  totalMessages: number;
  totalSessions: number;
  lastComputedDate: string;
}

export class ClaudeActivityProvider {
  getText(): string {
    try {
      const statsPath = getClaudeConfigPath('stats-cache.json');
      const raw = readFileSync(statsPath, 'utf-8');
      const stats: StatsCache = JSON.parse(raw);
      const today = new Date().toISOString().split('T')[0];
      const todayStats = stats.dailyActivity.find(day => day.date === today);
      const recentDays = stats.dailyActivity.slice(-7);
      const avgMessages = recentDays.length > 0
        ? Math.round(recentDays.reduce((acc, day) => acc + day.messageCount, 0) / recentDays.length)
        : 0;

      let text = '\n📈 使用统计\n';
      if (todayStats) {
        text += `今日: ${todayStats.messageCount} 消息 | ${todayStats.sessionCount} 会话 | ${todayStats.toolCallCount} 工具调用\n`;
      } else {
        text += '今日: 暂无数据\n';
      }
      text += `近7天平均: ${avgMessages} 消息/天\n`;
      text += `总计: ${stats.totalMessages} 消息 | ${stats.totalSessions} 会话`;
      return text;
    } catch {
      return '\n📈 使用统计: 暂无数据';
    }
  }
}
