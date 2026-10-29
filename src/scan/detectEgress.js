// ===========================================================================
// Where an app's code can send things — the deterministic half of the privacy
// audit (docs/privacy-audit.md).
//
// The Workspaces publish step runs this over a project's tracked source AND
// over the files it actually uploads; the Developer Portal shows the result
// and the app's shield follows it. It answers one question per rule: does this
// code name a way for data to leave the person's device and Valu?
//
//   egress.external-url        fetch / XHR / WebSocket / EventSource / beacon /
//                              import() / .src / a tag's src or href, with a
//                              literal non-Valu URL                    → fail
//   egress.third-party-script  HTML loads a script or stylesheet elsewhere → fail
//   egress.navigation          window.open / location / <a> / <form> to an
//                              outside address that carries data       → fail
//                              (a plain outside link is listed as info)
//   egress.webrtc              RTCPeerConnection / RTCDataChannel       → fail
//   egress.worker              a service worker / Worker               → concern
//   egress.prefetch            dns-prefetch / preconnect / prefetch out → fail
//   egress.dynamic             the target is decided at run time, or eval /
//                              new Function                            → concern
//   valu.onward                Valu's own channels that pass data on: the
//                              Http.* functions, the gateway's /proxy/ and
//                              another app's API                       → fail
//   server.egress              an edge function calling outside       → fail
//   deps.telemetry             an analytics / telemetry package        → fail
//
// plus three inventories that never fail: storage (device and Valu), sends to
// other people inside Valu, and the project's own tables.
//
// No parser, like detectScopes: comments are blanked out first (same length,
// so line numbers hold) and TypeScript, JSX, Vue, Svelte and HTML read alike.
// In BUILT bundles only literal URLs are read — minified code calls fetch(e)
// everywhere, and a URL inside an error message is not a call.
// ===========================================================================
import { detectScopes, stripComments } from './detectScopes.js';
import { isValuUrl, hostOf } from './valuOrigins.js';

/** Bumps whenever a rule below changes what it reports. */
export const EGRESS_RULES_VERSION = '1';

/** @type {readonly {id: string, result: 'fail'|'concern'|'info', title: string}[]} */
export const EGRESS_RULES = Object.freeze([
  { id: 'egress.external-url', result: 'fail', title: 'No requests to addresses outside Valu' },
  { id: 'egress.third-party-script', result: 'fail', title: 'No scripts or styles loaded from elsewhere' },
  { id: 'egress.navigation', result: 'fail', title: 'No navigation that carries data out' },
  { id: 'egress.webrtc', result: 'fail', title: 'No peer-to-peer connections (WebRTC)' },
  { id: 'egress.worker', result: 'concern', title: 'Background workers explained' },
  { id: 'egress.prefetch', result: 'fail', title: 'No prefetching of outside addresses' },
  { id: 'egress.dynamic', result: 'concern', title: 'Addresses decided at run time explained' },
  { id: 'egress.url-literal', result: 'concern', title: 'Every outside address the code names explained' },
  { id: 'valu.onward', result: 'fail', title: "No use of Valu's onward channels (AI proxy, Http, other apps)" },
  { id: 'server.egress', result: 'fail', title: 'Server functions call nothing outside Valu' },
  { id: 'deps.telemetry', result: 'fail', title: 'No analytics or telemetry packages' },
].map((rule) => Object.freeze(rule)));

/**
 * Packages whose job is to send usage data somewhere. A name ending in `/` is a
 * scope: every package under it counts.
 */
export const TELEMETRY_PACKAGES = Object.freeze([
  '@sentry/', 'posthog-js', 'posthog-node', 'mixpanel', 'mixpanel-browser', '@segment/', 'analytics-node',
  '@amplitude/', 'amplitude-js', 'react-ga', 'react-ga4', 'ga-gtag', 'vue-gtag', '@analytics/google-analytics',
  'firebase/analytics', '@firebase/analytics', '@hotjar/browser', 'react-hotjar', '@datadog/browser-rum',
  '@datadog/browser-logs', 'logrocket', 'logrocket-react', '@fullstory/browser', 'heap-api', '@heap/',
  'newrelic', '@newrelic/', 'bugsnag-js', '@bugsnag/', 'rollbar', 'smartlook-client', 'mouseflow',
  'plausible-tracker', '@vercel/analytics', 'clarity-js', '@microsoft/clarity', 'intercom-client',
  '@intercom/messenger-js-sdk', 'trackjs',
]);

