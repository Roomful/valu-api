// ===========================================================================
// socket.io, in one place.
//
// Three things live here and nowhere else: the handshake options the Roomful
// platform socket needs, the `{data}` envelope, and the ack timeout. Both
// things that speak socket.io in this package — `SocketIoSocketAdapter` (a
// socket somebody else opened) and `ValuSocketConnection` (one this package
// opens) — go through `emitOverSocketIo`, so there is exactly one place where
// an RPC payload gets wrapped and exactly one place that can wrap it twice.
//
// socket.io-client is NOT a dependency of this package, and must not become
// one. It is already in every runtime that has a Roomful connection — the Valu
// Social build pins 2.5.0, the Valu Guru server requires the same major — and a
// second copy in the bundle is a second connection pool. So the client is
// INJECTED (`io`), with a dynamic import as a fallback for a runtime that has
// it installed but did not bother to pass it.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { normalizeAck } from './ValuSocket.js';

/** Where the Roomful socket.io endpoint is mounted. Not the default `/socket.io`. */
export const ROOMFUL_SOCKET_PATH = '/socket';

/**
 * The handshake, as both existing clients already do it.
 *
 * Lifted from valusocial-web `src/Services/WebSocket/WebSocket.js` and
 * valu-guru-server `src/server-agents/roomful-connection.ts` — the two
 * connections this package was written against. Each line is load-bearing:
 *
 * - `path` — the platform does not serve the socket.io default.
 * - `transports` + `upgrade: false` — websocket only. The polling fallback
 *   sends the session id as a query string on every XHR, not just once.
 * - `autoConnect: false` — the caller connects after its listeners are bound,
 *   so a `user_info` that arrives on the same tick is not missed.
 * - `forceNew` — without it `io()` reuses the cached Manager for this URL, and
 *   a reconnect with a NEW session waits out the previous engine's close
 *   handshake before it can open (the app's own comment, kept).
 */
export const SOCKET_IO_OPTIONS = Object.freeze({
  path: ROOMFUL_SOCKET_PATH,
  transports: ['websocket'],
  upgrade: false,
  autoConnect: false,
  forceNew: true,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5_000,
});

/**
 * Does this look like a socket.io client socket, as opposed to a `ValuSocket`
 * or the app's WebSocket service?
 *
 * All three have `emit`, which is why this question needs asking at all
 * (src/socket/open.js). A socket.io socket is the one with an event API and a
 * Manager or a namespace hanging off it; the other two have neither.
 * @param {any} value
 */
export function isSocketIoSocket(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.emit !== 'function' || typeof value.on !== 'function') return false;
  // `io` is the Manager (v2 and v4), `nsp` the namespace (v2), `connected` the
  // flag both expose. Any one of them is enough; the app's WebSocket service
  // has none of them, and a ValuSocket is branded instead (ValuSocket.js).
  return value.io !== undefined || value.nsp !== undefined || typeof value.connected === 'boolean';
}

/**
 * Load a socket.io client factory.
 *
 * @param {Function|{default: Function}} [injected] The `io` the runtime
 *   already has. Pass it — the fallback exists for scripts, not for builds: a
 *   bundler resolving the dynamic import below is how a second socket.io ends
 *   up in the bundle.
 * @returns {Promise<Function>}
 */
export async function loadSocketIo(injected) {
  const factory = injected?.default ?? injected;
  if (typeof factory === 'function') return factory;
  if (injected !== undefined) {
    throw new TypeError('`io` must be a socket.io-client factory function');
  }
  try {
    const module = await import('socket.io-client');
    const resolved = module?.default ?? module?.io ?? module;
    if (typeof resolved !== 'function') throw new TypeError('socket.io-client exported no factory');
    return resolved;
  } catch (error) {
    throw new Error(
      'socket.io-client is not available — pass it in as `io`. This package has no '
      + 'socket.io dependency on purpose: every runtime with a Roomful connection '
      + `already has one, and a second copy is a second connection pool. (${error?.message ?? error})`,
    );
  }
}

/**
 * One RPC over a socket.io socket, resolved as an ack. **Never rejects** —
 * that is the whole of the `ValuSocket` contract (src/socket/ValuSocket.js).
 *
 * @param {{emit: Function, connected?: boolean}} socket
 * @param {string} ns `<namespace>:<action>`, e.g. `social:getUsersSimpleInfo`.
 * @param {object} [data] The RPC's OWN payload. The Roomful `{data}` envelope
 *   is added HERE, which is why a caller must never add it: double-wrapped, the
 *   server answers a plausible "Resource not found" for something that exists.
 * @param {number} [timeoutMs]
 * @returns {Promise<import('./ValuSocket.js').ValuAck>}
 */
export function emitOverSocketIo(socket, ns, data = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!socket || typeof socket.emit !== 'function') {
    return Promise.resolve(errorAck(ERROR_CODES.DISCONNECTED, `emit ${ns}: no socket`));
  }
  // Fail now rather than in 30 seconds. socket.io buffers an emit made while
  // the socket is down and sends it on reconnect, but the ack callback is lost
  // with the old engine, so the caller would wait out the full timeout for an
  // answer that can never arrive.
  if (socket.connected === false) {
    return Promise.resolve(errorAck(ERROR_CODES.DISCONNECTED, `emit ${ns}: socket not connected`));
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (ack) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ack);
    };
    // NOT unref'd. This timer is the only thing that will ever settle the
    // promise the caller is awaiting, so letting the event loop drain past it
    // turns a timeout into a hang.
    const timer = setTimeout(
      () => settle(errorAck(ERROR_CODES.TIMEOUT, `emit ${ns} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    try {
      socket.emit(ns, { data }, (response) => settle(normalizeAck(response)));
    } catch (error) {
      settle(errorAck(ERROR_CODES.DISCONNECTED, `emit ${ns} failed: ${error?.message ?? error}`));
    }
  });
}
