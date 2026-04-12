import net from 'node:net';
import type { BridgeMessage } from './protocol.js';

export type BridgeMessageHandler = (message: BridgeMessage) => void;

export function isBridgeSocketWritable(socket: net.Socket): boolean {
  return !socket.destroyed && socket.writable;
}

export async function writeBridgeMessage(socket: net.Socket, message: BridgeMessage): Promise<void> {
  if (!isBridgeSocketWritable(socket)) {
    throw new Error('bridge socket is not writable');
  }

  const payload = JSON.stringify(message) + '\n';
  await new Promise<void>((resolve, reject) => {
    socket.write(payload, err => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export function attachBridgeMessageParser(
  socket: net.Socket,
  onMessage: BridgeMessageHandler,
  onError?: (err: Error) => void,
): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      try {
        onMessage(JSON.parse(line) as BridgeMessage);
      } catch (err) {
        if (onError) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  });
}
