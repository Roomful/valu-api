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
//
// Input protection. The app decides when the popup opens, so it can open it
// under the user's pointer: on the first click of a double-click, the second
// lands wherever the popup put its buttons. The default renderer therefore keeps
// Allow and Don't allow disabled until the window has been visible AND focused
// for {@link CONSENT_INPUT_DELAY_MS}, and disables them again, for the same
// delay, whenever the window is hidden or loses focus and comes back. A click
// that arrives while they are disabled decides nothing.
// ===========================================================================
import { isOrigin } from './origins.js';
import { POPUP_MSG } from './protocol.js';

/**
 * What the dialog says for each scope that needs the user's consent: one plain
 * sentence, completing "This app is asking to be allowed to:". There is one for
 * every consent-tier scope in `Permissions.TIER_OF` (a test holds them to it).
 * Each says the strongest thing its scope allows, as the catalogue's functions
 * for it do (the agent's own messages, access levels the app chooses, invitations
 * to other people), and promises nothing beyond that.
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
  'rooms:write': 'Create rooms from templates, invite people to your props with whatever access level the app chooses, remove them again, and add or change content in your props.',
  'textchat:read': 'Read the message history of your chat channels.',
  'textchat:write': 'Send chat messages to any user as you, and have this app\'s agent message you directly.',
  'groups:read': 'See your groups and who is in them, and find groups you could join.',
  'groups:write': 'Join groups for you.',
  'events:read': 'See your events and meetings.',
  'events:write': 'Create and change meetings in your calendar, and invite other people to them.',
  'community:read': 'Read communities, their channels and their posts.',
  'cbac:read': 'See badges and the access rules built on them, and find people who hold a badge.',
  'cms:read': 'Search the files in your content library.',
  'cms:write': 'Add files to your content library and delete files from it.',
  'veruswallet:read': 'Read the balance of a wallet attached to an agent.',
  'commerce:read': 'See products, your cart, your orders and your purchases, and be told when they change.',
  'commerce:write': 'Add things to your cart, and change, remove or clear the items in your cart.',
  'commerce:sell': 'Sell in your name: set up your store, create and change your products and their prices, read your sales and analytics, end sales, delete unused discount codes and remove volume discounts, and ask to sell in a network.',
});

/**
 * How long the decision buttons stay disabled after the window becomes visible
 * and focused (and after every return to that), so a click aimed at the app page
 * cannot land on them as the popup opens.
 */
export const CONSENT_INPUT_DELAY_MS = 600;

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
 *   Draws a view; by default {@link createDomRenderer} over `document`, guarding its buttons with `win`.
 */
export function runConsentPage({
  win = globalThis,
  document = win.document,
  hostOrigin,
  render,
} = {}) {
  const draw = render ?? createDomRenderer(document, { win });
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
 * Keep `setEnabled(true)` for when the window has been visible and focused for
 * `delayMs` without a break: called with `false` at once, and again whenever the
 * window is hidden or loses focus; `true` once the delay has run since it last
 * became visible and focused. A `focus` or `visibilitychange` restarts the
 * delay. A document without `visibilityState` / `hasFocus` counts as visible /
 * focused. Returns `{ready, stop}`: whether input counts now, and the way to
 * stop listening (and clear the timer).
 */
function guardInput({ document, win, delayMs, setTimer, clearTimer, setEnabled }) {
  let timer = null;
  let ready = false;
  const usable = () => {
    try {
      const visible = document.visibilityState === undefined || document.visibilityState === 'visible';
      const focused = typeof document.hasFocus !== 'function' || document.hasFocus() === true;
      return visible && focused;
    } catch {
      return false;
    }
  };
  const disarm = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    ready = false;
    setEnabled(false);
  };
  const arm = () => {
    disarm();
    if (!usable()) return;
    timer = setTimer(() => {
      timer = null;
      if (!usable()) return;
      ready = true;
      setEnabled(true);
    }, delayMs);
  };
  const subscriptions = [
    [win, 'focus', arm],
    [win, 'blur', disarm],
    [document, 'visibilitychange', arm],
  ].filter(([target]) => typeof target?.addEventListener === 'function');
  for (const [target, type, listener] of subscriptions) target.addEventListener(type, listener);
  arm();
  return {
    ready: () => ready,
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const [target, type, listener] of subscriptions) target.removeEventListener?.(type, listener);
    },
  };
}

/**
 * The default renderer: plain elements under `document.body`, text only (the
 * app's name is a string from a publisher and is never read as markup). The
 * page that serves it (`consent.html`) brings the styles; the elements carry
 * `valu-consent` class names to hang them on.
 *
 * The two buttons are disabled until the window has been visible and focused
 * for `inputDelayMs` (see the header), and a click while they are disabled is
 * ignored even by a browser that would deliver it.
 * @param {Document} document
 * @param {object} [options]
 * @param {Window} [options.win] Where `focus` / `blur` arrive (default: `document.defaultView`).
 * @param {number} [options.inputDelayMs] Default {@link CONSENT_INPUT_DELAY_MS}.
 * @param {Function} [options.setTimeout] Timers, for a test that turns the clock itself.
 * @param {Function} [options.clearTimeout]
 */
export function createDomRenderer(document, {
  win = document?.defaultView,
  inputDelayMs = CONSENT_INPUT_DELAY_MS,
  setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearTimer = (id) => globalThis.clearTimeout(id),
} = {}) {
  if (!document || typeof document.createElement !== 'function') throw new TypeError('the consent page needs a document or a renderer.');

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  /** The input guard of the view on screen, stopped when it is replaced. */
  let guard = null;

  return ({ app, scopes, onAllow, onDeny, error }) => {
    guard?.stop();
    guard = null;
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
      let chosen = false;
      const setEnabled = (enabled) => {
        deny.disabled = chosen || !enabled;
        allow.disabled = chosen || !enabled;
      };
      const own = guardInput({
        document, win, delayMs: inputDelayMs, setTimer, clearTimer, setEnabled,
      });
      guard = own;
      const choose = (handler) => () => {
        if (chosen || !own.ready()) return;
        chosen = true;
        own.stop();
        setEnabled(false);
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
