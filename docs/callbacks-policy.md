# Callbacks policy

**Status: frozen (Phase 1.4), and Phase 2 was written against it unchanged.**
All 77 implemented functions obey it. A change here is a version bump, not a
patch.

Implemented in `src/CallPolicy.js`; the conformance suite asserts every clause
below against both adapters.

**One clarification Phase 2 added, not a change.** A function's `channel`
(docs/parity.md) says which thing serves it, and a transport that lacks that
channel refuses the function with `501 UNSUPPORTED` — deliberately NOT one of
the retriable codes. A socket that was never supplied cannot appear between
attempts, and retrying it would buy three attempts and two backoffs for an
answer that cannot improve. The Valu Guru channel's own timeouts and
disconnections map onto `408` / `503` like any other, and retry normally.

## 1. The shape of an answer

Every function resolves the ack envelope — `{data}` or `{error}` — the same
shape the server already standardises on as `ValuAck`.

- `client.call(name, params)` **resolves** an envelope. It does not reject for
  a remote error, a timeout, a lost connection, a bad param or a missing scope.
  All five answer as `{error: {status: true, code, message}}`.
- `client.invoke(name, params)` is `call` plus `unwrapAck`: it returns
  `ack.data` and **throws** `ValuServiceError` for anything else.

Use `call` when you are handling failure, `invoke` when you are not. Nothing in
the SDK ever answers in a third shape.

### Codes

| code | meaning | retried |
|---|---|---|
| 400 | params did not match the descriptor (never reaches the wire) | no |
| 403 | the token lacks the scope the descriptor requires | no |
| 404 | no such service or function in the catalogue | no |
| 408 | no answer within the timeout | yes |
| 501 | this transport cannot serve this binding | no |
| 503 | no usable connection | yes |

A code from the remote is passed through untouched.

## 2. Timeout

30 000 ms per call, per attempt. It is the number both sides already use — the
app's `emitAsync` default and the server's `EMIT_TIMEOUT_MS` — so the SDK does
not introduce a third deadline. A descriptor may declare its own `timeoutMs`;
a caller may override per call.

## 3. Retry and backoff

- **Reads** retry twice after the first attempt (3 attempts total).
- **Writes never retry.** The SDK cannot distinguish a lost answer from a lost
  request, and re-sending `create-meeting` because an ack went missing books
  the room twice. When a function gains an idempotency key it may opt back in
  through its descriptor.
- Only 408 and 503 retry. A remote error is an answer: it is returned as-is.
- Backoff is 250 ms, doubling, capped at 4 000 ms, with ±20% jitter so a
  reconnect does not stampede every pending call into the same millisecond.

## 4. Ordering

- Calls are emitted in the order `call()` is invoked on a connected socket.
- **Answers may arrive in any order.** Nothing in the SDK serialises them, and
  no function may assume a previous call has landed.
- There is no per-service queue. Code that needs ordering awaits.
- A retry re-emits after its backoff, so a retried read can be answered after a
  call made later. Only reads retry, so this cannot reorder writes.

## 5. Reconnect

- A call in flight when the connection drops resolves 503. If it is retriable
  (a read) the policy's remaining attempts run against the re-opened socket, so
  a short blip is invisible to the caller.
- Subscriptions are **not** lost across a reconnect: `subscribe()` registers
  with the client, not the socket, and is re-established when the transport
  comes back.
- After a reconnect every cached entry for a subscribed service is dropped, and
  a `reconnected` event is emitted. Push is best-effort; a consumer that must
  not miss an update polls.
- Nothing is queued while the connection is down. A call made with no
  connection resolves 503 immediately rather than waiting out the timeout for
  an answer that was never requested.

## 6. Subscriptions

`subscribe(event, handler)` returns an unsubscribe function. Two events exist:

- `resource:updated` — the platform push, forwarded verbatim. Also drives cache
  invalidation.
- `reconnected` — the transport re-opened; caches for subscribed services have
  been dropped.

A handler that throws is caught and logged. One handler never blocks another,
and a throwing handler never fails the call that delivered the event.
