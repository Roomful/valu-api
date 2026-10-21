// ===========================================================================
// The consent page's logic (spec §4.6 "Consent flow"): a popup on the host
// origin that finds the host iframe among its opener's frames, reads the pending
// request for its nonce from it, shows the app and what it asks for in plain
// words, and posts the user's decision to that frame and no other.
//
// The DOM is behind an injected renderer (`render({app, scopes, onAllow,
// onDeny, error})`), so the logic runs here with no document; the default
// renderer is tested against a tiny fake `document` at the end.
//
// The fakes follow the browser: a cross-origin frame lets a page read nothing
// but `postMessage` (its `location.origin` and every other property throw).
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCOPE_WORDING, createDomRenderer, runConsentPage } from '../../src/host/consentPage.js';
import { TIER_OF } from '../../src/host/Permissions.js';
import { POPUP_MSG } from '../../src/host/protocol.js';

const HOST_ORIGIN = 'https://valuguru.texpo.io';
const EVIL_ORIGIN = 'https://evil.example';
const APP = { name: 'Demo', address: 'ws_1/demo' };
const SCOPES = ['rooms:read', 'commerce:write'];

const securityError = () => Object.assign(new Error('Blocked a frame from accessing a cross-origin frame.'), { name: 'SecurityError' });

/** A frame the popup may read: on `origin`, with `__valuHost.pendingConsent` answering `pending[nonce]`. */
function readableFrame({ origin = HOST_ORIGIN, pending = {}, throwOnPost = false } = {}) {
  const frame = {
    location: { origin },
    posted: [],
    asked: [],
    __valuHost: {
      pendingConsent: (nonce) => { frame.asked.push(nonce); return Object.hasOwn(pending, nonce) ? pending[nonce] : null; },
    },
    postMessage(data, targetOrigin) {
      if (throwOnPost) throw Object.assign(new Error('The frame is gone.'), { name: 'DataCloneError' });
      frame.posted.push({ data, targetOrigin });
    },
  };
  return frame;
}

/** A frame on another origin: only `postMessage` is reachable, as in a browser. */
function crossOriginFrame() {
  const frame = { posted: [], postMessage(data, targetOrigin) { frame.posted.push({ data, targetOrigin }); } };
  return new Proxy(frame, {
    get(target, key) {
      if (key === 'posted' || key === 'postMessage') return target[key];
      throw securityError();
    },
  });
}

/** The consent popup's window: its URL, its opener's frames, `close()`. */
function popup({ search = '?nonce=n1', frames = [], opener } = {}) {
  const win = {
    location: { search, origin: HOST_ORIGIN },
    opener: opener === undefined ? { frames } : opener,
    closed: false,
    close() { win.closed = true; },
  };
  return win;
}

/** A renderer that records every view it is given. */
function recorder() {
  const views = [];
  const render = (view) => { views.push(view); };
  render.views = views;
  return render;
}

const pendingFor = (nonce = 'n1', scopes = SCOPES) => ({ [nonce]: { nonce, app: { ...APP }, scopes: [...scopes] } });

