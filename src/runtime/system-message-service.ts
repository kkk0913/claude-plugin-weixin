import { MessageType } from '../weixin/types.js';

export interface SystemMessageServiceOptions {
  debug: (msg: string) => void;
  client: {
    isAuthed: boolean;
    userId?: string | null;
    sendMessage: (chatId: string, contextToken: string, item: any) => Promise<unknown>;
    getConfig: (userId: string, contextToken: string) => Promise<{ typing_ticket: string }>;
    sendTyping: (userId: string, ticket: string) => Promise<unknown>;
  };
}

export class SystemMessageService {
  private readonly debug: (msg: string) => void;
  private readonly client: SystemMessageServiceOptions['client'];

  constructor(options: SystemMessageServiceOptions) {
    this.debug = options.debug;
    this.client = options.client;
  }

  async sendPairingRequired(chatId: string, contextToken: string, code?: string): Promise<void> {
    try {
      await this.client.sendMessage(chatId, contextToken, {
        type: MessageType.TEXT,
        text_item: {
          text: `Pairing required — approve this code in your terminal:\n\n/weixin:access pair ${code ?? ''}`.trimEnd(),
        },
      });
    } catch (err) {
      this.debug(`pairing reply failed for ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  sendTypingIndicator(contextToken: string): void {
    if (!this.client.isAuthed || !this.client.userId) {
      return;
    }

    this.client.getConfig(this.client.userId, contextToken).then(cfg => {
      if (!cfg.typing_ticket) {
        return;
      }

      return this.client.sendTyping(this.client.userId!, cfg.typing_ticket);
    }).catch(err => {
      this.debug(`send typing failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
