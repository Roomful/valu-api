// The dedicated-mode sample (spec §4.8): one page, no bundler, no dependencies.
//
// Query parameters, all optional:
//   ?host=    where the host is served          (default https://valuguru.texpo.io)
//   ?signin=  the Valu brand users sign in on   (default https://live.valuverse.io)
//   ?app=     the app's address, <workspace>/<slug>; a dev host serves a localhost
//             page under it, a production host ignores it
import { createValuApp, Intent } from '../../src/ValuApi.js';

const query = new URLSearchParams(location.search);
const options = {};
if (query.get('host')) options.hostOrigin = query.get('host');
if (query.get('signin')) options.signInOrigin = query.get('signin');
if (query.get('app')) options.app = query.get('app');

const $ = (id) => document.getElementById(id);
const authEl = $('auth');
const connectionEl = $('connection');
const out = $('out');
const buttons = {
  signIn: $('sign-in'),
  usersCurrent: $('users-current'),
  rooms: $('rooms'),
  commerce: $('commerce'),
};

/** The ValuApp, once the host has answered; `null` before, and if it never did. */
let valu = null;
/** Why the app could not start, `{code, message}`, when it could not. */
let failure = null;

// --- what the page shows -----------------------------------------------------

/** The three settings in use, so a wrong query string is seen before anything is clicked. */
const configEl = $('config');
const settings = [
  ['host', options.hostOrigin ?? 'https://valuguru.texpo.io (default)'],
  ['sign-in', options.signInOrigin ?? 'https://live.valuverse.io (default)'],
  ['app', options.app ?? 'none'],
];
settings.forEach(([label, value], index) => {
  const code = document.createElement('code');
  code.textContent = value;
  configEl.append(`${index ? ' · ' : ''}${label} `, code);
});

const who = (user) => user?.name ?? user?.displayName ?? user?.id ?? 'unknown user';

/** Re-read `valu.auth.state` and `valu.connection.state` into the two status tiles. */
function render() {
  const auth = valu?.auth.state ?? { signedIn: false, user: null, network: null };
  authEl.dataset.state = auth.signedIn ? 'signed-in' : 'signed-out';
  authEl.replaceChildren(auth.signedIn ? `Signed in as ${who(auth.user)}` : 'Signed out');
  const detail = auth.signedIn ? auth.network?.name : auth.reason;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = auth.signedIn ? `Network: ${detail}` : `Last reason: ${detail}`;
    authEl.append(small);
  }

  const state = failure ? 'failed' : valu?.connection.state ?? 'connecting';
  connectionEl.dataset.state = state;
  connectionEl.replaceChildren(state);
  const lastError = failure?.code ?? valu?.connection.lastError?.code;
  if (lastError) {
    const small = document.createElement('small');
    small.textContent = `Error: ${lastError}`;
    connectionEl.append(small);
  }

  const ready = Boolean(valu) && state !== 'offline' && state !== 'failed';
  for (const button of Object.values(buttons)) if (!button.dataset.busy) button.disabled = !ready;
}

// --- what the page prints ----------------------------------------------------

/** The box keeps the last entries, each cut short, so a long session stays light. */
const MAX_ENTRIES = 50;
const MAX_ENTRY_CHARS = 8000;
/** A key that looks like a credential is never printed, whatever answered. */
const SECRET_KEY = /token|secret|password|passwd|session|cookie|authorization|api[-_]?key/i;
const redact = (key, value) => (SECRET_KEY.test(key) ? '[hidden]' : value);

/** One `<div>` per entry, appended: the box is a live region, so a screen reader hears only the new entry. */
function print(text) {
  $('placeholder')?.remove();
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.textContent = text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}\n… (cut)` : text;
  out.append(entry);
  while (out.children.length > MAX_ENTRIES) out.firstElementChild.remove();
  out.scrollTop = out.scrollHeight;
}

/** `{error: {code, message}}` (a service ack) or `{success: false, code, error}` (an intent ack), else `null`. */
function refusalOf(ack) {
  if (ack && typeof ack.error === 'object' && ack.error) {
    return { code: ack.error.code, message: ack.error.message, scope: ack.error.scope };
  }
  if (ack && ack.success === false) return { code: ack.code, message: ack.error, scope: ack.scope };
  return null;
}

function describe(ack) {
  const refusal = refusalOf(ack);
  const head = refusal
    ? `refused: code ${refusal.code}, ${refusal.message}${refusal.scope ? ` (scope ${refusal.scope})` : ''}`
    : 'ok';
  return `${head}\n${JSON.stringify(ack, redact, 2)}`;
}

const describeError = (error) => `error: code ${error?.code ?? 'none'}, ${error?.message ?? String(error)}`;

/**
 * Run one call from a click and print what came back. `start` is called in the
 * click's own turn, so `signIn()` still opens its window from the user gesture.
 * It gets `show(heading, text)` to print a step of its own, and returns the ack
 * to print under `label`, or `null` when it has printed everything itself.
 */
async function run(button, label, start) {
  button.dataset.busy = 'true';
  button.disabled = true;
  let began = performance.now();
  const show = (heading, text) => {
    print(`${heading}  (${Math.round(performance.now() - began)} ms)\n${text}`);
    began = performance.now();
  };
  try {
    const ack = await start(show);
    if (ack !== null) show(label, describe(ack));
  } catch (error) {
    show(label, describeError(error));
  }
  delete button.dataset.busy;
  render();
}

/**
 * A Commerce intent is not a service function, so the client does not ask for
 * consent for it: the host answers `{success: false, code: 'consent_required', scope}`.
 * The app asks, from the same click, and repeats the intent once if the user allowed it.
 */
async function commerceListProducts(label, show) {
  const listProducts = () => valu.callService(new Intent('Commerce', 'list-products', {}));
  const ack = await listProducts();
  const refusal = refusalOf(ack);
  if (refusal?.code !== 'consent_required' || typeof refusal.scope !== 'string') return ack;

  show(label, describe(ack));
  const asking = `auth.requestConsent(['${refusal.scope}'])`;
  let approved;
  try {
    approved = await valu.auth.requestConsent([refusal.scope]);
  } catch (error) {
    show(asking, `${describeError(error)}\nClick the button again: a browser opens the window only from a click.`);
    return null;
  }
  if (!approved) {
    show(asking, 'not approved (declined, or the window was closed): nothing was repeated');
    return null;
  }
  show(asking, 'approved');
  show(`${label}, once more`, describe(await listProducts()));
  return null;
}

// --- start -------------------------------------------------------------------

buttons.signIn.addEventListener('click', () => run(buttons.signIn, 'auth.signIn()', () => valu.auth.signIn()));
buttons.usersCurrent.addEventListener('click', () => run(buttons.usersCurrent, 'Users.current()', () => valu.Users.current()));
buttons.rooms.addEventListener('click', () => run(buttons.rooms, "Rooms.searchMyRooms({ filter: 'all', size: 5 })", () => (
  valu.Rooms.searchMyRooms({ filter: 'all', size: 5 })
)));
const COMMERCE_LABEL = "callService(new Intent('Commerce', 'list-products', {}))";
buttons.commerce.addEventListener('click', () => run(buttons.commerce, COMMERCE_LABEL, (show) => commerceListProducts(COMMERCE_LABEL, show)));

render();
try {
  valu = await createValuApp(options);
  valu.auth.on('change', render);
  valu.connection.on('change', render);
  print(`host ready (${valu.mode} mode)`);
} catch (error) {
  failure = { code: error?.code ?? 'error', message: error?.message ?? String(error) };
  print(`createValuApp failed\n${describeError(error)}`);
}
render();