/** Paths on Valu's servers that pass data on to somebody else. */
export const ONWARD_PATHS = Object.freeze(['/proxy/', '/api/apps/v1/']);

/** Scopes whose functions reach other people inside Valu: each send must be the person's own act. */
export const SENDS_TO_OTHERS = Object.freeze([
  'textchat:write', 'rooms:write', 'groups:write', 'events:write', 'users:write', 'commerce:write',
]);

const STORAGE_SCOPES = new Set(['applicationstorage:write', 'applicationstorage:read', 'cms:write']);
const ONWARD_SCOPES = new Set(['http:read', 'http:write']);
const SNIPPET_MAX = 160;
/** Identifiers that look like addresses but are never fetched: XML and schema namespaces. */
const HARMLESS_HOSTS = /^(?:www\.w3\.org|schema\.org|json-schema\.org|purl\.org|ns\.adobe\.com)$/i;

const CODE_FILE = /\.(?:[cm]?js|jsx|ts|tsx|vue|svelte|html?)$/i;
const CSS_FILE = /\.css$/i;
const FUNCTIONS_DIR = /(?:^|\/)supabase\/functions\//;

// A literal: a quote, then text with no quote or newline, then the SAME quote.
const lit = (n) => "(['\"`])([^'\"`\\n]*)\\" + n;

