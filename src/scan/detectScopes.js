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
// A call whose name is decided at run time (`valu.call(name)`, `new Intent(s, a)`,
// `valu[svc][fn]()`) cannot be read; it is listed in `unresolved` so a reviewer
// can ask what it does. A small lexer blanks comments and the insides of
// strings, templates and regex literals first (same length, so line numbers
// hold), so text in a string is never a call; in an HTML, Vue or Svelte file
// only the `<script>` blocks are read. No parser: TS, JSX, Vue and Svelte read alike.
// ===========================================================================
import { SERVICE_DESCRIPTORS, findDescriptor } from '../services/descriptors.js';
import { scopeOfIntent } from '../host/Permissions.js';
import { SCOPE_PATTERN } from './permissionsFile.js';

/** At most this many findings are kept for one call name, and this many in all. */
export const FINDINGS_PER_CALL = 3;
export const FINDINGS_MAX = 200;
const LINE_TEXT_MAX = 120;

/** `Service` → `method` → descriptor, exactly as the JS surface spells them. */
const BY_MEMBER = new Map();
for (const descriptor of SERVICE_DESCRIPTORS) {
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

// Patterns over the CODE text (comments and the insides of strings, templates
// and regex literals blanked), so text in a string is never a call:
const CODE_PATTERNS = {
  member: new RegExp(String.raw`(?<![\w$])(${SERVICES})${DOT}([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(`, 'g'),
  byNameDynamic: new RegExp(String.raw`\bvalu\w*${DOT}(?:call|invoke)\s*\(\s*(?!['"\x60)])`, 'g'),
  intentAny: /\bnew\s+Intent\s*\(/g,
  getApiDynamic: /\bgetApi\s*\(\s*(?!['"`])/g,
  computed: new RegExp(String.raw`\bvalu\w*(?:${DOT}[\w$]+)*\s*(?:\?\.)?\[`, 'g'),
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
 * @typedef {{scope: string|null, call: string, kind: 'function'|'intent'|'asked'|'bridge', file: string, line: number}} Finding
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

/** One file's raw findings, before de-duplication and the caps. */
function scanFile(path, original) {
  const source = String(original ?? '');
  const { literal, code, inLiteral } = lex(MARKUP.test(path) ? scriptsOnly(source) : source);
  const starts = lineStarts(code);
  const originalLines = source.split('\n');
  const at = (offset) => lineOf(starts, offset);
  const findings = [];
  const bridge = [];
  const unresolved = [];
  const unread = (offset) => {
    const line = at(offset);
    unresolved.push({ file: path, line, text: (originalLines[line - 1] ?? '').trim().slice(0, LINE_TEXT_MAX) });
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
  for (const m of matches(CODE_PATTERNS.byNameDynamic, code)) unread(m.index);

  const intentsRead = new Set();
  for (const m of literalMatches(LITERAL_PATTERNS.intent)) {
    const [service, action] = [m[2], m[4]];
    intentsRead.add(m.index);
    const descriptor = findDescriptor(`${service}.${action}`);
    // The host's intents are named `Commerce` / `Application`; a lower-case
    // name reaches the same intent, so it needs the same scope.
    const scope = descriptor
      ? descriptor.scopes[0]
      : scopeOfIntent(INTENT_SERVICES[service.toLowerCase()] ?? service, action);
    if (scope) findings.push({ scope, call: `${service}.${action}`, kind: 'intent', file: path, line: at(m.index) });
    else bridge.push({ scope: null, call: `${service}.${action}`, kind: 'bridge', file: path, line: at(m.index) });
  }
  for (const m of matches(CODE_PATTERNS.intentAny, code)) {
    // `new Intent(` whose two names were not both literals.
    if (!intentsRead.has(m.index + m[0].indexOf('Intent'))) unread(m.index);
  }

  for (const m of literalMatches(LITERAL_PATTERNS.getApi)) {
    const api = m[2];
    if (!m[3]) bridge.push({ scope: null, call: api, kind: 'bridge', file: path, line: at(m.index) });
    else if (m[4]) bridge.push({ scope: null, call: `${api}.${m[5]}`, kind: 'bridge', file: path, line: at(m.index) });
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

  return { findings, bridge, unresolved };
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
  for (const file of files ?? []) {
    const found = scanFile(String(file?.path ?? ''), file?.text);
    all.findings.push(...found.findings);
    all.bridge.push(...found.bridge);
    all.unresolved.push(...found.unresolved);
  }
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