function run(options = {}) {
  const frame = options.frame ?? readableFrame({ pending: pendingFor() });
  const win = options.win ?? popup({ frames: [crossOriginFrame(), frame] });
  const render = recorder();
  runConsentPage({ win, hostOrigin: HOST_ORIGIN, render, ...options.args });
  return { win, frame, render, view: () => render.views.at(-1) };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test('renders the pending scopes and posts the decision to the host frame only', () => {
  const stranger = crossOriginFrame();
  const lookalike = readableFrame({ origin: EVIL_ORIGIN, pending: pendingFor() });
  const host = readableFrame({ pending: pendingFor() });
  const win = popup({ frames: [stranger, lookalike, host] });
  const { render, view } = run({ win, frame: host });

  assert.equal(render.views.length, 1);
  assert.equal(view().error, undefined);
  assert.deepEqual(view().app, APP, 'the name and address come from the host frame');
  assert.deepEqual(view().scopes, SCOPES.map((scope) => ({ scope, text: SCOPE_WORDING[scope] })));
  assert.equal(typeof view().onAllow, 'function');
  assert.equal(typeof view().onDeny, 'function');
  assert.deepEqual(host.asked, ['n1']);
  assert.deepEqual(lookalike.asked, [], 'a frame that is not on the host origin is not read');
  assert.deepEqual([host.posted, stranger.posted, lookalike.posted, win.closed], [[], [], [], false], 'nothing is sent before the user decides');

  view().onAllow();

  assert.deepEqual(host.posted, [{
    data: { type: POPUP_MSG.CONSENT, nonce: 'n1', approved: true, scopes: SCOPES },
    targetOrigin: HOST_ORIGIN,
  }]);
  assert.equal(host.posted[0].data.type, 'valu-host:consent');
  assert.deepEqual(stranger.posted, [], 'a cross-origin frame hears nothing');
  assert.deepEqual(lookalike.posted, [], 'neither does a frame on another origin');
  assert.equal(win.closed, true);
});

test('deny posts approved:false with the same scopes, then closes', () => {
  const { frame, win, view } = run();

  view().onDeny();

  assert.deepEqual(frame.posted, [{
    data: { type: POPUP_MSG.CONSENT, nonce: 'n1', approved: false, scopes: SCOPES },
    targetOrigin: HOST_ORIGIN,
  }]);
  assert.equal(win.closed, true);
});

test('a decision is posted once, whatever is clicked afterwards', () => {
  const { frame, view } = run();
  const { onAllow, onDeny } = view();

  onAllow();
  onAllow();
  onDeny();

  assert.equal(frame.posted.length, 1);
  assert.equal(frame.posted[0].data.approved, true);
});

test('the scopes posted are the host\'s copy, so nothing the renderer does to its own list changes them', () => {
  const { frame, view } = run();
  view().scopes.length = 0;
  view().scopes.push({ scope: 'users:write', text: 'x' });

  view().onAllow();

  assert.deepEqual(frame.posted[0].data.scopes, SCOPES);
});

test('the host frame is the first on the host origin that has the request; a frame without it is skipped', () => {
  const empty = readableFrame({ pending: {} });
  const other = readableFrame({ pending: pendingFor('someone-else') });
  const host = readableFrame({ pending: pendingFor() });
  const { view } = run({ win: popup({ frames: [empty, other, host] }) });

  view().onAllow();

  assert.deepEqual([empty.posted.length, other.posted.length, host.posted.length], [0, 0, 1]);
});

// ---------------------------------------------------------------------------
// What it takes from the URL, and what it refuses to do
// ---------------------------------------------------------------------------

test('nothing from the URL but the nonce: the app, the scopes and the target come from the host', () => {
  const host = readableFrame({ pending: pendingFor() });
  const search = `?nonce=n1&app=Evil&address=x/y&scopes=users:write&hostOrigin=${encodeURIComponent(EVIL_ORIGIN)}&origin=${EVIL_ORIGIN}`;
  const { view } = run({ win: popup({ search, frames: [host] }) });

  assert.deepEqual(view().app, APP);
  assert.deepEqual(view().scopes.map((item) => item.scope), SCOPES);
  view().onAllow();
  assert.equal(host.posted[0].targetOrigin, HOST_ORIGIN);
  assert.deepEqual(host.posted[0].data.scopes, SCOPES);
});

test('no opener renders an error and posts nothing', () => {
  for (const opener of [null, undefined]) {
    const win = popup({ opener });
    win.opener = opener;
    const { view, render } = run({ win });
    assert.equal(render.views.length, 1);
    assert.equal(typeof view().error, 'string');
    assert.ok(view().error.length > 0);
    assert.equal(view().onAllow, undefined, 'nothing to allow');
    assert.equal(view().onDeny, undefined);
    assert.equal(view().app, null);
    assert.deepEqual(view().scopes, []);
    assert.equal(win.closed, false);
  }
});

test('no matching frame renders an error and posts nothing', () => {
  const stranger = crossOriginFrame();
  const lookalike = readableFrame({ origin: EVIL_ORIGIN, pending: pendingFor() });
  const { view, win } = run({ win: popup({ frames: [stranger, lookalike] }), frame: lookalike });

  assert.equal(typeof view().error, 'string');
  assert.deepEqual([stranger.posted, lookalike.posted, lookalike.asked], [[], [], []]);
  assert.equal(win.closed, false);

  const none = run({ win: popup({ frames: [] }) });
  assert.equal(typeof none.view().error, 'string');
});

test('no pending request for the nonce renders an error and posts nothing', () => {
  const host = readableFrame({ pending: pendingFor('another') });
  const { view, win } = run({ win: popup({ frames: [host] }), frame: host });

  assert.equal(typeof view().error, 'string');
  assert.deepEqual(host.posted, []);
  assert.equal(win.closed, false);
});

test('a missing, empty or repeated nonce: an error, or only the first one is asked about', () => {
  for (const search of ['', '?', '?nonce=', '?other=1', '?Nonce=n1']) {
    const host = readableFrame({ pending: pendingFor() });
    const { view } = run({ win: popup({ search, frames: [host] }), frame: host });
    assert.equal(typeof view().error, 'string', `search ${JSON.stringify(search)}`);
    assert.deepEqual(host.asked, [], 'the host is not asked about nothing');
    assert.deepEqual(host.posted, []);
  }
  const host = readableFrame({ pending: { ...pendingFor('a'), ...pendingFor('b') } });
  run({ win: popup({ search: '?nonce=a&nonce=b', frames: [host] }), frame: host });
  assert.deepEqual(host.asked, ['a']);
});

test('a host origin that is not an origin posts nowhere: an error, nothing read, nothing sent', () => {
  for (const hostOrigin of [undefined, null, '', '*', 'https://valuguru.texpo.io/host/', 'null', 7]) {
    // a frame that reports exactly that origin (a sandboxed frame reports 'null') must not be taken for the host
    const host = readableFrame({ origin: typeof hostOrigin === 'string' ? hostOrigin : HOST_ORIGIN, pending: pendingFor() });
    const win = popup({ frames: [host] });
    const render = recorder();
    runConsentPage({ win, hostOrigin, render });
    assert.equal(typeof render.views[0].error, 'string', `hostOrigin ${String(hostOrigin)}`);
    assert.deepEqual(host.posted, []);
    assert.deepEqual(host.asked, []);
  }
});

test('a request that is not the shape, or asks for something with no wording, is an error', () => {
  const bad = [
    { nonce: 'n1', app: { name: 'Demo' }, scopes: SCOPES },
    { nonce: 'n1', app: { name: 7, address: 'a' }, scopes: SCOPES },
    { nonce: 'n1', app: null, scopes: SCOPES },
    { nonce: 'n1', app: APP, scopes: 'rooms:read' },
    { nonce: 'n1', app: APP, scopes: [] },
    { nonce: 'n1', app: APP, scopes: ['rooms:read', 5] },
    { nonce: 'n1', app: APP, scopes: ['rooms:read', 'made:up'] },
    { nonce: 'n1', app: APP, scopes: ['users:read'] },
    { nonce: 'n1', app: APP, scopes: ['__proto__'] },
    { nonce: 'n1', app: APP, scopes: ['toString'] },
    'a string',
    7,
  ];
  for (const pending of bad) {
    const host = readableFrame({ pending: { n1: pending } });
    const { view } = run({ win: popup({ frames: [host] }), frame: host });
    assert.equal(typeof view().error, 'string', JSON.stringify(pending));
    assert.equal(view().onAllow, undefined);
    assert.deepEqual(host.posted, []);
  }
});

test('a host frame that throws is skipped, and the page goes on to the next', () => {
  const broken = readableFrame({ pending: pendingFor() });
  broken.__valuHost.pendingConsent = () => { throw new Error('boom'); };
  const noApi = readableFrame({ pending: pendingFor() });
  delete noApi.__valuHost;
  const host = readableFrame({ pending: pendingFor() });
  const { view } = run({ win: popup({ frames: [broken, noApi, host] }), frame: host });

  assert.equal(view().error, undefined);
  view().onAllow();
  assert.deepEqual([broken.posted.length, noApi.posted.length, host.posted.length], [0, 0, 1]);
});

test('an opener whose frames cannot be read is an error, not a throw', () => {
  const opener = new Proxy({}, { get() { throw securityError(); } });
  const { view } = run({ win: popup({ opener }) });
  assert.equal(typeof view().error, 'string');
});

test('a post that fails shows an error and leaves the window open', () => {
  const host = readableFrame({ pending: pendingFor(), throwOnPost: true });
  const win = popup({ frames: [host] });
  const { render, view } = run({ win, frame: host });

  view().onAllow();

  assert.equal(render.views.length, 2);
  assert.equal(typeof view().error, 'string');
  assert.equal(win.closed, false);
});

// ---------------------------------------------------------------------------
// The wording
// ---------------------------------------------------------------------------

const CONSENT_SCOPES = [
  'users:write', 'rooms:read', 'rooms:write', 'textchat:read', 'textchat:write', 'groups:read', 'groups:write',
  'events:read', 'events:write', 'community:read', 'cbac:read', 'cms:read', 'cms:write', 'veruswallet:read',
  'commerce:read', 'commerce:write', 'commerce:sell',
];

test('every consent-tier scope has wording', () => {
  const tiered = Object.keys(TIER_OF).filter((scope) => TIER_OF[scope] === 'consent').sort();
  assert.deepEqual(tiered.filter((scope) => scope !== 'http:read' && scope !== 'http:write'), [...CONSENT_SCOPES].sort(), 'the table of tiers is the list the wording is written for');

  for (const scope of tiered) {
    const text = SCOPE_WORDING[scope];
    assert.equal(typeof text, 'string', `${scope} has a sentence`);
    assert.match(text, /^[A-Z].*\.$/, `${scope}: one sentence, capitalised, ending with a full stop`);
    assert.doesNotMatch(text, /[.!?]\s/, `${scope}: one sentence only`);
    assert.doesNotMatch(text, /\b\w+:(read|write|sell)\b/, `${scope}: no scope ids in a sentence for a person`);
  }
  assert.deepEqual(Object.keys(SCOPE_WORDING).sort(), [...CONSENT_SCOPES].sort(), 'wording only for what is asked about');
  assert.ok(Object.isFrozen(SCOPE_WORDING));
});

test('the sentences are distinct, so two scopes never read the same', () => {
  const sentences = Object.values(SCOPE_WORDING);
  assert.equal(new Set(sentences).size, sentences.length);
});

// ---------------------------------------------------------------------------
// The default renderer, on a tiny fake document
// ---------------------------------------------------------------------------

/** Just enough DOM: elements that hold text and children, listeners, attributes; `innerHTML` is not allowed. */
function fakeDocument() {
  const make = (tagName) => {
    const element = {
      tagName,
      children: [],
      attributes: {},
      listeners: {},
      disabled: false,
      className: '',
      textContent: '',
      append(...nodes) { element.children.push(...nodes); },
      setAttribute(name, value) { element.attributes[name] = String(value); },
      addEventListener(type, listener) { (element.listeners[type] ??= []).push(listener); },
      /** A disabled button does not fire, as in a browser. */
      click() {
        if (element.disabled) return;
        for (const listener of element.listeners.click ?? []) listener({ type: 'click' });
      },
    };
    Object.defineProperty(element, 'innerHTML', { set() { throw new Error('innerHTML is never used'); }, get() { return ''; } });
    return element;
  };
  const body = make('body');
  body.replaceChildren = (...nodes) => { body.children = [...nodes]; };
  const doc = { title: '', body, createElement: make };
  return doc;
}

const walk = (node, out = []) => {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
};
const where = (doc, tagName) => walk(doc.body).filter((node) => node.tagName === tagName);

test('the default renderer shows the app, one list item per scope, and two buttons wired to the decision', () => {
  const doc = fakeDocument();
  const render = createDomRenderer(doc);
  const chosen = [];

  render({
    app: { name: '<img src=x onerror=alert(1)>', address: 'ws_1/demo' },
    scopes: SCOPES.map((scope) => ({ scope, text: SCOPE_WORDING[scope] })),
    onAllow: () => chosen.push('allow'),
    onDeny: () => chosen.push('deny'),
  });

  const text = walk(doc.body).map((node) => node.textContent).join('|');
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'the name is text, never markup');
  assert.ok(text.includes('ws_1/demo'));
  assert.deepEqual(where(doc, 'li').map((li) => li.textContent), SCOPES.map((scope) => SCOPE_WORDING[scope]));
  const buttons = where(doc, 'button');
  assert.deepEqual(buttons.map((button) => button.textContent), ["Don't allow", 'Allow']);
  assert.ok(buttons.every((button) => button.attributes.type === 'button'));

  buttons[1].click();
  assert.deepEqual(chosen, ['allow']);
  assert.ok(buttons.every((button) => button.disabled), 'both are disabled once the user has chosen');
  buttons[0].click();
  assert.deepEqual(chosen, ['allow'], 'a button that is disabled does not decide again');
});

