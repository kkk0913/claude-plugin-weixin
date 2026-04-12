import { FlagFile } from '../state/flag-file.js';
import type {
  CodexServerRequest,
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  PermissionsRequestApprovalParams,
  RequestPermissionProfile,
} from './types.js';

export type PendingApproval =
  | {
      requestId: string;
      method: 'item/commandExecution/requestApproval';
      chatId: string;
      contextToken: string;
      params: CodexServerRequest['params'];
      resolve: (value: unknown) => void;
    }
  | {
      requestId: string;
      method: 'item/fileChange/requestApproval';
      chatId: string;
      contextToken: string;
      params: CodexServerRequest['params'];
      resolve: (value: unknown) => void;
    }
  | {
      requestId: string;
      method: 'item/permissions/requestApproval';
      chatId: string;
      contextToken: string;
      params: CodexServerRequest['params'];
      resolve: (value: unknown) => void;
    };

export interface CodexApprovalManagerOptions {
  autoApproveFile: string;
  debug: (msg: string) => void;
  sendText: (chatId: string, contextToken: string, text: string) => Promise<void>;
}

export class CodexApprovalManager {
  private readonly debug: (msg: string) => void;
  private readonly sendText: (chatId: string, contextToken: string, text: string) => Promise<void>;
  private readonly autoApproveFlag: FlagFile;
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(options: CodexApprovalManagerOptions) {
    this.debug = options.debug;
    this.sendText = options.sendText;
    this.autoApproveFlag = new FlagFile(options.autoApproveFile);
  }

  isAutoApproveEnabled(): boolean {
    return this.autoApproveFlag.isEnabled();
  }

  disableAutoApprove(): void {
    this.autoApproveFlag.disable();
  }

  queueApproval(approval: PendingApproval): void {
    this.pendingApprovals.set(approval.requestId, approval);
    this.debug(`codex approval/request: chat=${approval.chatId} request=${approval.requestId} method=${approval.method}`);
    void this.sendText(approval.chatId, approval.contextToken, this.formatApprovalRequest(approval));
  }

  async maybeHandleApprovalReply(chatId: string, contextToken: string, text: string): Promise<boolean> {
    const trimmed = text.trim().toLowerCase();

    if (trimmed === 'yesall') {
      const approvals = this.listPendingApprovals(chatId);
      if (approvals.length === 0) {
        return false;
      }
      for (const approval of approvals) {
        await this.resolveApproval(approval, true, false);
      }
      await this.sendText(chatId, contextToken, `已全部允许 ✓ (${approvals.length})`);
      return true;
    }

    if (trimmed === 'stopall') {
      this.disableAutoApprove();
      await this.sendText(chatId, contextToken, 'Auto-approve disabled.');
      return true;
    }

    const match = /^\s*(y|yes|n|no)\s*$/i.exec(text);
    if (!match) {
      return false;
    }

    const approval = this.listPendingApprovals(chatId)[0];
    if (!approval) {
      return false;
    }

    const allow = match[1]!.toLowerCase().startsWith('y');
    await this.resolveApproval(approval, allow, false);
    await this.sendText(chatId, contextToken, allow ? 'Approved.' : 'Denied.');
    return true;
  }

  buildApprovalResponse(request: CodexServerRequest, allow: boolean, sessionScope: boolean): unknown {
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        return {
          decision: allow
            ? (sessionScope ? 'acceptForSession' : 'accept')
            : 'decline',
        };

      case 'item/fileChange/requestApproval':
        return {
          decision: allow
            ? (sessionScope ? 'acceptForSession' : 'accept')
            : 'decline',
        };

      case 'item/permissions/requestApproval':
        return {
          permissions: allow ? request.params.permissions : { network: null, fileSystem: null },
          scope: sessionScope ? 'session' : 'turn',
        };

      case 'item/tool/requestUserInput':
        return { answers: {} };

      case 'mcpServer/elicitation/request':
        return { action: allow ? 'accept' : 'decline', content: null, _meta: null };

      case 'item/tool/call':
        throw new Error('dynamic tool calls are not implemented by this bridge');
    }
  }

  private listPendingApprovals(chatId: string): PendingApproval[] {
    return [...this.pendingApprovals.values()].filter(approval => approval.chatId === chatId);
  }

  private async resolveApproval(approval: PendingApproval, allow: boolean, sessionScope: boolean): Promise<void> {
    const response = this.buildApprovalResponse(
      {
        id: approval.requestId,
        method: approval.method,
        params: approval.params,
      } as CodexServerRequest,
      allow,
      sessionScope,
    );

    this.pendingApprovals.delete(approval.requestId);
    approval.resolve(response);
  }

  private formatApprovalRequest(approval: PendingApproval): string {
    if (approval.method === 'item/commandExecution/requestApproval') {
      return this.formatCommandApproval(approval.params as CommandExecutionRequestApprovalParams);
    }
    if (approval.method === 'item/fileChange/requestApproval') {
      return this.formatFileChangeApproval(approval.params as FileChangeRequestApprovalParams);
    }
    return this.formatPermissionsApproval(approval.params as PermissionsRequestApprovalParams);
  }

  private formatCommandApproval(params: CommandExecutionRequestApprovalParams): string {
    return [
      '类型: 命令执行',
      `操作: ${params.command ?? params.reason ?? '执行命令'}`,
    ].join('\n');
  }

  private formatFileChangeApproval(params: FileChangeRequestApprovalParams): string {
    return [
      '类型: 文件变更',
      `操作: ${params.reason ?? params.grantRoot ?? '修改文件'}`,
    ].join('\n');
  }

  private formatPermissionsApproval(params: PermissionsRequestApprovalParams): string {
    return [
      '类型: 权限申请',
      `操作: ${params.reason ?? this.formatRequestedPermissions(params.permissions)}`,
    ].join('\n');
  }

  private formatRequestedPermissions(permissions: RequestPermissionProfile): string {
    return JSON.stringify(permissions);
  }
}
