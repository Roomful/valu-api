// ===========================================================================
// Prop grouping and distribution — pure logic, no I/O.
//
// Vendored from valusocial-web/src/Applications/RoomsApplication/Services/
// propGroups.js, unchanged in behaviour. It is pure by design there, which is
// why it moves here intact: Rooms.js feeds it the navigation-ordered props
// `get-room-props` produces, and talks to the socket for the pastes.
//
// A PROP GROUP is the set of props whose normalized tag sets are IDENTICAL,
// and its id is those tags sorted and joined with "+". Deterministic and
// stateless, so a caller can carry an id from `get-room-prop-groups` into
// `paste-resources-into-prop-group` and the paste re-derives the groups
// instead of the caller remembering them.
// ===========================================================================

const GROUP_ID_SEPARATOR = '+';
const GROUP_LABEL_SEPARATOR = ' / ';

/** @returns {string} lowercase, trimmed, inner whitespace collapsed to "-"; '' for nothing. */
export const normalizePropTag = tag => {
  if (tag === null || tag === undefined) return '';
  return String(tag).trim().toLowerCase().replace(/\s+/g, '-');
};

/** @returns {string[]} normalized tags, deduped, empties dropped, sorted. */
export const normalizePropTags = tags => {
  const list = Array.isArray(tags) ? tags : [];
  return [...new Set(list.map(normalizePropTag).filter(Boolean))].sort();
};

/** @returns {string|null} the group id for a tag list — sorted normalized tags joined with "+" — or null when there are no tags. */
export const propGroupId = tags => {
  const normalized = normalizePropTags(tags);
  return normalized.length ? normalized.join(GROUP_ID_SEPARATOR) : null;
};

// ---------------------------------------------------------------------------
// A prop's DISPLAY NAME — what the prop shows, and therefore the label on its
// entity tag.
//
// A CONTENT prop carries no title of its own by design: the paste clears it
// (#finishPastedProp) and renamePropGroup retitles the section's SIGN, not the
// frames — because Unity captions a frame with its FIRST resource. So
// `title || assetTitle || id` labelled a freshly filled frame with its raw
// propId, and a whole room's worth of those reached a user
// (chat session_1789559123430_9fjc, 2026-09-16).
//
// Read-only: the name is DERIVED on every read, never written back to the prop.
// This is the one owner of the rule — PropsDataSource.getPropDisplayName (the
// CMS tree) and the server's valu-tools/rooms.ts mirror it.
// ---------------------------------------------------------------------------
/**
 * @param {object} prop A raw room:listProps prop, or an enriched one.
 * @returns {string} title → first USER resource's title → asset catalog name → id.
 */
export const propDisplayName = prop => {
  const title = String(prop?.title ?? '').trim();
  if (title) return title;

  // A room copied from a template keeps the template's placeholder resources
  // until the first paste removes them (`fromTemplate` on the resource, the
  // same flag #pasteIntoLoadedProp strips by and `hadUserContent` reads). They
  // are NOT what the frame is about — naming an untouched frame
  // "slide-bg-04.jpg" reads like a real name, so it would be relayed as a link
  // label AND, being no id echo, would outrank the real post-paste name in the
  // AI server's entity ledger (isIdLabel, entity-harvest.ts). An empty frame
  // must keep falling through to its asset name, or to the id that tells the
  // model "this frame is empty".
  const content = Array.isArray(prop?.content) ? prop.content : [];
  const resourceTitle = String(content.find(r => r && !r.fromTemplate)?.title ?? '').trim();
  if (resourceTitle) return resourceTitle;

  return String(prop?.assetTitle ?? '').trim() || String(prop?.id ?? '');
};

// A prop can take pasted content when it has a content type and is not a
// presentation (screen-share) board. null board status (asset lookup failed)
// fails open — the backend still owns the final word, exactly like the guard
// in RoomsService.pasteResourcesIntoProp.
export const propAcceptsContent = prop =>
  Boolean(prop?.type?.length) && prop?.isPresentationBoard !== true;

