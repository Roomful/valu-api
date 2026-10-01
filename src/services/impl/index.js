// ===========================================================================
// Every implemented function, in one registry.
//
// The 65 service functions — 54 on the Roomful socket, 3 app-state and 8
// local. Sixty-four come from the application's manifest; the sixty-fifth is
// declared by this package (scripts/extensions.js).
//
// Every one of them is a function the Roomful connection answers, or that the
// SDK answers without one. Declared intents the Valu Social application serves
// itself — window management, pickers, and everything the Valu Guru server
// answers on its own socket — are not in the catalogue at all, so there is
// nothing here to leave out (scripts/bindings.js).
//
// Importing this module registers into the DEFAULT registry, which is what a
// SocketTransport uses unless it is given its own. `registerAll(registry)`
// fills any registry — which is how a test builds one with a subset.
// ===========================================================================
import { serviceRegistry } from '../registry.js';

import { register as users } from './Users.js';
import { register as rooms } from './Rooms.js';
import { register as community } from './Community.js';
import { register as events } from './Events.js';
import { register as groups } from './Groups.js';
import { register as networks } from './Networks.js';
import { register as textChat } from './TextChat.js';
import { register as cbac } from './Cbac.js';
import { register as profile } from './Profile.js';
import { register as resources } from './Resources.js';
import { register as cms } from './CMS.js';
import { register as applicationStorage } from './ApplicationStorage.js';
import { register as developer } from './Developer.js';
import { register as verusWallet } from './VerusWallet.js';
import { register as http } from './Http.js';
import { register as time } from './Time.js';

/** Registration order is alphabetical; nothing depends on it. */
const REGISTRARS = [
  applicationStorage, cbac, cms, community, developer, events,
  groups, http, networks, profile, resources, rooms, textChat, time, users, verusWallet,
];

/**
 * Fill a registry with every implemented function.
 * @param {import('../registry.js').ServiceRegistry} [registry]
 */
export function registerAll(registry = serviceRegistry) {
  for (const register of REGISTRARS) register(registry);
  return registry;
}

registerAll();

export { serviceRegistry };
