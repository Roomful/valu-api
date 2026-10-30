// ===========================================================================
// Which valu-api scopes an app's code needs — read from its SOURCE.
//
// The Workspaces publish step runs this over a project's tracked files and
// compares the answer with the app's `valu-permissions.json`; the Developer
// Portal shows the result to the app's developer and its reviewer. It reads
// source, never the built bundle: valu-api ships its whole catalogue in every
// bundle, so a bundle names every function there is.
//
// What it recognises, all with literal names (the shapes `createValuApp()`
// documents, and which keep their names through minification):
//
//   valu.Rooms.searchMyRooms(…)   valu.data.Users.current()   Rooms.getRoom(…)
//   valu.call('Rooms.search-my-rooms', …)   valu.invoke('Users.current')
//   new Intent('Commerce', 'get-cart')       (catalogue function, then Commerce/identity intents)
//   auth.signIn({ scopes: [...] })   auth.requestConsent([...])      → "asked"
//   valuApi.getApi('network').run('id')   runConsoleCommand('…')     → the Valu Social bridge
//
// A HELPER is followed (2026-10-30): a function whose parameter ends up as the
// service, the action or the name of a call —
//
//   const call = (service, action, params) => valu.callService(new Intent(service, action, params));
//   const commerce = (action, params = {}) => call('Commerce', action, params);
//   commerce('get-cart');                                   → Commerce.get-cart, at THIS line
//
// is read at its call sites, through up to HELPER_DEPTH levels, by the
// helper's name (an import keeps the name). Its definition is then not an
// unreadable call. A call whose name is decided at run time and reaches no
// helper (`valu.call(name)` from a value, `new Intent(s, a)` in no function,
// `valu[svc][fn]()`) cannot be read; it is listed in `unresolved` so a reviewer
// can ask what it does. A small lexer blanks comments and the insides of
// strings, templates and regex literals first (same length, so line numbers
// hold), so text in a string is never a call; in an HTML, Vue or Svelte file
// only the `<script>` blocks are read. No parser: TS, JSX, Vue and Svelte read alike.
// ===========================================================================
import { SERVICE_DESCRIPTORS, INTENT_DESCRIPTORS, findDescriptor } from '../services/descriptors.js';
import { scopeOfIntent } from '../host/Permissions.js';
import { scopeOfApiCommand, scopeOfAppIntent, scopeOfServiceIntent } from '../host/BridgeScopes.js';
import { SCOPE_PATTERN } from './permissionsFile.js';

/** At most this many findings are kept for one call name, and this many in all. */
export const FINDINGS_PER_CALL = 3;
export const FINDINGS_MAX = 200;
const LINE_TEXT_MAX = 120;
/** How many helpers deep a call is followed: `m(e) → p(e) → call('Application', e)` is three. */
export const HELPER_DEPTH = 4;