// A LOGO group (tags include "logo") shows EVERY logo on EVERY frame: the
// paste tool replicates there instead of spreading (RoomsService resolves the
// default), and the tool output flags it so the model can say so.
const LOGO_TAG = 'logo';

/** @returns {boolean} true when the (raw or normalized) tags include "logo". */
export const isLogoGroup = tags => normalizePropTags(tags).includes(LOGO_TAG);

const navRank = navIndex => (Number.isInteger(navIndex) ? navIndex : Number.POSITIVE_INFINITY);

// ---------------------------------------------------------------------------
// Section SIGNS (label props). Rooms often carry a Text prop per section that
// shows the section's name — Unity's RoomfulText renders the prop's `title`.
// A prop is a sign when its ASSET says it is a Text prop (`isTextProp`, from
// an asset tag containing "text" — the same mechanism that marks presentation
// boards) or, failing that, when it is a DECORATIVE prop (no content type)
// carrying an author-set title. It belongs to its group by carrying the
// group's tags — exactly like the frames. A sign without tags is an untagged
// prop and is skipped like any other.
// ---------------------------------------------------------------------------
/** @returns {boolean} true for a Text prop (by asset) or a titled decorative prop. */
export const isSectionSign = prop =>
  prop?.isTextProp === true || (!prop?.type?.length && Boolean(String(prop?.title ?? '').trim()));

const sectionSigns = props => props
  .filter(isSectionSign)
  .map(p => ({propId: p.id, text: String(p.title ?? '').trim()}));

// By first position in the room's walk (null last); ties by id so the order
// is stable across calls.
const compareGroups = (a, b) => {
  const ra = navRank(a.navIndex);
  const rb = navRank(b.navIndex);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
};

/**
 * Groups navigation-ordered props by their whole normalized tag set.
 *
 * @param {object[]} props Enriched props in navigation order (getRoomProps output).
 * @returns {Array<{id: string, tags: string[], label: string, isLogoGroup: boolean,
 *   navIndex: number|null, propCount: number, eligiblePropCount: number,
 *   totalContentCount: number, labels: Array<{propId: string, text: string}>,
 *   props: object[]}>} Tagged groups in navigation order (untagged props are
 *   skipped); each member prop carries `groupId` and `acceptsContent`;
 *   `labels` are the group's section signs.
 */
export const groupProps = props => {
  const byId = new Map();

  for (const prop of Array.isArray(props) ? props : []) {
    const tags = normalizePropTags(prop.tags);
    if (!tags.length) continue; // untagged: in no group, skipped by design
    const id = tags.join(GROUP_ID_SEPARATOR);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        tags,
        label: tags.join(GROUP_LABEL_SEPARATOR),
        isLogoGroup: tags.includes(LOGO_TAG),
        props: [],
      });
    }
    byId.get(id).props.push({...prop, groupId: id, acceptsContent: propAcceptsContent(prop)});
  }

  return [...byId.values()]
    .map(group => {
      const navIndexes = group.props.map(p => p.navIndex).filter(Number.isInteger);
      return {
        id: group.id,
        tags: group.tags,
        label: group.label,
        isLogoGroup: group.isLogoGroup,
        navIndex: navIndexes.length ? Math.min(...navIndexes) : null,
        propCount: group.props.length,
        eligiblePropCount: group.props.filter(p => p.acceptsContent).length,
        totalContentCount: group.props.reduce((sum, p) => sum + (p.contentCount || 0), 0),
        labels: sectionSigns(group.props),
        props: group.props,
      };
    })
    .sort(compareGroups);
};

// Fields a group member keeps in the TOOL output (order matters: identity,
// what it is, what it can take, what it holds, where it sits, how to link it).
// Dropped on purpose: roomId / networkId (once at the top level), groupId and
// tags (the enclosing group says so), assetId (nothing the model can do with it).
const TOOL_PROP_FIELDS = [
  'id', 'name', 'assetTitle', 'type', 'thumbnailCount', 'logoCount', 'invokeType',
  'isPresentationBoard', 'acceptsContent', 'contentCount', 'navIndex', 'tag',
];

