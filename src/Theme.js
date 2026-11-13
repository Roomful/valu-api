import {Transport} from './transport/Transport.js';
import {nextId} from './Utils.js';

const valid = scheme => scheme === 'light' || scheme === 'dark';
const failure = (code, message = code) => Object.assign(new Error(message), {code});

/** Client-side theme; the parent is authoritative when embedded. */
export function createTheme({mode, transport, win, ready, setTimer, clearTimer}) {
  const media = win.matchMedia?.('(prefers-color-scheme: dark)');
  let scheme = media?.matches ? 'dark' : 'light';
  let hostTheme = false;
  let canToggle = false;
  let chosen = false;
  let closed = false;
  let pending = null;
  let revision = 0;
  const listeners = new Set();
  const apply = value => {
    if (closed || !valid(value)) return;
    revision++;
    if (scheme === value) return;
    scheme = value;
    for (const handler of listeners) handler(scheme);
  };
  const systemChanged = () => { if (!hostTheme && !chosen) apply(media.matches ? 'dark' : 'light'); };
  media?.addEventListener?.('change', systemChanged);
  const off = mode === 'embedded' ? [
    transport.subscribe(Transport.READY, message => {
      hostTheme = valid(message?.theme?.scheme);
      canToggle = hostTheme && message.theme.toggle === true;
      if (hostTheme) apply(message.theme.scheme);
    }),
    transport.subscribe(Transport.TRIGGER, message => {
      if (message?.action === 'color-scheme' && hostTheme) apply(message.data?.scheme);
    }),
  ] : [];

  const toggle = async () => {
    if (closed) throw failure('closed');
    if (mode === 'dedicated') {
      chosen = true;
      apply(scheme === 'dark' ? 'light' : 'dark');
      return scheme;
    }
    await ready;
    if (closed) throw failure('closed');
    if (!canToggle) throw failure('not_available', 'This Valu host does not support theme switching');
    // Double clicks join the outstanding change rather than immediately undoing it.
    if (pending) return pending;
    const requestId = nextId();
    const before = revision;
    const timer = setTimer(() => transport.cancelRequest(requestId, failure('timeout')), 10000);
    pending = transport.request('api:theme', {action: 'toggle'}, requestId).then(reply => {
      if (reply?.error) throw failure(reply.error.code || 'unavailable', reply.error.message);
      if (!valid(reply?.scheme)) throw failure('invalid_response');
      // A push received while waiting is newer than the request's answer.
      if (revision === before) apply(reply.scheme);
      return scheme;
    }).finally(() => { clearTimer(timer); pending = null; });
    return pending;
  };
  return {
    api: Object.freeze({
      get scheme() { return scheme; },
      on(name, handler) {
        if (name !== 'change' || typeof handler !== 'function') throw new TypeError('theme.on expects change and a handler');
        if (!closed) listeners.add(handler);
        return () => listeners.delete(handler);
      },
      toggle,
    }),
    close() {
      closed = true;
      media?.removeEventListener?.('change', systemChanged);
      for (const unsubscribe of off) unsubscribe();
      listeners.clear();
    },
  };
}