const P = {
  // calls whose first argument is the address
  call: new RegExp(String.raw`(?:^|[^\w$.])(?:(?:window|self|globalThis|navigator)\s*\.\s*)?(fetch|sendBeacon|importScripts)\s*\(\s*` + lit(2), 'g'),
  callAny: /(?:^|[^\w$.])(?:(?:window|self|globalThis|navigator)\s*\.\s*)?(fetch|sendBeacon)\s*\(\s*(?![\s'"`)])/g,
  ctor: new RegExp(String.raw`\bnew\s+(WebSocket|EventSource|Worker|SharedWorker)\s*\(\s*` + lit(2), 'g'),
  ctorAny: /\bnew\s+(WebSocket|EventSource)\s*\(\s*(?![\s'"`)])/g,
  // XHR open with any method: `x.open("POST", url)`, `x.open(method, url)`.
  xhrOpen: new RegExp(String.raw`\.open\s*\(\s*[^,()\n]+?,\s*` + lit(1), 'g'),
  xhrOpenAny: /\.open\s*\(\s*(['"])[A-Za-z]+\1\s*,\s*(?![\s'"`])/g,
  // HTTP libraries: axios.post(url), ky(url), $.getJSON(url), got.get(url) …
  lib: new RegExp(String.raw`(?:^|[^\w$.])(axios|ky|got|superagent|ofetch|\$fetch|jQuery|\$)(?:\s*\.\s*(?:get|post|put|patch|delete|head|options|request|ajax|getJSON|getScript|load))?\s*\(\s*` + lit(2), 'g'),
  setAttr: new RegExp(String.raw`\.setAttribute\s*\(\s*(['"])(src|href|action|data|poster|srcset)\1\s*,\s*` + lit(3) + String.raw`(\s*\+)?`, 'g'),
  // any literal absolute address in the source
  urlLiteral: /(['"`])((?:https?:|wss?:)?\/\/[^'"`\s]+)\1/g,
  staticImport: /\bfrom\s+(['"])((?:https?:)?\/\/[^'"\n]+)\1/g,
  dynImport: new RegExp(String.raw`\bimport\s*\(\s*` + lit(1), 'g'),
  srcAssign: new RegExp(String.raw`\.src\s*=\s*` + lit(1), 'g'),
  // navigation
  navCall: new RegExp(String.raw`\b(?:window\s*\.\s*open|location\s*\.\s*(?:assign|replace))\s*\(\s*` + lit(1) + String.raw`(\s*\+)?`, 'g'),
  navAssign: new RegExp(String.raw`\blocation(?:\s*\.\s*href)?\s*=(?!=)\s*` + lit(1) + String.raw`(\s*\+)?`, 'g'),
  navAny: /\b(?:window\s*\.\s*open|location\s*\.\s*(?:assign|replace))\s*\(\s*(?![\s'"`)])|\blocation(?:\s*\.\s*href)?\s*=(?!=)\s*(?![\s'"`])/g,
  // tags, in HTML and in JSX
  tagSrc: /<(script|iframe|img|audio|video|source|embed|track)\b[^>]*?\bsrc\s*=\s*(?:\{?\s*(['"`])([^'"`\n]*)\2|([^\s>'"`{]+))/gi,
  link: /<link\b[^>]*>/gi,
  anchor: /<a\b[^>]*?\bhref\s*=\s*\{?\s*(['"`])([^'"`\n]*)\1(\s*\+)?/gi,
  form: /<form\b[^>]*?\baction\s*=\s*\{?\s*(['"`])([^'"`\n]*)\1/gi,
  cssUrl: /(?:@import\s+|url\(\s*)(['"]?)((?:https?:)?\/\/[^'")\s]+)\1/gi,
  // capabilities
  webrtc: /\bnew\s+(?:webkit)?RTCPeerConnection\s*\(|\bcreateDataChannel\s*\(/g,
  worker: /\bserviceWorker\s*\.\s*register\s*\(|\bnew\s+(?:Shared)?Worker\s*\(/g,
  evalLike: /(?:^|[^\w$.])eval\s*\(|\bnew\s+Function\s*\(/g,
  denoConnect: /\bDeno\s*\.\s*connect(?:Tls)?\s*\(/g,
  callValuApp: /\bcallValuApp\s*\(/g,
  // storage
  storage: /\b(localStorage|sessionStorage|indexedDB|caches\s*\.\s*open|document\s*\.\s*cookie)\b/g,
  table: /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([A-Za-z_][\w.]*)["`]?/gi,
  // any literal that names an onward path
  onwardLiteral: /(['"`])([^'"`\n]*?(?:\/api\/app\/v1\/proxy\/|\/proxy\/[a-z]+\/|\/api\/apps\/v1\/)[^'"`\n]*)\1/g,
};

/**
 * @typedef {{path: string, text: string|null|undefined}} SourceFile
 * @typedef {{rule: string, result: 'fail'|'concern'|'info', file: string, line: number, detail: string,
 *   host?: string, snippet?: string}} EgressFinding
 * @typedef {{rulesVersion: string, findings: EgressFinding[], inventory: {storage: EgressFinding[],
 *   sends: EgressFinding[], deps: string[], tables: string[]}}} EgressScan
 */

/**
 * Read an app and say where it can send things.
 *
 * @param {{source?: SourceFile[], built?: SourceFile[], packageJson?: string|null, lockfile?: string|null,
 *   migrations?: SourceFile[]}} input
 * @param {{siteOrigin?: string, extraOrigins?: string[]}} [opts] the app's own origin, and origins the
 *   caller knows are Valu for THIS app (its database address, the Valu Guru gateway)
 * @returns {EgressScan}
 */
export function detectEgress(input, opts = {}) {
  const ctx = { opts, findings: [], seen: new Set(), storage: [] };
  const source = (input?.source ?? []).filter((f) => typeof f?.text === 'string');

  for (const file of source) scanSource(ctx, file);
  for (const file of input?.built ?? []) {
    if (typeof file?.text === 'string') scanBuilt(ctx, file);
  }

  // Valu scopes, read the way the permissions scan reads them.
  const scopes = detectScopes(source.filter((f) => CODE_FILE.test(f.path)));
  const sends = [];
  for (const f of scopes.findings) {
    if (ONWARD_SCOPES.has(f.scope)) {
      add(ctx, { rule: 'valu.onward', result: 'fail', file: f.file, line: f.line,
        detail: `Calls ${f.call} (${f.scope}), which fetches outside Valu on the app's behalf` });
    } else if (SENDS_TO_OTHERS.includes(f.scope)) {
      sends.push({ rule: 'valu.sends-to-others', result: 'info', file: f.file, line: f.line,
        detail: `${f.call} (${f.scope})` });
    } else if (STORAGE_SCOPES.has(f.scope)) {
      ctx.storage.push({ rule: 'storage.inventory', result: 'info', file: f.file, line: f.line,
        detail: `Keeps data in the person's Valu account: ${f.call} (${f.scope})` });
    }
  }

  const deps = dependencies(input?.packageJson);
  for (const name of telemetry(deps, input?.lockfile)) {
    add(ctx, { rule: 'deps.telemetry', result: 'fail', file: name.from, line: 0,
      detail: `Includes ${name.name}, a package that sends usage data` });
  }

  const tables = [];
  for (const file of input?.migrations ?? []) {
    if (typeof file?.text !== 'string') continue;
    const text = stripComments(file.text);
    for (const m of text.matchAll(P.table)) {
      const name = m[1].split('.').pop();
      if (!tables.includes(name)) tables.push(name);
    }
  }

  return {
    rulesVersion: EGRESS_RULES_VERSION,
    findings: ctx.findings,
    inventory: { storage: ctx.storage, sends, deps: Object.keys(deps.runtime), tables },
  };
}

function scanSource(ctx, file) {
  const path = String(file.path ?? '');
  const isCss = CSS_FILE.test(path);
  if (!CODE_FILE.test(path) && !isCss) return;
  // HTML is not JavaScript: an unquoted `src=https://…` is not a `//` comment.
  // Blank only `<!-- … -->` there (same length, so lines hold).
  const text = isCss
    ? file.text
    : /\.html?$/i.test(path)
      ? file.text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '))
      : stripComments(file.text);
  const starts = lineStarts(text);
  const inFunction = FUNCTIONS_DIR.test(path);
  const at = (offset) => ({ file: path, line: lineOf(starts, offset), snippet: snippet(file.text, starts, offset) });

  if (isCss) return scanCss(ctx, text, at);

  scanCalls(ctx, text, at, { inFunction, dynamic: true });
  scanTags(ctx, text, at);
  scanNavigation(ctx, text, at, { dynamic: true });

  for (const m of text.matchAll(P.webrtc)) {
    add(ctx, { rule: 'egress.webrtc', result: 'fail', ...at(m.index), detail: 'Opens a peer-to-peer connection, which can reach any server' });
  }
  for (const m of text.matchAll(P.worker)) {
    add(ctx, { rule: 'egress.worker', result: 'concern', ...at(m.index), detail: 'Starts a background worker; what it sends must be explained' });
  }
  for (const m of text.matchAll(P.evalLike)) {
    add(ctx, { rule: 'egress.dynamic', result: 'concern', ...at(m.index), detail: 'Runs code built at run time (eval / new Function)' });
  }
  for (const m of text.matchAll(P.onwardLiteral)) {
    add(ctx, { rule: 'valu.onward', result: 'fail', ...at(m.index), detail: onwardDetail(m[2]) });
  }
  for (const m of text.matchAll(P.storage)) {
    ctx.storage.push({ rule: 'storage.inventory', result: 'info', ...at(m.index),
      detail: `Keeps data on the device: ${m[1].replace(/\s+/g, '')}` });
  }
  // Last: any outside address the code names that no rule above explained —
  // an alias (`const f = fetch`), a config object (`{ url: '…' }`), a library
  // the rules do not know. The reviewer must say what each one is for.
  for (const m of text.matchAll(P.urlLiteral)) {
    const url = m[2];
    if (classify(ctx, url) !== 'outside' || HARMLESS_HOSTS.test(hostOf(url) ?? '')) continue;
    const where = at(m.index);
    if (ctx.findings.some((f) => f.file === where.file && f.line === where.line)) continue;
    add(ctx, { rule: 'egress.url-literal', result: 'concern', ...where, host: hostOf(url) ?? undefined,
      detail: `Names the outside address ${hostOf(url) ?? url}` });
  }
  if (inFunction) {
    for (const m of text.matchAll(P.denoConnect)) {
      add(ctx, { rule: 'server.egress', result: 'concern', ...at(m.index), detail: 'Opens a raw network connection from a server function' });
    }
    for (const m of text.matchAll(P.callValuApp)) {
      add(ctx, { rule: 'valu.onward', result: 'fail', ...at(m.index), detail: "Calls another app's API from a server function" });
    }
  }
}

function scanBuilt(ctx, file) {
  const path = String(file.path ?? '');
  const text = file.text;
  const starts = lineStarts(text);
  const at = (offset) => ({ file: path, line: lineOf(starts, offset), snippet: snippet(text, starts, offset) });
  if (CSS_FILE.test(path)) return scanCss(ctx, text, at);
  if (!CODE_FILE.test(path)) return;
  scanCalls(ctx, text, at, { inFunction: false, dynamic: false });
  if (/\.html?$/i.test(path)) scanTags(ctx, text, at);
  scanNavigation(ctx, text, at, { dynamic: false });
  for (const m of text.matchAll(P.webrtc)) {
    add(ctx, { rule: 'egress.webrtc', result: 'fail', ...at(m.index), detail: 'The built app opens a peer-to-peer connection' });
  }
}

function scanCalls(ctx, text, at, { inFunction, dynamic }) {
  const external = inFunction ? 'server.egress' : 'egress.external-url';
  const check = (url, offset, what) => {
    const verdict = classify(ctx, url);
    if (verdict === 'onward') {
      add(ctx, { rule: 'valu.onward', result: 'fail', ...at(offset), detail: onwardDetail(url) });
    } else if (verdict === 'outside') {
      add(ctx, { rule: external, result: 'fail', ...at(offset), host: hostOf(url) ?? undefined,
        detail: `${what} to ${hostOf(url) ?? url}` });
    } else if (verdict === 'dynamic' && dynamic) {
      add(ctx, { rule: 'egress.dynamic', result: 'concern', ...at(offset),
        detail: `${what} to an address built at run time` });
    }
  };
  for (const m of text.matchAll(P.call)) check(m[3], m.index, callName(m[1]));
  for (const m of text.matchAll(P.ctor)) check(m[3], m.index, `new ${m[1]}`);
  for (const m of text.matchAll(P.xhrOpen)) check(m[2], m.index, 'XMLHttpRequest');
  for (const m of text.matchAll(P.lib)) check(m[3], m.index, `Sends a request (${m[1]})`);
  for (const m of text.matchAll(P.dynImport)) check(m[2], m.index, 'import()');
  for (const m of text.matchAll(P.staticImport)) check(m[2], m.index, 'Imports code');
  for (const m of text.matchAll(P.srcAssign)) check(m[2], m.index, 'Loads a resource');
  if (!dynamic) return;
  for (const m of text.matchAll(P.callAny)) {
    add(ctx, { rule: 'egress.dynamic', result: 'concern', ...at(m.index), detail: `${callName(m[1])} to an address held in a variable` });
  }
  for (const m of text.matchAll(P.ctorAny)) {
    add(ctx, { rule: 'egress.dynamic', result: 'concern', ...at(m.index), detail: `new ${m[1]} to an address held in a variable` });
  }
  for (const m of text.matchAll(P.xhrOpenAny)) {
    add(ctx, { rule: 'egress.dynamic', result: 'concern', ...at(m.index), detail: 'XMLHttpRequest to an address held in a variable' });
  }
}

function scanNavigation(ctx, text, at, { dynamic }) {
  const check = (url, offset, concatenated) => {
    if (classify(ctx, url) !== 'outside') return;
    const carries = concatenated || /[?#][^'"`]*\$\{/.test(url) || /\$\{/.test(url.split(/[?#]/)[0] ?? '');
    add(ctx, {
      rule: 'egress.navigation', result: carries ? 'fail' : 'info', ...at(offset), host: hostOf(url) ?? undefined,
      detail: carries ? `Navigates to ${hostOf(url) ?? url} with data in the address` : `Links to ${hostOf(url) ?? url}`,
    });
  };
  for (const m of text.matchAll(P.navCall)) check(m[2], m.index, Boolean(m[3]));
  for (const m of text.matchAll(P.navAssign)) check(m[2], m.index, Boolean(m[3]));
  for (const m of text.matchAll(P.anchor)) check(m[2], m.index, Boolean(m[3]));
  for (const m of text.matchAll(P.setAttr)) {
    const attr = m[2];
    const url = m[4];
    if (attr === 'href') {
      check(url, m.index, Boolean(m[5]));
    } else if (attr === 'action') {
      if (classify(ctx, url) === 'outside') {
        add(ctx, { rule: 'egress.navigation', result: 'fail', ...at(m.index), host: hostOf(url) ?? undefined,
          detail: `A form sends its fields to ${hostOf(url) ?? url}` });
      }
    } else if (classify(ctx, url) === 'outside') {
      add(ctx, { rule: 'egress.external-url', result: 'fail', ...at(m.index), host: hostOf(url) ?? undefined,
        detail: `Loads a resource from ${hostOf(url) ?? url}` });
    }
  }
  for (const m of text.matchAll(P.form)) {
    if (classify(ctx, m[2]) === 'outside') {
      add(ctx, { rule: 'egress.navigation', result: 'fail', ...at(m.index), host: hostOf(m[2]) ?? undefined,
        detail: `A form sends its fields to ${hostOf(m[2]) ?? m[2]}` });
    }
  }
  if (!dynamic) return;
  for (const m of text.matchAll(P.navAny)) {
    add(ctx, { rule: 'egress.dynamic', result: 'concern', ...at(m.index), detail: 'Navigates to an address held in a variable' });
  }
}

function scanTags(ctx, text, at) {
  for (const m of text.matchAll(P.tagSrc)) {
    const url = m[3] ?? m[4] ?? '';
    if (classify(ctx, url) !== 'outside') continue;
    const tag = m[1].toLowerCase();
    add(ctx, {
      rule: tag === 'script' ? 'egress.third-party-script' : 'egress.external-url', result: 'fail', ...at(m.index),
      host: hostOf(url) ?? undefined,
      detail: tag === 'script' ? `Loads a script from ${hostOf(url)}` : `Loads <${tag}> from ${hostOf(url)}`,
    });
  }
  for (const m of text.matchAll(P.link)) {
    const tag = m[0];
    const href = /\bhref\s*=\s*\{?\s*(['"`])([^'"`\n]*)\1/i.exec(tag)?.[2];
    if (!href || classify(ctx, href) !== 'outside') continue;
    const rel = (/\brel\s*=\s*(['"])([^'"]*)\1/i.exec(tag)?.[2] ?? '').toLowerCase();
    const host = hostOf(href) ?? undefined;
    if (/\b(dns-prefetch|preconnect|prefetch|prerender)\b/.test(rel)) {
      add(ctx, { rule: 'egress.prefetch', result: 'fail', ...at(m.index), host, detail: `Prefetches ${host}` });
    } else if (/\b(stylesheet|modulepreload|preload)\b/.test(rel)) {
      add(ctx, { rule: 'egress.third-party-script', result: 'fail', ...at(m.index), host, detail: `Loads ${rel} from ${host}` });
    } else {
      add(ctx, { rule: 'egress.external-url', result: 'fail', ...at(m.index), host, detail: `Loads <link rel="${rel}"> from ${host}` });
    }
  }
  scanCss(ctx, text, at);
}

function scanCss(ctx, text, at) {
  for (const m of text.matchAll(P.cssUrl)) {
    if (classify(ctx, m[2]) !== 'outside') continue;
    add(ctx, { rule: 'egress.external-url', result: 'fail', ...at(m.index), host: hostOf(m[2]) ?? undefined,
      detail: `Styles load from ${hostOf(m[2])}` });
  }
}

/**
 * `onward` for Valu's pass-it-on paths, `outside` for a literal address that is
 * not Valu, `dynamic` when the address is decided at run time, else `inside`.
 */
function classify(ctx, url) {
  const text = String(url ?? '');
  if (ONWARD_PATHS.some((p) => text.includes(p))) return 'onward';
  if (text.startsWith('${')) {
    // `${import.meta.env.VITE_X}/path`: the variable decides where it goes.
    return 'dynamic';
  }
  const absolute = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text);
  // Relative paths are the site itself; mailto: / tel: hand over to the person's own apps.
  if (!absolute) return 'inside';
  const base = text.replace(/\$\{[^}]*\}.*$/, '');
  if (!hostOf(base)) return 'dynamic';
  const extras = ctx.opts.extraOrigins ?? [];
  if (extras.some((origin) => safeOrigin(origin) && safeOrigin(base) === safeOrigin(origin))) return 'inside';
  return isValuUrl(base, { siteOrigin: ctx.opts.siteOrigin }) ? 'inside' : 'outside';
}

function onwardDetail(url) {
  if (url.includes('/api/apps/v1/')) return "Calls another app's API through the Valu gateway";
  const provider = /\/proxy\/([a-z0-9-]+)/i.exec(url)?.[1];
  return `Sends data to ${provider ? `the ${provider} AI provider` : 'an outside provider'} through the Valu gateway`;
}

function dependencies(packageJson) {
  const out = { runtime: {}, all: {} };
  if (typeof packageJson !== 'string') return out;
  try {
    const data = JSON.parse(packageJson);
    out.runtime = { ...(data?.dependencies ?? {}) };
    out.all = { ...(data?.devDependencies ?? {}), ...(data?.dependencies ?? {}) };
  } catch {
    // a broken package.json names nothing
  }
  return out;
}

function telemetry(deps, lockfile) {
  const matches = (name) => TELEMETRY_PACKAGES.some((p) => (p.endsWith('/') ? name.startsWith(p) : name === p));
  const found = new Map();
  for (const name of Object.keys(deps.all)) if (matches(name)) found.set(name, 'package.json');
  if (typeof lockfile === 'string') {
    let lock = null;
    try {
      lock = JSON.parse(lockfile);
    } catch {
      lock = null;
    }
    if (lock && typeof lock === 'object') {
      for (const key of Object.keys(lock.packages ?? {})) {
        const name = key.replace(/^.*node_modules\//, '');
        if (name && matches(name) && !found.has(name)) found.set(name, 'package-lock.json');
      }
    } else {
      // yarn.lock / pnpm-lock.yaml: package names appear as `name@…` or `/name@…` keys.
      for (const m of lockfile.matchAll(/(?:^|[\s"'/])((?:@[\w.-]+\/)?[\w.-]+)@[\w^~*<>=.:-]/gm)) {
        const name = m[1];
        if (matches(name) && !found.has(name)) found.set(name, 'lockfile');
      }
    }
  }
  return [...found].map(([name, from]) => ({ name, from }));
}

function add(ctx, finding) {
  const key = `${finding.rule}|${finding.file}|${finding.line}|${finding.host ?? ''}|${finding.line ? '' : finding.detail}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  if (finding.host === undefined) delete finding.host;
  ctx.findings.push(finding);
}

function callName(name) {
  if (name === 'sendBeacon') return 'Sends a beacon';
  if (name === 'importScripts') return 'Loads a script';
  return 'Sends a request';
}

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

function snippet(text, starts, offset) {
  const line = lineOf(starts, offset);
  const from = starts[line - 1];
  const to = line < starts.length ? starts[line] - 1 : text.length;
  const whole = text.slice(from, to).trim();
  if (whole.length <= SNIPPET_MAX) return whole;
  // A minified line is one long line: keep the part around the match.
  const at = Math.max(0, offset - from - 40);
  return text.slice(from + at, from + at + SNIPPET_MAX).trim();
}

function safeOrigin(value) {
  try {
    return new URL(String(value).startsWith('//') ? `https:${value}` : value).origin;
  } catch {
    return null;
  }
}
