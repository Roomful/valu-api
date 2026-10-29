// ===========================================================================
// One plain sentence for every scope.
//
// The consent window asks about consent-tier scopes only, so it needs
// `SCOPE_WORDING` and nothing else. The Developer Portal shows an app's WHOLE
// permission list — basic, local and forbidden scopes too — and a reviewer
// should read every line in the same voice the person signing in would. So the
// other tiers get their sentences here, beside the consent ones, and
// `SCOPE_DESCRIPTIONS` is the two together: one sentence per `TIER_OF` key (a
// test holds it to that). No DOM, no imports beyond the tier table: it loads
// in Node and in any bundle.
// ===========================================================================
import { TIER_OF } from './Permissions.js';

/**
 * What the dialog says for each scope that needs the user's consent: one plain
 * sentence, completing "This app is asking to be allowed to:". There is one for
 * every consent-tier scope in `Permissions.TIER_OF` (a test holds them to it).
 * Each says the strongest thing its scope allows, as the catalogue's functions
 * for it do (the agent's own messages, access levels the app chooses, invitations
 * to other people), and promises nothing beyond that.
 *
 * The Commerce sentences use the words Valu Social's own Commerce dialogs use
 * for the same things (`intents/consent.js` and `sellerConsent.js` there say
 * what a write WILL do, but have no per-scope sentence to copy): the cart,
 * orders and purchases on the buying side; the store, products, sales,
 * volume discounts and discount codes on the selling side.
 */
export const SCOPE_WORDING = Object.freeze({
  'users:write': 'Send, accept, decline and cancel connection requests for you.',
  'rooms:read': 'See your rooms and what is in them, and search for other rooms.',
  'rooms:write': 'Create rooms from templates, invite people to your props with whatever access level the app chooses, remove them again, and add or change content in your props.',
  'textchat:read': 'Read the message history of your chat channels.',
  'textchat:write': 'Send chat messages to any user as you, and have this app\'s agent message you directly.',
  'groups:read': 'See your groups and who is in them, and find groups you could join.',
  'groups:write': 'Join groups for you.',
  'events:read': 'See your events and meetings.',
  'events:write': 'Create and change meetings in your calendar, and invite other people to them.',
  'community:read': 'Read communities, their channels and their posts.',
  'cbac:read': 'See badges and the access rules built on them, and find people who hold a badge.',
  'cms:read': 'Search the files in your content library.',
  'cms:write': 'Add files to your content library and delete files from it.',
  'commerce:read': 'See products, your cart, your orders and your purchases, and be told when they change.',
  'commerce:write': 'Add things to your cart, and change, remove or clear the items in your cart.',
  'commerce:sell': 'Sell in your name: set up your store, create and change your products and their prices, read your sales and analytics, end sales, delete unused discount codes and remove volume discounts, and ask to sell in a network.',
});

/**
 * The tiers the consent window never asks about, in the same voice: what any
 * signed-in person allows without being asked (basic), what only works inside
 * Valu Social (local), and what no app is ever allowed (forbidden — said as
 * what it WOULD do, because that is what a reviewer must weigh).
 */
const OTHER_TIERS = {
  'users:read': 'See who you are, and look up other people by name or id.',
  'networks:read': 'See which network you are in.',
  'time:read': 'Read your local time and time zone.',
  'resources:read': 'Make links and thumbnails for pictures and files it can already see.',
  'profile:read': 'See the badges and credentials on people\'s profiles.',
  'applicationstorage:read': 'Read the files this app has stored for itself.',
  'applicationstorage:write': 'Store files for itself, and delete the files it stored.',
  'application:identity': 'Get a signed token that proves to its own server who you are.',
  'http:read': 'Fetch web pages and data from other sites through Valu Social.',
  'http:write': 'Send data to other sites through Valu Social.',
  'veruswallet:read': 'See the balance of your Verus wallet.',
  'veruswallet:write': 'Send money from your Verus wallet.',
  'cbac:write': 'Create and delete the badge-based access rules of your network.',
  'developer:read': 'List the applications you develop.',
  'developer:write': 'Create applications in your name.',
};

/** One sentence for every scope in `TIER_OF`: the consent wording, and the rest. */
export const SCOPE_DESCRIPTIONS = Object.freeze(Object.fromEntries(
  Object.keys(TIER_OF).map((scope) => [scope, SCOPE_WORDING[scope] ?? OTHER_TIERS[scope]]),
));

/**
 * The sentence for one scope.
 * @param {string} scope
 * @returns {string|null} `null` for a scope this version of valu-api does not know
 */
export function describeScope(scope) {
  return typeof scope === 'string' && Object.hasOwn(SCOPE_DESCRIPTIONS, scope)
    ? SCOPE_DESCRIPTIONS[scope]
    : null;
}
