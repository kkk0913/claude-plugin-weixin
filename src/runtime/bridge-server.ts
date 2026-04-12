import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BridgeEvent,
  BridgeEventAckParams,
  BridgeMessage,
  BridgePermissionRequestParams,
  BridgeToolCallRequest,
  BridgeToolCallResult,
} from '../ipc/protocol.js';
import { attachBridgeMessageParser, isBridgeSocketWritable, writeBridgeMessage } from '../ipc/wire.js';

export interface ClaudeClientSession {
  clientId: string;
  socket: net.Socket;
  connectedAt: number;
}

export interface BridgeServerHandlers {
  debug: (msg: string) => void;
  onToolCall: (req: BridgeToolCallRequest) => Promise<BridgeToolCallResult>;
  onPermissionRequest: (params: BridgePermissionRequestParams) => Promise<void>;
}

const SINGLE_CLIENT_ERROR = 'claude proxy already registered';
const EVENT_ACK_TIMEOUT_MS = 5000;

function sendBridgeResponse(socket: net.Socket, id: string, ok: true, result?: unknown): void;
function sendBridgeResponse(socket: net.Socket, id: string, ok: false, error: string): void;
async function sendBridgeResponse(socket: net.Socket, id: string, ok: boolean, payload?: unknown): Promise<void> {
  if (ok) {
    await writeBridgeMessage(socket, { kind: 'response', id, ok: true, result: payload });
    return;
  }
  await writeBridgeMessage(socket, { kind: 'response', id, ok: false, error: String(payload ?? 'unknown error') });
}

