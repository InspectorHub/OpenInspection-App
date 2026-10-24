import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realSocketFactory } from './real';

type Listener = (event: unknown) => void;

class StubWebSocket {
  static instances: StubWebSocket[] = [];
  binaryType = 'blob';
  readyState = 0;
  readonly listeners = new Map<string, Listener>();
  readonly sent: Uint8Array[] = [];
  closeCalls = 0;
  constructor(readonly url: string) {
    StubWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls += 1;
  }
  emit(type: string, event: unknown = {}): void {
    this.listeners.get(type)?.(event);
  }
}

beforeEach(() => {
  StubWebSocket.instances = [];
  vi.stubGlobal('WebSocket', StubWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function handlers() {
  return { open: vi.fn(), message: vi.fn(), close: vi.fn() };
}

describe('realSocketFactory', () => {
  it('opens the url, asks for binary frames and relays open, binary messages and close', () => {
    const h = handlers();
    const port = realSocketFactory('wss://oi.example.test/x', h);
    const stub = StubWebSocket.instances[0] as StubWebSocket;
    expect(stub.url).toBe('wss://oi.example.test/x');
    expect(stub.binaryType).toBe('arraybuffer');

    expect(port.isOpen()).toBe(false);
    stub.readyState = 1;
    stub.emit('open');
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(port.isOpen()).toBe(true);

    stub.emit('message', { data: Uint8Array.from([1, 2, 3]).buffer });
    expect(Array.from((h.message.mock.calls[0] as [Uint8Array])[0])).toEqual([1, 2, 3]);

    port.send(Uint8Array.from([9]));
    expect(stub.sent).toHaveLength(1);
    stub.emit('close');
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('drops text frames, and closes the socket on an error', () => {
    const h = handlers();
    realSocketFactory('wss://oi.example.test/x', h);
    const stub = StubWebSocket.instances[0] as StubWebSocket;
    stub.emit('message', { data: 'text frame' });
    expect(h.message).not.toHaveBeenCalled();
    stub.emit('error');
    expect(stub.closeCalls).toBe(1);
  });
});
