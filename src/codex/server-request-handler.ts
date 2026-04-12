import type { PendingApproval, CodexApprovalManager } from './approval-manager.js';
import type { CodexThreadManager } from './thread-manager.js';
import type { CodexServerRequest } from './types.js';

export interface CodexServerRequestHandlerOptions {
  approvalManager: CodexApprovalManager;
  threadManager: CodexThreadManager;
  getContextToken: (chatId: string) => string | undefined;
  replyText: (chatId: string, contextToken: string, text: string) => Promise<void>;
}

export class CodexServerRequestHandler {
  private readonly approvalManager: CodexApprovalManager;
  private readonly threadManager: CodexThreadManager;
  private readonly getContextToken: (chatId: string) => string | undefined;
  private readonly replyText: (chatId: string, contextToken: string, text: string) => Promise<void>;

  constructor(options: CodexServerRequestHandlerOptions) {
    this.approvalManager = options.approvalManager;
    this.threadManager = options.threadManager;
    this.getContextToken = options.getContextToken;
    this.replyText = options.replyText;
  }

  async handle(request: CodexServerRequest): Promise<unknown> {
    if (request.method === 'item/tool/call') {
      throw new Error('dynamic tool calls are not implemented by this bridge');
    }

    if (request.method === 'item/tool/requestUserInput') {
      const approvalChatId = this.threadManager.findChatIdByThreadId(request.params.threadId);
      if (approvalChatId) {
        await this.replyText(
          approvalChatId,
          this.getContextToken(approvalChatId) ?? '',
          'Codex requested interactive tool input that this bridge cannot relay yet. The request was answered with empty input.',
        );
      }
      return { answers: {} };
    }

    if (request.method === 'mcpServer/elicitation/request') {
      const approvalChatId = this.threadManager.findChatIdByThreadId(request.params.threadId);
      if (approvalChatId) {
        const body = request.params.mode === 'url'
          ? `${request.params.message}\n${request.params.url ?? ''}`
          : request.params.message;
        await this.replyText(
          approvalChatId,
          this.getContextToken(approvalChatId) ?? '',
          `Codex requested MCP elicitation, which this bridge cannot complete automatically:\n${body}`,
        );
      }
      return { action: 'decline', content: null, _meta: null };
    }

    const chatId = this.threadManager.findChatIdByThreadId(request.params.threadId);
    if (!chatId) {
      throw new Error(`no chat mapping found for thread ${request.params.threadId}`);
    }

    if (this.approvalManager.isAutoApproveEnabled()) {
      return this.approvalManager.buildApprovalResponse(request, true, true);
    }

    const requestId = String(request.id);
    return new Promise(resolve => {
      const approval: PendingApproval = {
        requestId,
        method: request.method,
        chatId,
        contextToken: this.getContextToken(chatId) ?? '',
        params: request.params,
        resolve,
      };
      this.approvalManager.queueApproval(approval);
    });
  }
}
