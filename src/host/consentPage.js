// ===========================================================================
// The logic of the consent popup (spec §4.6 "Consent flow"): the page a client
// opens at `<host-origin>/host/consent.html?nonce=…` when an app needs a scope
// the user has not allowed yet. It is part of the host bundle, so it is
// same-origin with the host iframe, and everything it shows comes from there.
//
//   1. The only thing the URL gives it is the nonce. The app's name and
//      address and the scopes come from the host iframe, which it finds among
//      its opener's frames (the page that embeds the host): the one whose
//      origin is the host origin and that holds a pending request for the
//      nonce (`__valuHost.pendingConsent(nonce)`). A frame on another origin
//      throws when asked, and is skipped. Nothing the app page controls can put
//      another app's name, or other scopes, on the dialog.
//   2. It shows the app and one plain sentence per scope (`SCOPE_WORDING`),
//      with Allow and Don't allow.
//   3. The decision, `{type:'valu-host:consent', nonce, approved, scopes}`, goes
//      to that frame and no other, with the host origin as `targetOrigin`, and
//      the window closes. The host checks origin and nonce on its side.
//
// With no opener, no frame on the host origin, or no pending request for the
// nonce, the page shows an error and sends nothing. A request that asks for
// anything this page has no sentence for is the same: the user is never asked
// to agree to something that is not written down.
//
// The DOM is behind a renderer, `render({app, scopes, onAllow, onDeny, error})`,
// so the logic needs no document; `createDomRenderer` is the default one and
// builds plain elements with `textContent` only. No DOM access at import.
// ===========================================================================
import { isOrigin } from './origins.js';
import { POPUP_MSG } from './protocol.js';

/**
 * What the dialog says for each scope that needs the user's consent: one plain
 * sentence, completing "This app is asking to be allowed to:". There is one for
 * every consent-tier scope in `Permissions.TIER_OF` (a test holds them to it).
 *
 * The Commerce sentences use the words Valu Social's own Commerce dialogs use
 * for the same things (`intents/consent.js` and `sellerConsent.js` there say
 * what a write WILL do, but have no per-scope sentence to copy): the cart,
 * orders and purchases on the buying side; the store, products, sales,
 * volume discounts and discount codes on the selling side.
 */
export const SCOPE_WORDING = Object.freeze({
  'users:write': 'Send, accept, decline and cancel connection requests for you.',
  'rooms:read': 'See your rooms and what is in them, and search for other rooms.',
  'rooms:write': 'Create rooms from templates, invite people to your props, and add to or rename things in your rooms.',
  'textchat:read': 'Read the message history of your chat channels.',
  'textchat:write': 'Send chat messages in your name.',
  'groups:read': 'See your groups and who is in them, and find groups you could join.',
  'groups:write': 'Join groups for you.',
  'events:read': 'See your events and meetings.',
  'events:write': 'Create and edit meetings for you.',
  'community:read': 'Read communities, their channels and their posts.',
  'cbac:read': 'See badges and the access rules built on them, and find people who hold a badge.',
  'cms:read': 'Search the files in your content library.',
  'cms:write': 'Add files to your content library and delete files from it.',
  'veruswallet:read': 'See your Verus wallet balance.',
  'commerce:read': 'See products, your cart, your orders and your purchases, and be told when they change.',
  'commerce:write': 'Add things to your cart and change or empty it; it cannot pay for you.',
  'commerce:sell': 'Sell in your name: set up your store, create and change your products, end sales and discount codes, and see how they sell.',
});

/** What the page says when there is nothing it can ask the user about. One message: it does not say why. */
const UNAVAILABLE = 'This request is no longer available. Close this window and try again from the app.';

const hasWording = (scope) => typeof scope === 'string' && Object.hasOwn(SCOPE_WORDING, scope);
const isText = (value) => typeof value === 'string' && value !== '';

/** The `nonce` of the page's URL, the only thing it reads from it; `null` when there is none. */
function nonceOf(win) {
  try {
    return new URLSearchParams(win.location.search).get('nonce') || null;
  } catch {
    return null;
  }
}

/**
 * The pending request a frame holds for `nonce`, if it is whole and every scope
 * of it can be put in words: `{app: {name, address}, scopes}`; else `null`.
 * Never throws: a frame that cannot be asked has no request.
 */
function requestOf(frame, nonce) {
  try {
    const pending = frame.__valuHost.pendingConsent(nonce);
    const { app, scopes } = pending;
    if (!isText(app?.name) || !isText(app?.address)) return null;
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(hasWording)) return null;
    return { app: { name: app.name, address: app.address }, scopes: [...scopes] };
  } catch {
    return null;
  }
}

