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

const MAX_CHARS = 20_000;
/** A key that looks like a credential is never printed, whatever answered. */
const SECRET_KEY = /token|secret|password|passwd|session|cookie|authorization|api[-_]?key/i;
const redact = (key, value) => (SECRET_KEY.test(key) ? '[hidden]' : value);

let printed = false;
function print(text) {
  out.textContent = (printed ? `${out.textContent}\n\n` : '') + text;
  printed = true;
  if (out.textContent.length > MAX_CHARS) out.textContent = `…${out.textContent.slice(-MAX_CHARS)}`;
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
 */
async function run(button, label, start) {
  button.dataset.busy = 'true';
  button.disabled = true;
  const began = performance.now();
  let text;
  try {
    text = describe(await start());
  } catch (error) {
    text = describeError(error);
  }
  print(`${label}  (${Math.round(performance.now() - began)} ms)\n${text}`);
  delete button.dataset.busy;
  render();
}

// --- start -------------------------------------------------------------------

buttons.signIn.addEventListener('click', () => run(buttons.signIn, 'auth.signIn()', () => valu.auth.signIn()));
buttons.usersCurrent.addEventListener('click', () => run(buttons.usersCurrent, 'Users.current()', () => valu.Users.current()));
buttons.rooms.addEventListener('click', () => run(buttons.rooms, "Rooms.searchMyRooms({ filter: 'all', size: 5 })", () => (
  valu.Rooms.searchMyRooms({ filter: 'all', size: 5 })
)));
buttons.commerce.addEventListener('click', () => run(buttons.commerce, "callService(new Intent('Commerce', 'list-products', {}))", () => (
  valu.callService(new Intent('Commerce', 'list-products', {}))
)));

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
