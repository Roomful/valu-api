import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_REPLACEMENTS, bridgeReplacement } from '../../src/bridge/replacements.js';
import { SERVICE_DESCRIPTORS, INTENT_DESCRIPTORS } from '../../src/services/descriptors.js';

/** True when the package has a function `valu.<service>.<method>`. */
function hasFunction(service, method) {
  if (service === 'Apps' && ['open', 'send', 'list', 'has', 'isLoaded'].includes(method)) return true;
  return [...SERVICE_DESCRIPTORS, ...INTENT_DESCRIPTORS].some((d) => d.service === service && d.method === method);
}

test('pointer calls map to typed functions, aliases included', () => {
  assert.equal(bridgeReplacement('pointer-run', 'users.current'), 'valu.Users.current()');
  assert.equal(bridgeReplacement('pointer-run', 'app.isApplicationLoaded'), 'valu.Apps.isLoaded(applicationId)');
  assert.equal(bridgeReplacement('pointer-run', 'app.getApplications'), 'valu.Apps.list()');
  assert.equal(bridgeReplacement('pointer-run', 'app.open'), 'valu.Apps.open(appId)');
  assert.equal(bridgeReplacement('pointer-run', 'app.close'), null);
  assert.equal(bridgeReplacement('pointer-run', 'app.getApplicationHeader'), null);
  assert.equal(bridgeReplacement('pointer-run', 'u.current'), 'valu.Users.current()'); // alias 'u'
});

test('console, intents, routes, direct', () => {
  assert.equal(bridgeReplacement('run-console', 'users.current'), 'valu.Users.current()');
  assert.equal(bridgeReplacement('run-intent', 'textchat.open-channel'), 'valu.Chats.openChannel({...})');
  assert.equal(bridgeReplacement('service-intent-other', 'textchat.open-channel'), 'valu.Chats.openChannel({...})');
  assert.equal(bridgeReplacement('run-command', 'pushRoute'), 'valu.route.push(path)');
  assert.equal(bridgeReplacement('run-command', 'replaceRoute'), 'valu.route.replace(path)');
  assert.equal(bridgeReplacement('direct', 'api:ready'), 'createValuApp()');
  assert.equal(bridgeReplacement('run-intent', 'nope.nothing'), null);
  assert.equal(bridgeReplacement('run-intent', 'toString'), null);
});

test('every valu.* value names a function the package has', () => {
  for (const [key, value] of Object.entries(BRIDGE_REPLACEMENTS)) {
    if (key.startsWith('direct ') || value.startsWith('valu.route.')) continue;
    const m = /^valu\.(\w+)\.(\w+)\(/.exec(value);
    assert.ok(m, `${key}: ${value}`);
    assert.ok(hasFunction(m[1], m[2]), `${key}: ${value} has no function`);
  }
});

test('the table is frozen', () => {
  assert.ok(Object.isFrozen(BRIDGE_REPLACEMENTS));
});
