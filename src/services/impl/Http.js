// ===========================================================================
// Http — 3 functions, `local`.
//
// Ported from valusocial-web/src/Services/Http/HttpService.js, including the
// two rules that are the point of the service rather than details of it:
//
//   credentials: 'omit'  — the caller's cookies never reach a URL the AI
//                          chose. There is no option to turn this off.
//   a capped timeout     — an unbounded fetch is a hung call, and the call
//                          policy above it cannot see inside one.
//
// A non-2xx response is a RESULT, not an error: `{ok: false, status}` in the
// ack's data. Only a transport failure (DNS, abort, refused) is an error ack —
// the distinction a caller needs to decide whether retrying could help.
// ===========================================================================
import { ok, fail, str } from './support.js';
import { ERROR_CODES } from '../../Errors.js';

const DEFAULT_PING_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

const parseTimeout = (timeout, fallback) => {
  const n = Number(timeout);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_TIMEOUT_MS);
};

const collectHeaders = (headers) => {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, name) => { out[name] = value; });
  return out;
};

async function parseBody(response, responseType) {
  if (responseType === 'text') return { body: await response.text(), bodyType: 'text' };
  if (responseType === 'json') {
    try { return { body: await response.json(), bodyType: 'json' }; }
    catch { return { body: null, bodyType: 'json' }; }
  }
  // 'auto': JSON when the content type says so, text otherwise.
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try { return { body: await response.json(), bodyType: 'json' }; }
    catch { return { body: '', bodyType: 'text' }; }
  }
  return { body: await response.text(), bodyType: 'text' };
}

const now = () => (globalThis.performance?.now?.() ?? Date.now());

async function request(ctx, { url, method, headers, body, timeout, responseType }) {
  const doFetch = ctx.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return fail(ERROR_CODES.UNSUPPORTED, `${ctx.descriptor.key}: this runtime has no fetch`);
  }
  const budget = parseTimeout(timeout, DEFAULT_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const started = now();

  try {
    const response = await doFetch(url, {
      method,
      headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      body,
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'follow',
    });
    const latency = Math.round(now() - started);
    const parsed = await parseBody(response, responseType);
    return ok({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: collectHeaders(response.headers),
      body: parsed.body,
      bodyType: parsed.bodyType,
      latency,
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return fail(
      timedOut ? ERROR_CODES.TIMEOUT : ERROR_CODES.DISCONNECTED,
      timedOut ? `${method} ${url} timed out after ${budget}ms` : `${method} ${url} failed: ${error?.message ?? error}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function register(registry) {
  registry
    .define('Http.ping', async (params, ctx) => {
      const doFetch = ctx.fetchImpl ?? globalThis.fetch;
      if (typeof doFetch !== 'function') {
        return fail(ERROR_CODES.UNSUPPORTED, 'Http.ping: this runtime has no fetch');
      }
      const budget = parseTimeout(params.timeout, DEFAULT_PING_TIMEOUT_MS);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      const started = now();
      try {
        const response = await doFetch(params.url, {
          method: 'HEAD', cache: 'no-store', signal: controller.signal, credentials: 'omit',
        });
        // Any answer at all means the server is up — even a 503 from it.
        return ok({
          up: response.status >= 200 && response.status < 600,
          latency: Math.round(now() - started),
          status: response.status,
        });
      } catch (error) {
        return ok({
          up: false,
          latency: Math.round(now() - started),
          status: 0,
          error: error?.name === 'AbortError' ? `Timed out after ${budget}ms` : (error?.message || 'Network error'),
        });
      } finally {
        clearTimeout(timer);
      }
    })

    .define('Http.get', (params, ctx) => request(ctx, {
      url: params.url,
      method: 'GET',
      headers: params.headers,
      timeout: params.timeout,
      responseType: str(params.responseType, 'auto'),
    }))

    .define('Http.post', (params, ctx) => {
      const headers = { ...(params.headers || {}) };
      let payload = params.body;
      // A plain object is JSON; anything the platform can send verbatim
      // (FormData, Blob, ArrayBuffer, URLSearchParams, a string) is left alone
      // so its own content type survives.
      const verbatim = typeof payload === 'string'
        || (typeof FormData !== 'undefined' && payload instanceof FormData)
        || (typeof Blob !== 'undefined' && payload instanceof Blob)
        || payload instanceof ArrayBuffer
        || (typeof URLSearchParams !== 'undefined' && payload instanceof URLSearchParams);
      if (payload != null && typeof payload === 'object' && !verbatim) {
        headers['Content-Type'] = str(params.contentType) || headers['Content-Type'] || 'application/json';
        payload = JSON.stringify(payload);
      } else if (params.contentType) {
        headers['Content-Type'] = str(params.contentType);
      }
      return request(ctx, {
        url: params.url,
        method: 'POST',
        headers,
        body: payload,
        timeout: params.timeout,
        responseType: str(params.responseType, 'auto'),
      });
    });

  return registry;
}
