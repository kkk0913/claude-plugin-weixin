import type {
  AccountConfig,
  BaseInfo,
  GetConfigReq,
  GetConfigResp,
  GetUpdatesReq,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  LoginQrResp,
  MessageItem,
  QrStatusResp,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
} from './types.js';
import { encodeVersion, randomUinBase64, createBaseInfo } from '../util/helpers.js';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 35_000;
const APP_ID = 'wx_a49d74b07c844cd0';
const APP_VERSION = '2.1.3';

export interface WeixinClientOptions {
  baseUrl?: string;
  timeout?: number;
}

export class WeixinClient {
  private config: AccountConfig | null = null;
  private baseUrl: string;
  private timeout: number;
  private baseInfo: BaseInfo;
  private clientVersion: number;
  private uin: string;

  constructor(opts: WeixinClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    this.baseInfo = createBaseInfo(APP_VERSION);
    this.clientVersion = encodeVersion(APP_VERSION);
    this.uin = randomUinBase64();
  }

  get isAuthed(): boolean {
    return this.config !== null;
  }

  get userId(): string | null {
    return this.config?.userId ?? null;
  }

  get token(): string | null {
    return this.config?.token ?? null;
  }

  /**
   * Authenticate with an existing token (from saved config).
   */
  setAuth(config: AccountConfig): void {
    this.config = config;
    if (config.baseUrl) {
      this.baseUrl = config.baseUrl;
    }
  }

  /**
   * Full QR login flow: get QR → poll status → return AccountConfig.
   * Retries up to 3 times on QR expiration.
   * Throws on timeout or error.
   */
  async loginWithQr(onQr?: (data: { qrUrl: string; status?: string }) => void | Promise<void>): Promise<AccountConfig> {
    const maxRetries = 3;

    for (let retry = 0; retry < maxRetries; retry++) {
      // Step 1: get QR code (GET, no auth — matches openclaw-weixin)
      const qrResp = await this.get<LoginQrResp>('/ilink/bot/get_bot_qrcode?bot_type=3');
      if (qrResp.ret !== 0) {
        throw new Error(`Failed to get QR code: ${qrResp.errmsg} (${qrResp.ret})`);
      }

      // qrcode_img_content is actually the scannable QR URL (not a PNG image)
      if (onQr && qrResp.qrcode_img_content) {
        await onQr({ qrUrl: qrResp.qrcode_img_content });
      }

      // Step 2: poll for scan/confirm
      const maxAttempts = 120; // 2 minutes at 1s intervals
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const status = await this.get<QrStatusResp>(
          `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrResp.qrcode)}`,
        );

        if (status.status === 'confirmed' && status.bot_token) {
          this.config = {
            token: status.bot_token,
            baseUrl: status.baseurl ?? this.baseUrl,
            userId: status.ilink_user_id!,
            ilinkBotId: status.ilink_bot_id!,
          };
          if (status.baseurl) {
            this.baseUrl = status.baseurl;
          }
          return this.config;
        }

        if (status.status === 'scaned') {
          if (onQr) await onQr({ qrUrl: '', status: 'scaned' });
          continue;
        }

        if (status.status === 'scaned_but_redirect' && status.redirect_host) {
          // Server wants us to use a different host — update baseUrl and retry
          this.baseUrl = `https://${status.redirect_host}`;
          if (onQr) await onQr({ qrUrl: '', status: 'scaned' });
          continue;
        }

        if (status.status === 'expired') {
          break; // break inner loop to retry with new QR
        }

        // ret: 0 = ok, 1 = waiting for scan/confirm, -1 = in progress
        if (status.ret !== 0 && status.ret !== 1 && status.ret !== -1) {
          throw new Error(`QR status error: ${status.errmsg} (${status.ret})`);
        }
      }
      // QR expired — loop will retry with a fresh QR
    }
    throw new Error('QR login timed out after retries');
  }

  /**
   * Long-poll for new messages.
   */
  async getUpdates(cursor: string = ''): Promise<GetUpdatesResp> {
    const body: GetUpdatesReq = {
      get_updates_buf: cursor,
      base_info: this.baseInfo,
    };
    return this.post<GetUpdatesResp>(
      '/ilink/bot/getupdates',
      body,
      LONG_POLL_TIMEOUT_MS,
    );
  }

  /**
   * Send a message to a user.
   */
  async sendMessage(
    toUserId: string,
    contextToken: string,
    item: MessageItem,
  ): Promise<SendMessageResp> {
    const now = Date.now();
    const { generateClientId } = await import('../util/helpers.js');
    const msg = {
      seq: 0,
      message_id: 0,
      from_user_id: this.config!.userId,
      to_user_id: toUserId,
      client_id: generateClientId(),
      create_time_ms: now,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [item],
      context_token: contextToken,
    };
    const body: SendMessageReq = { msg, base_info: this.baseInfo };
    const resp = await this.post<SendMessageResp>('/ilink/bot/sendmessage', body);
    if (resp.ret !== 0) {
      throw new Error(`sendMessage failed: ${resp.errmsg} (${resp.ret})`);
    }
    return resp;
  }

  /**
   * Send typing indicator.
   */
  async sendTyping(ilinkUserId: string, typingTicket: string): Promise<void> {
    const body: SendTypingReq = {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status: 1, // TYPING
    };
    await this.post('/ilink/bot/sendtyping', body);
  }

  /**
   * Get config (typing ticket).
   */
  async getConfig(ilinkUserId: string, contextToken?: string): Promise<GetConfigResp> {
    const body: GetConfigReq = {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: this.baseInfo,
    };
    return this.post<GetConfigResp>('/ilink/bot/getconfig', body);
  }

  /**
   * Get upload URL for CDN media.
   */
  async getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp> {
    return this.post<GetUploadUrlResp>('/ilink/bot/getuploadurl', {
      ...req,
      base_info: this.baseInfo,
    });
  }

  // ─── Internal HTTP ──────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': this.clientVersion.toString(),
      'X-WECHAT-UIN': this.uin,
    };
    if (this.config) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }
    return headers;
  }

  private async get<T>(path: string, timeout?: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout ?? this.timeout);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeout?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout ?? this.timeout);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
