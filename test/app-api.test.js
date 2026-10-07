import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppApiClient, AppApiError, normalizeAddress, NETWORK_HEADER, SCOPE_HEADER } from '../src/AppApi.js';

/** A fetch that records what it was asked and answers what it was told to. */
const fakeFetch = (answers = []) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, headers: Object.fromEntries(new Headers(init.headers ?? {})) });
    const next = answers.shift() ?? { status: 200, body: '{}' };
    return new Response(next.body ?? '', {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
};

test('an address is one or two segments, as the gateway reads it', () => {
  assert.equal(normalizeAddress('calendar'), 'calendar');
  assert.equal(normalizeAddress('/ws_7a07b7b5/cnavas/'), 'ws_7a07b7b5/cnavas');
  assert.throws(() => normalizeAddress(''), /not an application address/);
  assert.throws(() => normalizeAddress('a/b/c'), /not an application address/);
});

test('the client refuses to exist without the two things it cannot guess', () => {
  assert.throws(() => createAppApiClient({ network: 'net-1', fetch: async () => new Response() }), /gatewayBase/);
  assert.throws(() => createAppApiClient({ gatewayBase: 'https://g', fetch: async () => new Response() }), /network/);
});

test('a call names the network, asks for every scope by default, and goes to the gateway address', async () => {
  const { fetch, calls } = fakeFetch([{ body: '{"items":[]}' }]);
  const api = createAppApiClient({ gatewayBase: 'https://valuguru.test/', network: 'net-1', fetch });

  const answer = await api.get('ws_7a07b7b5/cnavas', '/canvases?limit=10');
  assert.deepEqual(answer, { items: [] });
  assert.equal(calls[0].url, 'https://valuguru.test/api/apps/v1/ws_7a07b7b5/cnavas/canvases?limit=10');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].headers[NETWORK_HEADER], 'net-1');
  assert.equal(calls[0].headers[SCOPE_HEADER], undefined, 'no scope header = every declared scope');
  assert.equal(calls[0].headers.authorization, undefined, 'no user, no bearer');
});

test('a page may ask for less, per call or for the whole client', async () => {
  const { fetch, calls } = fakeFetch([{}, {}]);
  const api = createAppApiClient({ gatewayBase: 'https://g', network: () => 'net-2', fetch, scope: ['events.read'] });
  await api.call('calendar', 'events');
  await api.call('calendar', '/events', { scope: 'events.read events.write' });
  assert.equal(calls[0].url, 'https://g/api/apps/v1/calendar/events', 'a path without a slash gets one');
  assert.equal(calls[0].headers[SCOPE_HEADER], 'events.read');
  assert.equal(calls[1].headers[SCOPE_HEADER], 'events.read events.write');
  assert.equal(calls[1].headers[NETWORK_HEADER], 'net-2', 'a network function is asked');
});

test('the signed-in user rides as the identity token, cached, and re-acquired once on a 401', async () => {
  let minted = 0;
  const identityToken = async () => ({ token: `identity-${++minted}` });
  const { fetch, calls } = fakeFetch([{}, {}, { status: 401, body: '{"error":{"code":"auth_required","message":"stale"}}' }, {}]);
  let clock = 1_000_000;
  const api = createAppApiClient({ gatewayBase: 'https://g', network: 'n', fetch, identityToken, now: () => clock });

  await api.call('calendar', '/events');
  await api.call('calendar', '/events');
  assert.equal(minted, 1, 'two calls, one token');
  assert.equal(calls[1].headers.authorization, 'Bearer identity-1');

  // The gateway says the cached token is stale: one fresh acquisition, one retry.
  const response = await api.call('calendar', '/events');
  assert.equal(response.status, 200);
  assert.equal(minted, 2);
  assert.equal(calls[3].headers.authorization, 'Bearer identity-2');
});

test('a JSON body is serialised and typed; a refusal is raised in the gateway\'s own words', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 201, body: '{"id":"evt-1"}' },
    { status: 403, body: '{"error":{"code":"forbidden","message":"\\"calendar\\" requires a user context."}}' },
    { status: 502, body: 'not json' },
  ]);
  const api = createAppApiClient({ gatewayBase: 'https://g', network: 'n', fetch });

  const created = await api.post('calendar', '/events', { title: 'Design review' });
  assert.deepEqual(created, { id: 'evt-1' });
  assert.equal(calls[0].init.body, '{"title":"Design review"}');
  assert.equal(calls[0].headers['content-type'], 'application/json');

  await assert.rejects(api.get('calendar', '/events'), (err) => {
    assert.ok(err instanceof AppApiError);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
    assert.match(err.message, /requires a user context/);
    return true;
  });

  await assert.rejects(api.get('calendar', '/events'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'http_error');
    return true;
  });
});

test('the OpenAPI document is read bare — no network, no user, no scope', async () => {
  const { fetch, calls } = fakeFetch([{ body: '{"openapi":"3.1.0"}' }]);
  const api = createAppApiClient({ gatewayBase: 'https://g', network: 'n', fetch, identityToken: async () => 'id' });
  assert.deepEqual(await api.openapi('ws_7a07b7b5/cnavas'), { openapi: '3.1.0' });
  assert.equal(calls[0].url, 'https://g/api/apps/v1/ws_7a07b7b5/cnavas/openapi.json');
  assert.deepEqual(calls[0].headers, {}, 'nothing but the URL');
});
