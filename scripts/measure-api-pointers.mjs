// ===========================================================================
// Measure the vendored API-pointer inventory against a real app checkout.
//
//   node scripts/measure-api-pointers.mjs
//   node scripts/measure-api-pointers.mjs --app ../valusocial-web
//
// docs/api-pointers.md is generated from scripts/apiPointers.js, which is a
// VENDORED copy of a surface that lives in another repository — so the doc can
// build without that repository, and so it can silently stop being true. This
// is what stops it: every module, alias and function name in the inventory is
// re-read out of the app's own source, and anything that does not line up is
// printed and exits non-zero.
//
// It reads declarations, not behaviour: `createAPi`, `registerAlias` and
// `registerFunction` are the three calls APIBridge offers, so what they name is
// what `getApi(...).run(...)` can reach. Nothing is written.
// ===========================================================================
import { readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

import { API_POINTER_MODULES, DUPLICATE_DECLARATIONS, pointerSummary } from './apiPointers.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

const appRepo = resolve(arg('--app', '../valusocial-web'));

const head = (repo) => {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return '(not a git checkout)'; }
};

/**
 * Every file in the app that declares a pointer API. Found by the call itself
 * rather than from a list, so a NEW module is measured without editing this.
 */
const declaringFiles = () => {
  const out = execFileSync(
    'grep',
    ['-rl', '--include=*.js', 'createAPi(', 'src'],
    { cwd: appRepo, encoding: 'utf8' },
  );
  return out.trim().split('\n').filter((f) => f && !f.endsWith('APIBridge.js'));
};

const files = declaringFiles();
const sources = new Map(files.map((f) => [f, readFileSync(join(appRepo, f), 'utf8')]));

/**
 * Every `NAME = 'literal'` in the declaring files, so a constant can be
 * resolved across them: UnityDialogApi's own name is
 * `ModalDialogsAPI.DIALOGS_API_NAME`, which is a literal in a different file.
 */
const constants = new Map();
for (const src of sources.values()) {
  for (const m of src.matchAll(/(\w+)\s*=\s*['"]([^'"]+)['"]/g)) {
    if (!constants.has(m[1])) constants.set(m[1], m[2]);
  }
}

/**
 * `UXAPI.UX_API_NAME` → 'ux'. A literal is itself.
 *
 * The declaring file wins over the cross-file map, and it has to: AuthApi
 * carries a leftover `static USERS_API_NAME = 'auth'`, so a global lookup of
 * that name answers the wrong module.
 */
const resolveName = (expression, src) => {
  const text = expression.trim();
  if (text.startsWith("'") || text.startsWith('"')) return text.slice(1, -1);
  const constant = text.split('.').pop();
  const here = new RegExp(`${constant}\\s*=\\s*['"]([^'"]+)['"]`).exec(src);
  if (here) return here[1];
  // One hop to another file: `static DIALOG_API_NAME = ModalDialogsAPI.DIALOGS_API_NAME`.
  const hop = new RegExp(`${constant}\\s*=\\s*([\\w.]+)\\s*;`).exec(src);
  const target = hop ? hop[1].split('.').pop() : constant;
  return constants.get(target) ?? `(unresolved: ${text})`;
};

const live = [];
for (const [file, src] of sources) {
  for (const m of src.matchAll(/createAPi\(([^)]*)\)/g)) {
    live.push({
      file,
      module: resolveName(m[1], src),
      aliases: [...src.matchAll(/registerAlias\([^,]+,\s*['"]([^'"]+)['"]/g)].map((a) => a[1]),
      functions: [...src.matchAll(/registerFunction\([^,]+,\s*(\d+),\s*['"]([^'"]+)['"]/g)]
        .map((f) => ({ fn: f[2], version: Number(f[1]) })),
    });
  }
}

// --- report ----------------------------------------------------------------
const summary = pointerSummary();
const line = (label, value) => console.log(`${label.padEnd(46)} ${value}`);
const problems = [];

console.log(`\n# API pointers measured against the app\n`);
console.log(`  valu-api        ${head(resolve('.'))}`);
console.log(`  valusocial-web  ${head(appRepo)}  (${relative(process.cwd(), appRepo) || appRepo})`);

console.log(`\n## Declarations\n`);
line('modules declared in the app', live.length);
line('modules in the vendored inventory', summary.modules + DUPLICATE_DECLARATIONS.length);
line('functions declared in the app', live.reduce((n, m) => n + m.functions.length, 0));
line('function registrations vendored', summary.declarations);

const vendored = new Map();
for (const m of API_POINTER_MODULES) vendored.set(m.file, m);
for (const d of DUPLICATE_DECLARATIONS) {
  vendored.set(d.file, { ...d, functions: d.functions.map((fn) => ({ fn })) });
}

console.log(`\n## Per declaration\n`);
for (const m of live) {
  const expected = vendored.get(m.file);
  if (!expected) {
    problems.push(`NEW: ${m.file} declares \`${m.module}\` (${m.functions.length} functions) and is not vendored`);
    console.log(`  ${m.file}\n    NEW — not in the inventory`);
    continue;
  }
  const liveFns = m.functions.map((f) => f.fn).sort();
  const vendoredFns = expected.functions.map((f) => f.fn).sort();
  const added = liveFns.filter((f) => !vendoredFns.includes(f));
  const dropped = vendoredFns.filter((f) => !liveFns.includes(f));
  const badName = m.module !== expected.module;
  const aliasesAdded = m.aliases.filter((a) => !(expected.aliases ?? []).includes(a));
  const aliasesDropped = (expected.aliases ?? []).filter((a) => !m.aliases.includes(a));
  const versions = [...new Set(m.functions.map((f) => f.version))];

  const status = badName || added.length || dropped.length || aliasesAdded.length || aliasesDropped.length
    ? 'DRIFT' : 'ok';
  console.log(`  ${expected.module.padEnd(12)} ${status.padEnd(6)} ${liveFns.length} function${liveFns.length === 1 ? '' : 's'}, `
    + `version${versions.length === 1 ? ` ${versions[0]}` : `s ${versions.join('/')}`}  (${m.file})`);
  if (badName) problems.push(`${m.file}: declares \`${m.module}\`, inventory says \`${expected.module}\``);
  if (added.length) problems.push(`${expected.module}: new functions ${added.join(', ')}`);
  if (dropped.length) problems.push(`${expected.module}: gone functions ${dropped.join(', ')}`);
  if (aliasesAdded.length) problems.push(`${expected.module}: new aliases ${aliasesAdded.join(', ')}`);
  if (aliasesDropped.length) problems.push(`${expected.module}: gone aliases ${aliasesDropped.join(', ')}`);
  // Versioning is a claim docs/api-pointers.md makes out loud.
  if (versions.some((v) => v !== 1)) problems.push(`${expected.module}: registers a version other than 1 (${versions.join('/')})`);
}
for (const [file, m] of vendored) {
  if (!live.some((l) => l.file === file)) problems.push(`GONE: ${file} no longer declares \`${m.module}\``);
}

console.log(`\n## Coverage of the pointer surface by declared functions\n`);
line('pointer functions', summary.functions);
line('  … a declared function does the same work', summary.same);
line('  … a declared function is close, not equal', summary.close);
line('  … pointer-only', summary.only);

console.log();
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} discrepancy(ies) — update scripts/apiPointers.js, then \`npm run build\`.\n`);
  process.exit(1);
}
console.log('No drift: docs/api-pointers.md still describes this checkout.\n');