/** `Service` → `method` → descriptor, exactly as the JS surface spells them. */
const BY_MEMBER = new Map();
for (const descriptor of [...SERVICE_DESCRIPTORS, ...INTENT_DESCRIPTORS]) {
  if (!BY_MEMBER.has(descriptor.service)) BY_MEMBER.set(descriptor.service, new Map());
  BY_MEMBER.get(descriptor.service).set(descriptor.method, descriptor);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SERVICES = [...BY_MEMBER.keys()].sort((a, b) => b.length - a.length).map(escape).join('|');

// A literal argument: a quote, text with no quote or newline, the SAME quote
// (back-reference `n` is that quote's group number).
const lit = (n) => "(['\"`])([^'\"`\\n]*)\\" + n;

/** `.` or `?.` between two names. */
const DOT = String.raw`\s*(?:\?\.|\.)\s*`;

/**
 * The valu-api object by its usual names — `valu`, `valuApp`, `valuApi`,
 * `valu_app` — and never an ordinary word that starts the same way: `value`,
 * `values`, `valuation` are form fields and arrays, not the platform.
 */
const VALU = String.raw`\bvalu(?![a-z])[\w$]*`;

// Patterns over the CODE text (comments and the insides of strings, templates
// and regex literals blanked), so text in a string is never a call:
const CODE_PATTERNS = {
  member: new RegExp(String.raw`(?<![\w$])(${SERVICES})${DOT}([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(`, 'g'),
  byNameDynamic: new RegExp(String.raw`${VALU}${DOT}(?:call|invoke)\s*\(\s*(?!['"\x60)])`, 'g'),
  intentAny: /\bnew\s+Intent\s*\(/g,
  getApiDynamic: /\bgetApi\s*\(\s*(?!['"`])/g,
  computed: new RegExp(String.raw`${VALU}(?:${DOT}[\w$]+)*\s*(?:\?\.)?\[`, 'g'),
  askedDynamic: /(?:\brequestConsent\s*\(\s*(?![[\s)])|\bsignIn\s*\(\s*\{[^}]*?\bscopes\s*:\s*(?![[\s]))/g,
};

// Patterns that need their literal arguments: run over the LITERAL text (only
// comments blanked), and kept only when they START in code, not in a string.
const LITERAL_PATTERNS = {
  byName: new RegExp(String.raw`\.\s*(?:call|invoke)\s*\(\s*${lit(1)}`, 'g'),
  intent: new RegExp(String.raw`\bIntent\s*\(\s*${lit(1)}\s*,\s*${lit(3)}`, 'g'),
  getApi: new RegExp(String.raw`\bgetApi\s*\(\s*${lit(1)}\s*\)(\s*\.\s*run\s*\(\s*(?:${lit(4)})?)?`, 'g'),
  console: new RegExp(String.raw`\brunConsoleCommand\s*\(\s*(?:${lit(1)})?`, 'g'),
  asked: /(?:\brequestConsent\s*\(\s*|\bsignIn\s*\(\s*\{[^}]*?\bscopes\s*:\s*)\[([^\]]*)\]/g,
};

/**
 * A function header, with its name and parameter list — what a helper is
 * recognised by: `function name(a, b)`, `name = (a, b) =>`, `name = a =>`,
 * `name = function (a)`, `name = async (a) =>`, and a method `name(a) {`.
 */
const HEADER = new RegExp(String.raw`(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)`
  + String.raw`|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*\(([^()]*)\)|\(([^()]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)`
  + String.raw`|(?<![\w$.])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{)`, 'g');
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'await', 'async', 'else', 'do']);

/** The services whose intents carry a scope, by their lower-case name. */
const INTENT_SERVICES = { commerce: 'Commerce', application: 'Application' };

/** After these, a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER_CHAR = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await']);

/**
 * Read a file the way the patterns need it, keeping every offset and newline:
 *
 * - `literal`: comments blanked;
 * - `code`: comments AND the insides of strings, template text and regex
 *   literals blanked (the quotes stay; `${…}` inside a template is code);
 * - `inLiteral[i]`: whether offset i is inside a string, template text or regex.
 *
 * A block comment that never closes blanks nothing: reading too much is safer
 * than hiding the rest of the file.
 *
 * @param {string} text
 */
function lex(text) {
  const literal = text.split('');
  const code = text.split('');
  const inLiteral = new Uint8Array(text.length);
  const blankBoth = (from, to) => {
    for (let k = from; k < to; k++) if (text[k] !== '\n') { literal[k] = ' '; code[k] = ' '; }
  };
  const markLiteral = (from, to) => {
    for (let k = from; k < to; k++) {
      inLiteral[k] = 1;
      if (text[k] !== '\n') code[k] = ' ';
    }
  };

  // Each `${` opens a code region inside a template; its brace depth tells
  // which `}` closes it and returns to the template's text.
  const templateDepths = [];
  let prev = '';      // the last significant character
  let prevWord = '';  // the last identifier, when `prev` ended one
  let i = 0;

  const readTemplate = () => {
    // At a template's text (after "`" or after the `}` closing a `${`).
    const from = i;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '`') { markLiteral(from, i); i += 1; prev = '`'; prevWord = ''; return; }
      if (text[i] === '$' && text[i + 1] === '{') {
        markLiteral(from, i);
        i += 2;
        templateDepths.push(0);
        prev = '{';
        prevWord = '';
        return;
      }
      i += 1;
    }
    markLiteral(from, i);
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      markLiteral(i + 1, Math.min(j, text.length));
      i = j + 1;
      prev = c;
      prevWord = '';
    } else if (c === '`') {
      i += 1;
      readTemplate();
    } else if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blankBoth(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) { i += 2; continue; }
      blankBoth(i, end + 2);
      i = end + 2;
    } else if (c === '/' && (prev === '' || REGEX_AFTER_CHAR.has(prev) || REGEX_AFTER_WORD.has(prevWord))) {
      // A regex literal: to the unescaped `/` outside a character class, on this line.
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      if (j < text.length && text[j] === '/') {
        markLiteral(i + 1, j);
        i = j + 1;
        prev = '/';
        prevWord = '';
      } else {
        i += 1;
        prev = '/';
      }
    } else if (c === '{' && templateDepths.length) {
      templateDepths[templateDepths.length - 1] += 1;
      i += 1;
      prev = c;
      prevWord = '';
    } else if (c === '}' && templateDepths.length) {
      if (templateDepths[templateDepths.length - 1] === 0) {
        templateDepths.pop();
        i += 1;
        readTemplate();
      } else {
        templateDepths[templateDepths.length - 1] -= 1;
        i += 1;
        prev = c;
        prevWord = '';
      }
    } else if (/[\w$]/.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      prevWord = text.slice(i, j);
      prev = text[j - 1];
      i = j;
    } else {
      if (!/\s/.test(c)) {
        prev = c;
        prevWord = '';
      }
      i += 1;
    }
  }
  return { literal: literal.join(''), code: code.join(''), inLiteral };
}

/**
 * `text` with its comments blanked, offsets and newlines kept.
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  return lex(String(text ?? '')).literal;
}

/** HTML-like files are markup with code only inside `<script>`: blank the rest. */
const MARKUP = /\.(html?|vue|svelte)$/i;
function scriptsOnly(text) {
  const out = text.split('').map((ch) => (ch === '\n' ? '\n' : ' '));
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const from = m.index + m[0].indexOf('>') + 1;
    for (let k = 0; k < m[1].length; k++) out[from + k] = text[from + k];
  }
  return out.join('');
}

/** Offsets of each line's first character, for offset → 1-based line. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * @typedef {{scope: string|null, call: string, kind: 'function'|'intent'|'asked'|'bridge', file: string, line: number, via?: string}} Finding
 *   `via`: the helper the call was read through (`commerce`), when it was.
 * @typedef {{file: string, line: number, text: string}} Unresolved
 * @typedef {{scopes: string[], findings: Finding[], bridge: Finding[], unresolved: Unresolved[], truncated: boolean}} ScopeScan
 */

/** Every match of `pattern` in `text`. */
function* matches(pattern, text) {
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    yield m;
    if (m[0].length === 0) pattern.lastIndex++;
  }
}

/** The services a file takes out of an object by name: `const { Rooms, Users } = valu`. */
function destructuredServices(code) {
  const names = new Set();
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=/g)) {
    for (const name of m[1].split(',')) {
      const key = name.split(':')[0].trim();
      if (BY_MEMBER.has(key)) names.add(key);
    }
  }
  return names;
}

