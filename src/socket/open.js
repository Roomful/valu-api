// ===========================================================================
// Getting a socket — the two doors, and the one place they meet.
//
//   await openValuSocket({ sessionId })   // open it, and authorize it
//   await openValuSocket({ socket })      // use one that is already authorized
//
// Everything above this file takes a `ValuSocket` and cannot tell which door it
// came through. That is the point: `createValuServices({ socket })` is one call
// whether the application opened the connection or the package did, so adding
// the first door did not add a second way to use this library.
//
// The second door accepts the three things a caller might actually be holding,
// because "already authorized socket" means different objects in different
// runtimes and making the caller pick the right adapter is making them learn
// our class names to answer a question we can answer ourselves
// (docs/connecting.md):
//
//   a ValuSocket                      → used as it is, never wrapped twice
//   the app's WebSocket service       → BrowserSocketAdapter   (has emitAsync)
//   a socket.io socket                → SocketIoSocketAdapter  (has emit + on)
//   a RoomfulConnectionManager        → NodeSocketAdapter      (has emit)
// ===========================================================================
import { isValuSocket } from './ValuSocket.js';
import { isSocketIoSocket } from './socketio.js';
import { BrowserSocketAdapter } from './BrowserSocketAdapter.js';
import { SocketIoSocketAdapter } from './SocketIoSocketAdapter.js';
import { NodeSocketAdapter } from './NodeSocketAdapter.js';
import { ValuSocketConnection } from './ValuSocketConnection.js';

/**
 * Make a `ValuSocket` out of whatever authorized connection the caller has.
 *
 * Synchronous and side-effect free: it opens nothing, authorizes nothing and
 * closes nothing. The runtime that owns the connection keeps owning it.
 *
 * @param {any} input A `ValuSocket`, the Valu Social application's WebSocket
 *   service, a socket.io socket, or a `RoomfulConnectionManager`.
 * @param {object} [options]
 * @param {string} [options.userId] Who the connection is credentialed as.
 *   Required by `BrowserSocketAdapter`; the other two resolve it themselves.
 * @param {string} [options.networkId]
 * @param {string|null} [options.selfUserId]
 * @param {(handler: (data: any) => void) => (() => void)} [options.onResourceUpdated]
 *   Only used for the app's WebSocket service, which cannot subscribe itself.
 * @param {number} [options.timeoutMs]
 * @returns {import('./ValuSocket.js').ValuSocket}
 */
export function adoptValuSocket(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new TypeError(
      'adoptValuSocket needs a socket: a ValuSocket, the application\'s WebSocket '
      + 'service, a socket.io socket, or a RoomfulConnectionManager.',
    );
  }

  // Already one of ours. Returned by identity, not re-wrapped: consumers key
  // per-connection state on the socket object (ServiceClient's cache, the Guru
  // server's WeakMap), and a second wrapper is a second identity for one
  // connection.
  if (isValuSocket(input)) return input;

  // The Valu Social application's WebSocket service. `emitAsync` is the tell,
  // and the reason it needs its own adapter: it REJECTS where ValuSocket.emit
  // must resolve an error ack (src/socket/BrowserSocketAdapter.js).
  if (typeof input.emitAsync === 'function') {
    return new BrowserSocketAdapter({
      socket: input,
      userId: options.userId,
      ...(options.networkId !== undefined ? { networkId: options.networkId } : {}),
      ...(options.selfUserId !== undefined ? { selfUserId: options.selfUserId } : {}),
      ...(options.onResourceUpdated ? { onResourceUpdated: options.onResourceUpdated } : {}),
    });
  }

  // A socket.io socket — the raw thing. Checked before the generic `emit` case
  // because socket.io's `emit` is fire-and-forget with an ack CALLBACK, not a
  // promise, and handing it to NodeSocketAdapter would await undefined.
  if (isSocketIoSocket(input)) {
    return new SocketIoSocketAdapter({
      socket: input,
      userId: options.userId,
      ...(options.networkId !== undefined ? { networkId: options.networkId } : {}),
      ...(options.selfUserId !== undefined ? { selfUserId: options.selfUserId } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  // Anything else that emits and resolves: the headless connection contract.
  // This is also where an UNBRANDED socket that already satisfies `ValuSocket`
  // lands — a third-party adapter, or a `RoomfulConnectionManager`, which look
  // alike from here (src/socket/ValuSocket.js isValuSocket). Wrapping a
  // compliant one costs nothing: the adapter forwards every member live and
  // republishes the original as `underlying`, so a consumer keying on
  // `underlying ?? socket` sees the same identity either way.
  if (typeof input.emit === 'function') {
    return new NodeSocketAdapter({
      connection: input,
      ...(options.networkId !== undefined ? { networkId: options.networkId } : {}),
    });
  }

  throw new TypeError(
    'adoptValuSocket got an object with no emit() — it is not a Roomful socket. '
    + 'Pass the application\'s WebSocket service, a socket.io socket, a '
    + 'RoomfulConnectionManager, or a ValuSocket.',
  );
}

/**
 * A `ValuSocket`, by either door.
 *
 * @param {object} options
 * @param {any} [options.socket] A connection that is **already authorized**.
 *   Adapted as it is — see {@link adoptValuSocket}.
 * @param {string} [options.sessionId] The user's Roomful session id. The
 *   package opens the socket and authorizes it — see
 *   {@link ValuSocketConnection}, which also documents why this door is for
 *   first-party runtimes.
 * @param {...any} [options.rest] Everything else goes to whichever door is
 *   taken: `userId` / `networkId` / `onResourceUpdated` for an adopted socket,
 *   `host` / `io` / `fetchImpl` / `bootstrap` / timeouts for a new one.
 * @returns {Promise<import('./ValuSocket.js').ValuSocket>}
 */
export async function openValuSocket(options = {}) {
  const { socket, sessionId, ...rest } = options;

  if (socket && sessionId) {
    // Both would work, so neither is a safe guess: one of them is the caller's
    // real intent and the other is left over from a refactor. Say so.
    throw new TypeError(
      'openValuSocket got both `socket` and `sessionId` — pass one. `socket` uses a '
      + 'connection that is already authorized; `sessionId` opens a new one.',
    );
  }
  if (socket) return adoptValuSocket(socket, rest);
  if (sessionId) return new ValuSocketConnection({ sessionId, ...rest }).connect();

  throw new TypeError(
    'openValuSocket needs `socket` (a connection that is already authorized) or '
    + '`sessionId` (and it opens one).',
  );
}
