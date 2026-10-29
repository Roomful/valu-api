// ===========================================================================
// BridgeScopes: the scope of every message of Valu Social's older bridge, and
// null — a refusal — for everything the inventory of 2026-10-29 found an app
// must never reach.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_SCOPES, scopeOfApiCommand, scopeOfAppIntent, scopeOfServiceIntent,
} from '../../src/host/BridgeScopes.js';
import { TIER_OF } from '../../src/host/Permissions.js';
import { SCOPE_DESCRIPTIONS } from '../../src/host/scopeWording.js';

test('a service intent that is a catalogue function has the function\'s scope', () => {
  assert.equal(scopeOfServiceIntent('Rooms', 'search-my-rooms'), 'rooms:read');
  assert.equal(scopeOfServiceIntent('TextChat', 'send-message'), 'textchat:write');
  assert.equal(scopeOfServiceIntent('VerusWallet', 'transfer'), 'veruswallet:write');
});

test('the host\'s own intents keep their scopes, and the bridge\'s own table fills the rest', () => {
  assert.equal(scopeOfServiceIntent('Commerce', 'get-cart'), 'commerce:read');
  assert.equal(scopeOfServiceIntent('Application', 'get-identity-token'), 'application:identity');
  assert.equal(scopeOfServiceIntent('Commerce', 'publish-product'), 'commerce:sell');
  assert.equal(scopeOfServiceIntent('RoomZones', 'claim-zone'), 'rooms:write');
  assert.equal(scopeOfServiceIntent('DataProvider', 'pick-single'), 'ui:open');
});

test('what an app must never reach through a service intent has no scope', () => {
  for (const [service, action] of [
    ['UnityDialog', 'open'], ['Logging', 'get-logs'], ['AiGuru', 'get-chat-history'], ['WebSocket', 'send'],
    ['Rooms', 'no-such-thing'], [null, 'x'], ['Rooms', 7],
  ]) assert.equal(scopeOfServiceIntent(service, action), null, `${service}.${action}`);
});

test('application intents: opening any app is ui:open; acting for the user has its scope; anything else is refused', () => {
  assert.equal(scopeOfAppIntent('textchat'), 'ui:open');
  assert.equal(scopeOfAppIntent('anything', 'open'), 'ui:open');
  assert.equal(scopeOfAppIntent('textchat', 'open-channel'), 'ui:open');
  assert.equal(scopeOfAppIntent('textchat', 'send-message'), 'textchat:write');
  assert.equal(scopeOfAppIntent('videochat', 'connect-to-meeting'), 'videochat:write');
  assert.equal(scopeOfAppIntent('cart', 'add-to-cart'), 'commerce:write');
  assert.equal(scopeOfAppIntent('hubs', 'agent-say'), 'hubs:write');
  assert.equal(scopeOfAppIntent('auth', 'logout'), null);
  assert.equal(scopeOfAppIntent('textchat', 'made-up'), null);
  assert.equal(scopeOfAppIntent('', 'open'), null);
});

test('a request to another framed app is apps:intent, whatever it asks', () => {
  assert.equal(scopeOfAppIntent('my-other-app', 'do-thing', { toFrame: true }), 'apps:intent');
  assert.equal(scopeOfAppIntent('my-other-app', undefined, { toFrame: true }), 'ui:open');
});

test('API pointer commands, by name, alias or the camelCase the bridge falls back to', () => {
  assert.equal(scopeOfApiCommand('users', 'getMany'), 'users:read');
  assert.equal(scopeOfApiCommand('u', 'get-many'), 'users:read');
  assert.equal(scopeOfApiCommand('users', 'follow'), 'users:write');
  assert.equal(scopeOfApiCommand('rooms', 'get-full-model'), 'rooms:read');
  assert.equal(scopeOfApiCommand('chat', 'getChannel'), 'textchat:read');
  assert.equal(scopeOfApiCommand('network', 'switch'), 'networks:write');
  assert.equal(scopeOfApiCommand('app', 'edit-room-point'), 'rooms:write');
});

test('the session, the encryption seed, sign-out, any modal, any setting and the native shell have no scope', () => {
  for (const [api, command] of [
    ['network', 'startNewNetworkSession'], ['network', 'overrideNetworkSwitch'], ['crypto', 'setSeed'],
    ['text-chat', 'cryptoClearScope'], ['text-chat', 'crypto'], ['auth', 'logout'], ['dialog', 'open'], ['d', 'close'],
    ['app', 'getSetting'], ['app', 'overriderAppLoading'], ['app', 'overriderPopupLoading'],
    ['app', 'blockExternalLinks'], ['app', 'notifyApplicationStateUpdated'], ['app', 'configure-intent'],
    ['app', 'run'], ['users', 'searchPeople'], ['nope', 'x'], ['users', ''],
  ]) assert.equal(scopeOfApiCommand(api, command), null, `${api}.${command}`);
});

test('every scope the bridge answers has a tier and a sentence', () => {
  for (const scope of BRIDGE_SCOPES) {
    assert.ok(Object.hasOwn(TIER_OF, scope), `${scope} has a tier`);
    assert.equal(typeof SCOPE_DESCRIPTIONS[scope], 'string', `${scope} has a sentence`);
  }
});