/** The parameter names of a header's list: `a, b = {}, ...rest` → `['a', 'b', 'rest']`; a destructured one is `null`. */
function paramNames(list) {
  if (!list.trim()) return [];
  return list.split(',').map((part) => {
    const name = part.replace(/^\s*\.\.\./, '').split(/[=:]/)[0].trim();
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
  });
}

/** Every function header in a file, by offset: `{name, nameOffset, params, end}`. */
function functionHeaders(code) {
  const headers = [];
  for (const m of matches(HEADER, code)) {
    const name = m[1] ?? m[3] ?? m[7];
    const list = m[2] ?? m[4] ?? m[5] ?? (m[6] !== undefined ? m[6] : m[8]) ?? '';
    if (!name || NOT_A_FUNCTION.has(name)) continue;
    const nameOffset = m.index + m[0].indexOf(name);
    headers.push({ name, nameOffset, params: paramNames(list), end: m.index + m[0].length });
  }
  return headers;
}

/** The nearest header before `offset`: the function the code at `offset` is most likely in. */
function enclosingHeader(headers, offset) {
  let found = null;
  for (const header of headers) {
    if (header.end <= offset) found = header;
    else break;
  }
  return found;
}

/**
 * The arguments of the call whose `(` is at `open`, each as the literal string it
 * is, the identifier it is, or neither: `{literal, ident}`. Strings are blanked in
 * `code`, so brackets inside them do not count.
 */
