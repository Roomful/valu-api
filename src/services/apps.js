// ===========================================================================
// `valu.Apps.open(appId)` and `valu.Apps.send(appId, action, params)`: an
// application intent whose app is the caller's to name (typed app intents,
// docs/superpowers/specs/2026-11-03-typed-app-intents-design.md §10.1, decided
// 2026-11-06).
//
// Every intent a Valu Social app declares is a function of its own
// (`valu.Chats.openChannel(...)`). These two reach the rest: opening any app,
// and an intent to an app no manifest here names, a framed or Developer Portal
// app above all, which decides for itself what it does with it.
//
// They are built from a descriptor like every function, made when they are
// called, so the transports and the frame server treat them as any other app
// intent:
//
//   - the app and action a catalogue function names: THAT descriptor, params
//     checked against it (`valu.Apps.send('textchat', 'open-channel', {...})`
//     is `valu.Chats.openChannel({...})`);
//   - otherwise one made here: `Apps.open` takes `route` and `pushToHistory`,
//     `Apps.send` any params (the app knows its own). Its scope is the one the
//     bridge computes for the same intent, `scopeOfAppIntent`, with an app id
//     no snapshot names taken for a frame (`apps:intent`); Valu Social scopes it
//     again with what it knows, and an intent with no scope is refused here
//     before anything is sent.
//
// No DOM, no I/O.
// ===========================================================================
import { INTENT_DESCRIPTORS, APPLICATION_TARGETS } from './catalog.generated.js';
import { scopeOfAppIntent } from '../host/BridgeScopes.js';
import { ERROR_CODES, errorAck } from '../Errors.js';

export const APPS = 'Apps';
const OPEN = 'open';

/** `<app id>\n<action>` → the catalogue's app-intent descriptor. */
const BY_TARGET = new Map(INTENT_DESCRIPTORS
  .filter((d) => d.target === 'application')
  .map((d) => [`${d.to}\n${d.action}`, d]));

const ROUTE_PARAMS = Object.freeze({
  required: Object.freeze([]),
  optional: Object.freeze([
    Object.freeze({ name: 'route', type: 'string', description: 'Open the app at this route of its own.' }),
    Object.freeze({ name: 'pushToHistory', type: 'boolean', description: 'Whether opening the app is a new history entry.' }),
  ]),
});
const NO_PARAMS = Object.freeze({ required: Object.freeze([]), optional: Object.freeze([]) });

/** Whether Valu Social frames `appId`; an id no snapshot names is a Developer Portal or framed app. */
export const isFrameApp = (appId) => (Object.hasOwn(APPLICATION_TARGETS, appId) ? APPLICATION_TARGETS[appId].frame : true);

/**
 * The catalogue's descriptor of an application intent, by where it goes.
 * @param {string} appId
 * @param {string} action
 * @returns {import('./descriptors.js').ServiceDescriptor|undefined}
 */
export function findAppIntent(appId, action) {
  return typeof appId === 'string' && typeof action === 'string' ? BY_TARGET.get(`${appId}\n${action}`) : undefined;
}

/**
 * The descriptor `valu.Apps.open` / `valu.Apps.send` runs: the catalogue's, or
 * one made for this app and action. `null` when the two are not names, or the
 * intent has no scope (it would be refused).
 * @param {string} appId
 * @param {string} [action] `open` when omitted
 * @returns {object|null}
 */
export function appIntentDescriptor(appId, action = OPEN) {
  if (typeof appId !== 'string' || appId === '' || typeof action !== 'string' || action === '') return null;
  const known = findAppIntent(appId, action);
  if (known) return known;
  const scope = scopeOfAppIntent(appId, action, { toFrame: isFrameApp(appId) });
  if (!scope) return null;
  const open = action === OPEN;
  const method = open ? 'open' : 'send';
  return Object.freeze({
    key: `${APPS}.${method}`,
    service: APPS,
    action,
    fn: method,
    method,
    toolName: `service__${APPS}__${method}`,
    serviceTitle: 'Apps',
    serviceDescription: 'Any Valu Social app, by its id.',
    source: 'src/services/apps.js',
    description: open ? `Open the app ${appId}.` : `Send ${appId} the intent ${action}.`,
    availability: Object.freeze(['developer']),
    permissions: Object.freeze([]),
    scopes: Object.freeze([scope]),
    // What another app does with it is its own: never retried, never cached.
    mutates: !open,
    cache: Object.freeze({ mode: 'none' }),
    channel: 'intent',
    target: 'application',
    to: appId,
    mode: open ? 'window' : 'embedded-served',
    returns: Object.freeze({ type: 'unknown', description: '' }),
    params: open ? ROUTE_PARAMS : NO_PARAMS,
    ...(open ? {} : { anyParams: true }),
    sdkParams: Object.freeze([]),
    declaredBy: 'sdk',
    implementedBy: null,
  });
}

/** The ack for an `Apps` call whose app and action name nothing that may be sent. */
const refused = (appId, action) => errorAck(
  ERROR_CODES.UNKNOWN_FUNCTION,
  `no intent ${String(appId)}.${String(action ?? OPEN)} an app may send`,
);

/**
 * The two hand-written `valu.Apps` functions over a runner: `run(descriptor,
 * params, options)` is `ServiceClient.run` (the ack) or `runData` (the
 * payload, throwing). `refuse` turns a refusal into what the runner would
 * answer for it.
 * @param {(descriptor: object, params: object, options?: object) => Promise<any>} run
 * @param {(ack: object) => any} [refuse]
 */
export function appsFunctions(run, refuse = (ack) => ack) {
  const open = (appId, options = {}, callOptions) => {
    const descriptor = appIntentDescriptor(appId, OPEN);
    if (!descriptor) return Promise.resolve().then(() => refuse(refused(appId, OPEN)));
    const { route, pushToHistory, ...rest } = options && typeof options === 'object' ? options : {};
    const params = {
      ...rest,
      ...(route !== undefined ? { route } : {}),
      ...(pushToHistory !== undefined ? { pushToHistory } : {}),
    };
    return run(descriptor, params, callOptions);
  };
  const send = (appId, action, params = {}, callOptions) => {
    const descriptor = appIntentDescriptor(appId, action);
    if (!descriptor) return Promise.resolve().then(() => refuse(refused(appId, action)));
    return run(descriptor, params ?? {}, callOptions);
  };
  Object.defineProperty(open, 'name', { value: 'open' });
  Object.defineProperty(send, 'name', { value: 'send' });
  open.key = `${APPS}.open`;
  send.key = `${APPS}.send`;
  return { open, send };
}
