import type { CollabSocket, SocketFactory } from './connector';

const OPEN = 1;

/**
 * The page's WebSocket behind the connector's socket port. Text frames are dropped (the protocol is binary),
 * and an error closes the socket so the connector sees one `close` for every failure.
 */
export const realSocketFactory: SocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    handlers.open();
  });
  socket.addEventListener('message', (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) handlers.message(new Uint8Array(event.data));
  });
  socket.addEventListener('close', () => {
    handlers.close();
  });
  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch {
      // Already closing; the close event follows.
    }
  });
  const port: CollabSocket = {
    isOpen: () => socket.readyState === OPEN,
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      socket.close();
    },
  };
  return port;
};