/**
 * The host iframe among the opener's frames: the first on `hostOrigin` that
 * holds a request for `nonce`. A frame on another origin throws when its
 * `location.origin` is read, and is skipped, as is one on a look-alike origin
 * that happens to be readable.
 * @returns {{frame: Window, request: {app: object, scopes: string[]}}|null}
 */
function findHostFrame(win, hostOrigin, nonce) {
  let frames;
  let count;
  try {
    frames = win.opener?.frames;
    count = frames?.length;
  } catch {
    return null;
  }
  if (!Number.isInteger(count)) return null;
  for (let index = 0; index < count; index += 1) {
    try {
      const frame = frames[index];
      if (frame.location.origin !== hostOrigin) continue;
      const request = requestOf(frame, nonce);
      if (request) return { frame, request };
    } catch {
      // a cross-origin frame: nothing in it is ours
    }
  }
  return null;
}

/**
 * Run the consent page.
 * @param {object} options
 * @param {Window} [options.win] The popup's window (default: the global).
 * @param {Document} [options.document] For the default renderer (default: `win.document`).
 * @param {string} options.hostOrigin The host origin: the only place a decision is sent.
 * @param {(view: {app: {name: string, address: string}|null, scopes: {scope: string, text: string}[],
 *   onAllow?: () => void, onDeny?: () => void, error?: string}) => void} [options.render]
 *   Draws a view; by default {@link createDomRenderer} over `document`.
 */
export function runConsentPage({
  win = globalThis,
  document = win.document,
  hostOrigin,
  render,
} = {}) {
  const draw = render ?? createDomRenderer(document);
  const fail = () => draw({ app: null, scopes: [], error: UNAVAILABLE });

  // A target that is not an origin (`'*'` among them) is never posted to, and nothing is read.
  const nonce = isOrigin(hostOrigin) ? nonceOf(win) : null;
  const found = nonce === null ? null : findHostFrame(win, hostOrigin, nonce);
  if (!found) {
    fail();
    return;
  }

  const { frame, request } = found;
  let decided = false;
  const decide = (approved) => {
    if (decided) return;
    decided = true;
    try {
      frame.postMessage({ type: POPUP_MSG.CONSENT, nonce, approved, scopes: [...request.scopes] }, hostOrigin);
    } catch {
      fail(); // the frame is gone: nothing was sent, and the window stays so the user can read why
      return;
    }
    win.close();
  };

  draw({
    app: request.app,
    scopes: request.scopes.map((scope) => ({ scope, text: SCOPE_WORDING[scope] })),
    onAllow: () => decide(true),
    onDeny: () => decide(false),
  });
}

/**
 * The default renderer: plain elements under `document.body`, text only (the
 * app's name is a string from a publisher and is never read as markup). The
 * page that serves it (`consent.html`) brings the styles; the elements carry
 * `valu-consent` class names to hang them on.
 * @param {Document} document
 */
export function createDomRenderer(document) {
  if (!document || typeof document.createElement !== 'function') throw new TypeError('the consent page needs a document or a renderer.');

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  return ({ app, scopes, onAllow, onDeny, error }) => {
    const main = element('main', 'valu-consent');
    if (error) {
      document.title = 'Permission request';
      main.append(element('h1', 'valu-consent__title', 'Nothing to approve'), element('p', 'valu-consent__error', error));
    } else {
      document.title = `Permission request from ${app.name}`;
      const list = element('ul', 'valu-consent__scopes');
      list.append(...scopes.map(({ text }) => element('li', 'valu-consent__scope', text)));

      const deny = element('button', 'valu-consent__deny', 'Don\'t allow');
      const allow = element('button', 'valu-consent__allow', 'Allow');
      const choose = (handler) => () => {
        deny.disabled = true;
        allow.disabled = true;
        handler();
      };
      for (const button of [deny, allow]) button.setAttribute('type', 'button');
      deny.addEventListener('click', choose(onDeny));
      allow.addEventListener('click', choose(onAllow));
      const actions = element('div', 'valu-consent__actions');
      actions.append(deny, allow);

      main.append(
        element('h1', 'valu-consent__title', app.name),
        element('p', 'valu-consent__address', app.address),
        element('p', 'valu-consent__lead', 'This app is asking to be allowed to:'),
        list,
        actions,
      );
    }
    document.body.replaceChildren(main);
  };
}
