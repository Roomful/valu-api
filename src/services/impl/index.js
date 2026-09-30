// ===========================================================================
// Every implemented function, in one registry.
//
// Phase 1 shipped the registry empty and an unimplemented declared function
// answered 501 naming itself. This is what fills it: the 77 SDK-able functions
// of the parity matrix — 69 socket (53 roomful, 11 valuguru, 5 app-state) and
// 8 local. The 15 postMessage-bound intents are NOT here; they are frame commands
// (src/frame/FrameCommands.js), which is Phase 2d's whole point.
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
import { register as commerce } from './Commerce.js';
import { register as aiGuru } from './AiGuru.js';
import { register as developer } from './Developer.js';
import { register as verusWallet } from './VerusWallet.js';
import { register as http } from './Http.js';
import { register as time } from './Time.js';

/** Registration order is alphabetical; nothing depends on it. */
const REGISTRARS = [
  aiGuru, applicationStorage, cbac, cms, commerce, community, developer, events,
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