function readArgs(lexed, open) {
  const { code, literal } = lexed;
  const args = [];
  let depth = 0;
  let start = open + 1;
  const push = (from, to) => {
    const text = code.slice(from, to).trim();
    const raw = literal.slice(from, to).trim();
    const quoted = raw.match(/^(['"\x60])([^'"\x60\n]*)\1$/);
    // A template with an expression in it is a name decided at run time.
    const value = quoted && !quoted[2].includes('${') ? quoted[2] : null;
    args.push({ literal: value, ident: /^[A-Za-z_$][\w$]*$/.test(text) ? text : null, empty: text === '' });
  };
  for (let i = open + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        push(start, i);
        break;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  if (args.length === 1 && args[0].empty) return [];
  return args;
}

/**
 * How a helper's call fills the (service, action) of an intent, or the name of
 * a by-name call: each slot is a literal, or `{param}` — the index of the
 * helper's parameter that carries it. Null when a slot is neither (a value
 * computed inside), so the helper cannot be followed.
 */
function helperSlots(header, args, wanted) {
  const slots = [];
  for (let i = 0; i < wanted; i++) {
    const arg = args[i];
    if (!arg) return null;
    if (arg.literal !== null) slots.push({ literal: arg.literal });
    else if (arg.ident !== null && header.params.includes(arg.ident)) slots.push({ param: header.params.indexOf(arg.ident) });
    else return null;
  }
  if (!slots.some((slot) => 'param' in slot)) return null; // every slot literal: not a helper, a plain call
  return slots;
}

/** Read a file the way the patterns need it, plus its headers and line map. */
function lexFile(path, original) {
  const source = String(original ?? '');
  const lexed = lex(MARKUP.test(path) ? scriptsOnly(source) : source);
  return {
    path,
    ...lexed,
    starts: lineStarts(lexed.code),
    originalLines: source.split('\n'),
    headers: functionHeaders(lexed.code),
  };
}

/** One file's raw findings, before de-duplication and the caps. */
function scanFile(lexed) {
  const { path, literal, code, inLiteral, starts, originalLines, headers } = lexed;
  const at = (offset) => lineOf(starts, offset);
  const findings = [];
  const bridge = [];
  const unresolved = [];
  /** Helpers this file defines: `{name, kind: 'intent'|'byName', slots, file, offset}`. */
  const helpers = [];
  const unread = (offset, helper = null) => {
    const line = at(offset);
    unresolved.push({ file: path, line, text: (originalLines[line - 1] ?? '').trim().slice(0, LINE_TEXT_MAX), helper });
  };
  /**
   * A call whose names are not literals: a helper, when it sits in a function
   * whose parameters carry them; unreadable otherwise. The helper's own line
   * stays listed as unreadable until a call site of it is read.
   */
  const dynamic = (kind, open, wanted) => {
    const header = enclosingHeader(headers, open);
    const slots = header ? helperSlots(header, readArgs(lexed, open), wanted) : null;
    if (!slots) return unread(open);
    const helper = { name: header.name, kind, slots, file: path, offset: open, header };
    helpers.push(helper);
    return unread(open, helper);
  };
  const fn = (descriptor, kind, offset) =>
    findings.push({ scope: descriptor.scopes[0], call: descriptor.key, kind, file: path, line: at(offset) });
  /** Literal-text matches that start in code, not inside a string. */
  const literalMatches = (pattern) => [...matches(pattern, literal)].filter((m) => !inLiteral[m.index]);

  // `x.Rooms.getRoom(` — or a bare `Rooms.getRoom(` when this file took
  // `Rooms` out of an object by name. A bare name otherwise is the app's own
  // module (`import * as Http from './http'`), not valu-api.
  const destructured = destructuredServices(code);
  for (const m of matches(CODE_PATTERNS.member, code)) {
    const descriptor = BY_MEMBER.get(m[1])?.get(m[2]);
    if (!descriptor) continue;
    const before = code.slice(0, m.index).trimEnd();
    if (before.endsWith('.') || destructured.has(m[1])) fn(descriptor, 'function', m.index);
  }

  for (const m of literalMatches(LITERAL_PATTERNS.byName)) {
    const descriptor = findDescriptor(m[2]);
    if (descriptor) fn(descriptor, 'function', m.index);
  }
  for (const m of matches(CODE_PATTERNS.byNameDynamic, code)) dynamic('byName', m.index + m[0].lastIndexOf('('), 1);

  const intentsRead = new Set();
  for (const m of literalMatches(LITERAL_PATTERNS.intent)) {
    const [service, action] = [m[2], m[4]];
    if (service.includes('${') || action.includes('${')) continue; // a template with an expression: decided at run time
    intentsRead.add(m.index);
    const descriptor = findDescriptor(`${service}.${action}`);
    // The host's intents are named `Commerce` / `Application`; a lower-case
    // name reaches the same intent, so it needs the same scope.
    const scope = descriptor
      ? descriptor.scopes[0]
      : scopeOfIntent(INTENT_SERVICES[service.toLowerCase()] ?? service, action);
    if (scope) {
      findings.push({ scope, call: `${service}.${action}`, kind: 'intent', file: path, line: at(m.index) });
      continue;
    }
    // Not the host's: an intent of Valu Social's older bridge, a service's or
    // an application's. Its scope is what Valu Social will check it against.
    const bridged = scopeOfServiceIntent(service, action) ?? scopeOfAppIntent(service, action);
    if (bridged) findings.push({ scope: bridged, call: `${service}.${action}`, kind: 'bridge', file: path, line: at(m.index) });
    else bridge.push({ scope: null, call: `${service}.${action}`, kind: 'bridge', file: path, line: at(m.index) });
  }
  for (const m of matches(CODE_PATTERNS.intentAny, code)) {
    // `new Intent(` whose two names were not both literals.
    if (!intentsRead.has(m.index + m[0].indexOf('Intent'))) dynamic('intent', m.index + m[0].length - 1, 2);
  }

  for (const m of literalMatches(LITERAL_PATTERNS.getApi)) {
    const api = m[2];
    if (!m[3]) bridge.push({ scope: null, call: api, kind: 'bridge', file: path, line: at(m.index) });
    else if (m[4]) {
      const scope = scopeOfApiCommand(api, m[5]);
      const finding = { scope, call: `${api}.${m[5]}`, kind: 'bridge', file: path, line: at(m.index) };
      (scope ? findings : bridge).push(finding);
    }
    else unread(m.index);
  }
  for (const m of matches(CODE_PATTERNS.getApiDynamic, code)) unread(m.index);

  for (const m of literalMatches(LITERAL_PATTERNS.console)) {
    if (m[1]) bridge.push({ scope: null, call: `console:${m[2]}`, kind: 'bridge', file: path, line: at(m.index) });
    else unread(m.index);
  }

  for (const m of literalMatches(LITERAL_PATTERNS.asked)) {
    for (const scope of m[1].matchAll(/(['"`])([^'"`]*)\1/g)) {
      if (SCOPE_PATTERN.test(scope[2])) {
        findings.push({ scope: scope[2], call: scope[2], kind: 'asked', file: path, line: at(m.index) });
      }
    }
  }
  for (const m of matches(CODE_PATTERNS.askedDynamic, code)) unread(m.index);

  for (const m of matches(CODE_PATTERNS.computed, code)) unread(m.index);

  return { findings, bridge, unresolved, helpers };
}

/**
 * The finding for an intent named at a call site: a catalogue function's scope,
 * the host's own intents', or the older bridge's; a bridge call with no scope.
 */
function intentFinding(service, action, file, line, via) {
  const descriptor = findDescriptor(`${service}.${action}`);
  const scope = descriptor
    ? descriptor.scopes[0]
    : scopeOfIntent(INTENT_SERVICES[service.toLowerCase()] ?? service, action);
  if (scope) return { scope, call: `${service}.${action}`, kind: 'intent', file, line, via };
  const bridged = scopeOfServiceIntent(service, action) ?? scopeOfAppIntent(service, action);
  return { scope: bridged, call: `${service}.${action}`, kind: 'bridge', file, line, via };
}

/**
 * Follow the helpers to their call sites, through HELPER_DEPTH levels. A call
 * site with literal names is a finding at its own line; one that passes a
 * parameter of ITS function on is a helper one level further; any other is
 * unreadable at its own line. A helper that is never called keeps its own
 * definition listed as unreadable.
 */
function followHelpers(lexedFiles, scanned) {
  const findings = [];
  const bridge = [];
  const unresolved = [];
  const resolvedHelpers = new Set();
  let level = scanned.flatMap((s) => s.helpers);
  const seen = new Set(level.map((h) => `${h.file}:${h.offset}`));

  for (let depth = 0; depth < HELPER_DEPTH && level.length; depth++) {
    const next = [];
    for (const helper of level) {
      const callPattern = new RegExp(String.raw`(?<![\w$])${escape(helper.name)}\s*\(`, 'g');
      for (const lexed of lexedFiles) {
        const { path, code, starts, originalLines, headers } = lexed;
        for (const m of matches(callPattern, code)) {
          const open = m.index + m[0].length - 1;
          // Not the definition itself, and not `function name(`.
          if (headers.some((h) => h.nameOffset === m.index)) continue;
          if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
          const args = readArgs(lexed, open);
          const line = lineOf(starts, open);
          const names = [];
          let derived = null;
          let readable = true;
          for (const slot of helper.slots) {
            if ('literal' in slot) {
              names.push(slot.literal);
              continue;
            }
            const arg = args[slot.param];
            if (arg?.literal !== null && arg?.literal !== undefined) {
              names.push(arg.literal);
              continue;
            }
            const header = enclosingHeader(headers, open);
            if (arg?.ident && header && header.params.includes(arg.ident)) {
              derived ??= { name: header.name, kind: helper.kind, slots: [], file: path, offset: open, header };
              names.push({ param: header.params.indexOf(arg.ident) });
              continue;
            }
            readable = false;
            break;
          }
          if (!readable) {
            // The call the helper itself makes inside its body (`valu.callService(new Intent(…))`
            // inside `callService`) is the helper, not a use of it.
            if (path === helper.file && enclosingHeader(headers, open) === helper.header) continue;
            unresolved.push({ file: path, line, text: (originalLines[line - 1] ?? '').trim().slice(0, LINE_TEXT_MAX) });
            continue;
          }
          if (derived) {
            // The slots as the derived helper fills them: a literal stays, a parameter is its own.
            derived.slots = names.map((name) => (typeof name === 'string' ? { literal: name } : name));
            derived.from = helper;
            const key = `${path}:${open}`;
            if (!seen.has(key)) {
              seen.add(key);
              next.push(derived);
            }
            continue;
          }
          // A call read by name: this helper, and every helper it came through, is read.
          for (let h = helper; h; h = h.from) resolvedHelpers.add(h);
          if (helper.kind === 'byName') {
            const descriptor = findDescriptor(names[0]);
            if (descriptor) findings.push({ scope: descriptor.scopes[0], call: descriptor.key, kind: 'function', file: path, line, via: helper.name });
            else unresolved.push({ file: path, line, text: (originalLines[line - 1] ?? '').trim().slice(0, LINE_TEXT_MAX) });
            continue;
          }
          const found = intentFinding(names[0], names[1], path, line, helper.name);
          (found.scope ? findings : bridge).push(found);
        }
      }
    }
    level = next;
  }
  return { findings, bridge, unresolved, resolvedHelpers };
}

const byPlace = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

/** De-duplicate by (call, file, line), keep FINDINGS_PER_CALL per call and FINDINGS_MAX in all. */
function capped(list) {
  const seen = new Set();
  const perCall = new Map();
  const kept = [];
  let truncated = false;
  for (const item of [...list].sort(byPlace)) {
    const key = `${item.kind}|${item.call}|${item.file}|${item.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = perCall.get(item.call) ?? 0;
    if (count >= FINDINGS_PER_CALL || kept.length >= FINDINGS_MAX) {
      truncated = true;
      continue;
    }
    perCall.set(item.call, count + 1);
    kept.push(item);
  }
  return { kept, truncated };
}

/**
 * Read the files and say what they call.
 * @param {{path: string, text: string}[]} files
 * @returns {ScopeScan}
 */
export function detectScopes(files) {
  const all = { findings: [], bridge: [], unresolved: [] };
  const lexedFiles = (files ?? []).map((file) => lexFile(String(file?.path ?? ''), file?.text));
  const scanned = lexedFiles.map((lexed) => scanFile(lexed));
  const followed = followHelpers(lexedFiles, scanned);
  for (const found of scanned) {
    all.findings.push(...found.findings);
    all.bridge.push(...found.bridge);
    // A helper's own line is unreadable only while no call site of it was read.
    all.unresolved.push(...found.unresolved.filter((u) => !(u.helper && followed.resolvedHelpers.has(u.helper))));
  }
  all.findings.push(...followed.findings);
  all.bridge.push(...followed.bridge);
  all.unresolved.push(...followed.unresolved);
  // Every scope seen counts, before any cap: the caps trim the evidence, never the list.
  const scopes = [...new Set(all.findings.map((f) => f.scope).filter(Boolean))].sort();
  const findings = capped(all.findings);
  const bridge = capped(all.bridge);
  const unresolved = capped(all.unresolved.map((u) => ({ ...u, call: `${u.file}:${u.line}`, kind: 'unresolved' })));
  return {
    scopes,
    findings: findings.kept,
    bridge: bridge.kept,
    unresolved: unresolved.kept.map(({ file, line, text }) => ({ file, line, text })),
    truncated: findings.truncated || bridge.truncated || unresolved.truncated,
  };
}
