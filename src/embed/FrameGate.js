// ===========================================================================
// The permission gate for an app Valu Social frames (embedded mode), the same
// rule the host holds an app at its own address to (the owner's decision,
// 2026-10-29: an app may call only what its valu-permissions.json declares,
// inside Valu Social too).
//
// One gate per framed app, made by Valu Social with that app's declaration
// and grants over its own Valu Guru connection, and a way to ask the user:
//
//   const gate = createFrameGate({ declarations, grants, ask });
//   const frames = createFrameServer({ services, gate: gate.permit });   // api:call
//   const verdict = await gate.permit(scopeOfBridgeIntent(service, action)); // the older bridge messages
//
// What `permit(scope)` answers, in this order. The mode is the declaration's,
// read first, so the gate costs one cached read and nothing else while off:
//
//   off      `{ok: true}` for everything: embedded apps run as they always did.
//   report   `{ok: true}` for everything; a scope the app does not declare is
//            counted (`reportMiss`). Nothing a user sees changes.
//   enforce  the host's order: a forbidden scope is `forbidden`, an unknown
//            one (or none) `unknown_function`, a local one (`Http.*`, which
//            the older bridge runs in Valu Social) runs only when declared; an
//            undeclared basic or consent scope `permission_not_declared`
//            (counted); a basic scope runs; a consent scope runs with an
//            unrevoked grant, and without one the user is asked ONCE, right
//            there (`ask`, Valu Social's consent dialog): yes is written as a
//            grant and the call runs, no is `consent_required`. Two calls that
//            need the same scope at once share one question.
//
// A declaration that cannot be read is `unavailable`, never a pass; so is a
// grant list that cannot be read. `permit` never rejects.
// ===========================================================================
import { HOST_ERRORS } from '../host/protocol.js';
import { PERMISSION_MODES, checkDeclared, decide, readDeclaration, tierOf } from '../host/Permissions.js';

const consoleLog = (level, message) => {
  globalThis.console?.[level === 'error' ? 'error' : 'warn']?.(`[valu-frame-gate] ${message}`);
};

const refused = (code, scope) => ({ ok: false, code, scope: scope ?? null });

/**
 * @param {object} options
 * @param {{get: () => Promise<unknown>, reportMiss?: (scope: string, mode: string) => void}} options.declarations
 *   The app's declaration (a `DeclarationStore` with `path: 'embedded'`).
 * @param {{has: (scope: string) => Promise<boolean>, grant: (scopes: string[]) => Promise<void>}} options.grants
 *   The user's grants for this app (a `GrantsStore`).
 * @param {(scopes: string[]) => Promise<boolean>} options.ask Show the consent dialog; true for yes.
 * @param {(level: 'warn'|'error', message: string) => void} [options.log]
 * @returns {Readonly<{permit: (scope: string|null|undefined) => Promise<{ok: true}|{ok: false, code: string, scope: string|null}>}>}
 */
export function createFrameGate({ declarations, grants, ask, log = consoleLog } = {}) {
  if (typeof declarations?.get !== 'function') throw new TypeError('createFrameGate needs declarations with get()');
  if (typeof grants?.has !== 'function' || typeof grants?.grant !== 'function') {
    throw new TypeError('createFrameGate needs grants with has() and grant()');
  }
  if (typeof ask !== 'function') throw new TypeError('createFrameGate needs ask(scopes)');

  const say = (level, message) => {
    try {
      log(level, message);
    } catch { /* a logger that throws must not take the answer with it */ }
  };
  const miss = (scope, mode) => {
    try {
      declarations.reportMiss?.(scope, mode);
    } catch { /* counting a miss never decides a call */ }
  };

  /** scope → the question already on screen for it. */
  const asking = new Map();

  async function consent(scope) {
    let question = asking.get(scope);
    if (!question) {
      question = (async () => {
        const yes = (await ask([scope])) === true;
        if (yes) await grants.grant([scope]);
        return yes;
      })().finally(() => asking.delete(scope));
      asking.set(scope, question);
    }
    return question;
  }

  async function permit(scope) {
    let declaration;
    try {
      declaration = readDeclaration(await declarations.get());
    } catch (error) {
      say('warn', `the app's declared permissions could not be read (${error?.code ?? error?.name ?? 'error'})`);
      return refused(HOST_ERRORS.UNAVAILABLE, scope);
    }
    if (declaration.mode === PERMISSION_MODES.OFF) return { ok: true };

    const declared = checkDeclared({ scope, declaration });
    const localMiss = tierOf(scope) === 'local' && !declaration.scopes?.includes(scope);
    if (declared.miss || localMiss) miss(scope, declaration.mode);
    if (declaration.mode === PERMISSION_MODES.REPORT) return { ok: true };

    const tier = tierOf(scope);
    // A local scope (`Http.*`) the host leaves to the app page; through the
    // older bridge Valu Social runs it itself, so here it runs when declared.
    if (tier === 'local') {
      return declaration.scopes?.includes(scope) ? { ok: true } : refused(HOST_ERRORS.PERMISSION_NOT_DECLARED, scope);
    }
    if (tier !== 'basic' && tier !== 'consent') return refused(decide({ scope }).code, scope);
    if (!declared.ok) return refused(declared.code, scope);
    if (tier === 'basic') return { ok: true };

    try {
      if ((await grants.has(scope)) === true) return { ok: true };
      if (await consent(scope)) return { ok: true };
    } catch (error) {
      say('warn', `the consent for ${scope} could not be read or written (${error?.code ?? error?.name ?? 'error'})`);
      return refused(HOST_ERRORS.UNAVAILABLE, scope);
    }
    return refused(HOST_ERRORS.CONSENT_REQUIRED, scope);
  }

  return Object.freeze({
    async permit(scope) {
      try {
        return await permit(scope);
      } catch (error) {
        say('error', `the permission check failed (${error?.code ?? error?.name ?? 'error'})`);
        return refused(HOST_ERRORS.UNAVAILABLE, scope);
      }
    },
  });
}