export class ClaudeBridgeServer {
  private readonly socketPath: string;
  private readonly handlers: BridgeServerHandlers;
  private readonly claudeClients = new Map<string, ClaudeClientSession>();
  private activeClaudeClientId: string | null = null;
  private server: net.Server | null = null;
  private eventWriteChain = Promise.resolve();
  private readonly pendingEventAcks = new Map<string, { clientId: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(socketPath: string, handlers: BridgeServerHandlers) {
    this.socketPath = socketPath;
    this.handlers = handlers;
  }

  hasActiveClient(): boolean {
    return this.getActiveClient() !== null;
  }

  sendEventToClaude(event: BridgeEvent): boolean {
    const claudeClient = this.getActiveClient();
    if (!claudeClient) {
      return false;
    }
    if (!isBridgeSocketWritable(claudeClient.socket)) {
      this.handlers.debug(`bridge event dropped: claude socket not writable for client=${claudeClient.clientId}`);
      this.unregisterClaudeClient(claudeClient.clientId);
      return false;
    }
    const eventId = randomBytes(8).toString('hex');
    const eventWithAck = { ...event, event_id: eventId } as BridgeEvent;
    const timer = setTimeout(() => {
      this.pendingEventAcks.delete(eventId);
      this.handlers.debug(`bridge event ack timed out for client=${claudeClient.clientId} event=${eventId} method=${event.method}`);
      claudeClient.socket.destroy();
    }, EVENT_ACK_TIMEOUT_MS);
    timer.unref();
    this.pendingEventAcks.set(eventId, { clientId: claudeClient.clientId, timer });

    this.eventWriteChain = this.eventWriteChain
      .then(async () => {
        await writeBridgeMessage(claudeClient.socket, eventWithAck);
      })
      .catch(err => {
        const pendingAck = this.pendingEventAcks.get(eventId);
        if (pendingAck) {
          clearTimeout(pendingAck.timer);
          this.pendingEventAcks.delete(eventId);
        }
        this.handlers.debug(`bridge event write failed for client=${claudeClient.clientId}: ${err instanceof Error ? err.message : String(err)}`);
        claudeClient.socket.destroy();
      });
    return true;
  }

  closeAllClients(): void {
    for (const session of this.claudeClients.values()) {
      session.socket.destroy();
    }
    this.claudeClients.clear();
    this.activeClaudeClientId = null;
  }

  async listen(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true });
    await this.ensureSocketAvailable();
    this.server = net.createServer(socket => {
      let registeredClientId: string | null = null;

      attachBridgeMessageParser(
        socket,
        message => {
          if (message.kind === 'request' && message.method === 'claude/register') {
            registeredClientId = message.params.clientId;
          }
          void this.handleBridgeRequest(socket, message);
        },
        err => {
          this.handlers.debug(`bridge parse failed: ${err.message}`);
        },
      );

      socket.on('close', () => {
        if (registeredClientId) {
          this.unregisterClaudeClient(registeredClientId);
        }
      });
      socket.on('error', err => {
        this.handlers.debug(`bridge socket error: ${err.message}`);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });

    try {
      chmodSync(this.socketPath, 0o600);
    } catch {
      // Ignore chmod failure on unsupported platforms.
    }
    this.handlers.debug(`daemon bridge listening: ${this.socketPath}`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Ignore socket cleanup failures.
    }
  }

  private getActiveClient(): ClaudeClientSession | null {
    if (!this.activeClaudeClientId) {
      return null;
    }
    return this.claudeClients.get(this.activeClaudeClientId) ?? null;
  }

  private pickNewestClaudeClient(): ClaudeClientSession | null {
    let newest: ClaudeClientSession | null = null;
    for (const clientSession of this.claudeClients.values()) {
      if (!newest || clientSession.connectedAt > newest.connectedAt) {
        newest = clientSession;
      }
    }
    return newest;
  }

  private registerClaudeClient(clientId: string, socket: net.Socket): void {
    const activeClient = this.getActiveClient();
    if (activeClient && activeClient.clientId !== clientId) {
      throw new Error(`${SINGLE_CLIENT_ERROR}: ${activeClient.clientId}`);
    }
    const session: ClaudeClientSession = {
      clientId,
      socket,
      connectedAt: Date.now(),
    };
    this.claudeClients.set(clientId, session);
    this.activeClaudeClientId = clientId;
    this.handlers.debug(`claude proxy registered: client=${clientId} pid=${process.pid}`);
  }

  private unregisterClaudeClient(clientId: string): void {
    this.claudeClients.delete(clientId);
    for (const [eventId, pending] of this.pendingEventAcks) {
      if (pending.clientId === clientId) {
        clearTimeout(pending.timer);
        this.pendingEventAcks.delete(eventId);
      }
    }
    if (this.activeClaudeClientId === clientId) {
      this.activeClaudeClientId = this.pickNewestClaudeClient()?.clientId ?? null;
    }
    this.handlers.debug(`claude proxy disconnected: client=${clientId}`);
  }

  private async handleBridgeRequest(socket: net.Socket, message: BridgeMessage): Promise<void> {
    if (message.kind !== 'request') {
      return;
    }

    try {
      switch (message.method) {
        case 'daemon/ping':
          await sendBridgeResponse(socket, message.id, true, { ok: true });
          return;

        case 'claude/register':
          this.registerClaudeClient(message.params.clientId, socket);
          await sendBridgeResponse(socket, message.id, true, { active: true });
          return;

        case 'event/ack':
          this.handleEventAck(message.params);
          await sendBridgeResponse(socket, message.id, true, { acknowledged: true });
          return;

        case 'tool/call':
          await sendBridgeResponse(socket, message.id, true, await this.handlers.onToolCall(message.params));
          return;

        case 'claude/permission_request':
          await this.handlers.onPermissionRequest(message.params);
          await sendBridgeResponse(socket, message.id, true, { queued: true });
          return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await sendBridgeResponse(socket, message.id, false, msg);
      } catch (writeErr) {
        this.handlers.debug(`bridge response write failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
    }
  }

  private handleEventAck(params: BridgeEventAckParams): void {
    const pending = this.pendingEventAcks.get(params.event_id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingEventAcks.delete(params.event_id);
    if (!params.ok) {
      this.handlers.debug(`bridge event ack failed for client=${pending.clientId} event=${params.event_id}: ${params.error ?? 'unknown error'}`);
      const client = this.claudeClients.get(pending.clientId);
      client?.socket.destroy();
    }
  }

  private async ensureSocketAvailable(): Promise<void> {
    if (!existsSync(this.socketPath)) {
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const probe = net.createConnection(this.socketPath);
        probe.once('connect', () => {
          probe.end();
          resolve();
        });
        probe.once('error', err => reject(err));
      });
      throw new Error(`weixin daemon already running on ${this.socketPath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (String(err).includes('already running')) {
        throw err;
      }
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') {
        throw err;
      }
    }

    try {
      unlinkSync(this.socketPath);
    } catch {
      // Ignore stale socket cleanup failure.
    }
  }
}