const compactPropForTool = prop =>
  Object.fromEntries(TOOL_PROP_FIELDS.map(key => [key, prop[key]]));

/**
 * The view of a group that goes to the AI. A template room carries dozens of
 * purely decorative props (labels, plants, walls) with no content type; listing
 * them buried the real frames — in one debug run 55 of 56 untagged props were
 * decorative and the model reported "no logo group" although it was first in
 * the list. So: only props that CAN hold content are listed (presentation
 * boards included, flagged, so the model knows they exist), decorative props
 * are counted in `propCount` / `decorativePropCount` but not listed, and every
 * listed prop is trimmed to TOOL_PROP_FIELDS. The full group (groupProps
 * output) is left untouched for the paste path.
 *
 * @param {object} group A groupProps() group.
 * @returns {object} Compact group for tool output.
 */
export const groupForToolOutput = group => {
  const listable = group.props.filter(p => Boolean(p.type?.length));
  return {
    id: group.id,
    tags: group.tags,
    label: group.label,
    isLogoGroup: group.isLogoGroup,
    navIndex: group.navIndex,
    propCount: group.propCount,
    eligiblePropCount: group.eligiblePropCount,
    decorativePropCount: group.props.length - listable.length,
    totalContentCount: group.totalContentCount,
    labels: group.labels,
    props: listable.map(compactPropForTool),
  };
};

// A room template names how many prop groups its room has with a tag —
// canonical form "prop-groups_5"; "prop-groups-5", "propgroups5",
// "5-prop-groups" and the bare "groups-5" / "5-groups" spellings are read too.
// The AI picks a template by matching this number to the user's content
// sections, so it must never have to parse tags itself.
const GROUP_COUNT_TAG = /^(?:(?:prop[-_\s]?)?groups?[-_:\s]?(\d+)|(\d+)[-_\s]?(?:prop[-_\s]?)?groups?)$/i;

/** @returns {number|null} the group count a template's tags declare, or null when none does. */
export const templateGroupCount = tags => {
  for (const tag of Array.isArray(tags) ? tags : []) {
    const match = GROUP_COUNT_TAG.exec(String(tag ?? '').trim());
    if (match) return Number(match[1] ?? match[2]);
  }
  return null;
};

/**
 * Plans which prop gets which resources.
 *
 * "spread" (default): contiguous, order-preserving shares over the first
 * min(M, N) props — M resources over N props gives floor(M/N) each with the
 * first M mod N props taking one extra (7 over 3 -> 3/2/2); fewer resources
 * than props leaves the trailing props untouched. Round-robin would shuffle
 * the story, so it is deliberately not offered.
 * "stack": everything onto the first prop as one slideshow.
 * "replicate": EVERY resource onto EVERY prop (a logo group — each logo frame
 * shows all the logos).
 *
 * @param {object[]} pool Eligible props, already in the desired order.
 * @param {string[]} resourceIds Resource ids in display order.
 * @param {'spread'|'stack'|'replicate'} [distribution='spread']
 * @returns {Array<{prop: object, resourceIds: string[]}>}
 */
export const planDistribution = (pool, resourceIds, distribution = 'spread') => {
  if (!Array.isArray(pool) || !pool.length || !Array.isArray(resourceIds) || !resourceIds.length) return [];
  if (distribution === 'stack') return [{prop: pool[0], resourceIds: [...resourceIds]}];
  if (distribution === 'replicate') return pool.map(prop => ({prop, resourceIds: [...resourceIds]}));

  const slots = Math.min(pool.length, resourceIds.length);
  const base = Math.floor(resourceIds.length / slots);
  const remainder = resourceIds.length % slots;

  const placements = [];
  let cursor = 0;
  for (let i = 0; i < slots; i++) {
    const size = base + (i < remainder ? 1 : 0);
    placements.push({prop: pool[i], resourceIds: resourceIds.slice(cursor, cursor + size)});
    cursor += size;
  }
  return placements;
};