test('the default renderer shows an error and no buttons, and replaces what was there', () => {
  const doc = fakeDocument();
  const render = createDomRenderer(doc);
  render({ app: APP, scopes: [{ scope: 'rooms:read', text: SCOPE_WORDING['rooms:read'] }], onAllow() {}, onDeny() {} });
  assert.equal(where(doc, 'button').length, 2);

  render({ app: null, scopes: [], error: 'Gone.' });

  assert.equal(where(doc, 'button').length, 0);
  assert.equal(where(doc, 'li').length, 0);
  assert.ok(walk(doc.body).some((node) => node.textContent === 'Gone.'));
});

test('runConsentPage without a renderer draws with the document it is given', () => {
  const doc = fakeDocument();
  const host = readableFrame({ pending: pendingFor() });
  const win = popup({ frames: [host] });
  runConsentPage({ win, document: doc, hostOrigin: HOST_ORIGIN });

  assert.equal(where(doc, 'button').length, 2);
  where(doc, 'button')[1].click();
  assert.equal(host.posted.length, 1);
  assert.equal(win.closed, true);

  assert.throws(() => runConsentPage({ win: popup(), hostOrigin: HOST_ORIGIN }), TypeError, 'no renderer and no document');
});

test('importing the page logic touches no DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof runConsentPage, 'function');
});
