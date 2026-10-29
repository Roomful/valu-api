#!/usr/bin/env node
// ===========================================================================
// valu-privacy-scan <dir> [--site-origin <origin>] [--extra-origin <origin>]...
//
// Repeats the deterministic half of Valu's privacy audit on a folder and prints
// the result as JSON — the same `detectEgress` answer the Workspaces publish
// records (docs/privacy-audit.md). With the app's repository at an audit's
// commit and this package at that audit's scanner version, the output matches
// the audit's `egress-scan` findings for the source.
//
// What it reads:
//   source      the tracked files (`git ls-files`) in a git checkout, else every
//               file outside node_modules / .git / dist; ≤ 1 MB each
//   built       everything under dist/
//   package.json, package-lock.json, db/migrations/*.sql
// ===========================================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { detectEgress } from '../src/scan/detectEgress.js';

const SOURCE_EXT = /\.(?:[cm]?js|jsx|ts|tsx|vue|svelte|html?|css)$/i;
const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('usage: valu-privacy-scan <dir> [--site-origin <origin>] [--extra-origin <origin>]...\n');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { dir: null, siteOrigin: undefined, extraOrigins: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--site-origin') out.siteOrigin = argv[++i];
    else if (arg === '--extra-origin') out.extraOrigins.push(argv[++i]);
    else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else if (!out.dir) out.dir = arg;
    else usage(`unexpected argument ${arg}`);
  }
  if (!out.dir) usage();
  return out;
}

function listTracked(dir) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function read(dir, rel) {
  const full = path.join(dir, rel);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
const dir = path.resolve(args.dir);
if (!fs.existsSync(dir)) usage(`no such folder: ${args.dir}`);

const files = listTracked(dir) ?? walk(dir);
const source = files
  .filter((rel) => SOURCE_EXT.test(rel) && !rel.split('/').some((part) => SKIP_DIRS.has(part)))
  .map((rel) => ({ path: rel, text: read(dir, rel) }))
  .filter((file) => file.text !== null);
const migrations = files
  .filter((rel) => /^db\/migrations\/[^/]+\.sql$/.test(rel))
  .map((rel) => ({ path: rel, text: read(dir, rel) }));
const distDir = path.join(dir, 'dist');
const built = fs.existsSync(distDir)
  ? walk(distDir).map((rel) => ({ path: `dist/${rel}`, text: read(distDir, rel) }))
  : [];

const result = detectEgress(
  {
    source,
    built,
    packageJson: read(dir, 'package.json'),
    lockfile: fs.existsSync(path.join(dir, 'package-lock.json'))
      ? fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')
      : null,
    migrations,
  },
  { siteOrigin: args.siteOrigin, extraOrigins: args.extraOrigins },
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
