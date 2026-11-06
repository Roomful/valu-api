// What an app that installed the package writes. `npm run typecheck` compiles
// it with strict, without skipLibCheck, against the declarations as published:
// a declaration that does not resolve for a consumer (and so collapses a type
// to `any`) fails here, where `skipLibCheck` would have hidden it.
//
// `@ts-expect-error` is how "this is not `any`" is said: a type that had
// collapsed would accept the line, and the unused directive is the error.
import {
  connectValuServices,
  createFrameServer,
  createValuApp,
  type FrameServer,
  type ValuApiReadyInfo,
  type ValuAck,
  type ValuApp,
  type ValuAppConnectionState,
  type ValuAppErrorCode,
  type ValuAuthReason,
  type ValuConnectionChange,
} from '@arkeytyp/valu-api';
// The frame server by path is the same function, typed.
import { createFrameServer as frameServerByPath } from '@arkeytyp/valu-api/src/embed/FrameServer.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// The app's connection state is its own union; the socket's is another one.
type _StateIsTheAppsUnion = Expect<
  Equal<ValuAppConnectionState, 'connecting' | 'ready' | 'reconnecting' | 'offline' | 'signed_out'>
>;

// The reasons and codes the host can give: `timeout` is a sign-in reason; `bad_origin` is gone.
const timedOut: ValuAuthReason = 'timeout';
// @ts-expect-error the host no longer says `bad_origin`
const noSuchCode: ValuAppErrorCode = 'bad_origin';
void timedOut;
void noSuchCode;

export async function run(): Promise<void> {
  const valu: ValuApp = await createValuApp();

  // `ValuApp` is the typed tree, not `any` (the services import resolves).
  // @ts-expect-error not a member of the app
  valu.notAMember;
  // @ts-expect-error not a service
  valu.NotAService.current();
  // @ts-expect-error not a function of the service
  valu.Users.notAFunction();
  // @ts-expect-error an app is not a number
  const notANumber: number = valu;
  void notANumber;

  // The connection state narrows.
  const state: ValuAppConnectionState = valu.connection.state;
  if (valu.connection.state === 'signed_out') {
    await valu.auth.signIn();
  }
  valu.connection.on('change', (change: ValuConnectionChange) => {
    const next: ValuAppConnectionState = change.state;
    void next;
  });
  // @ts-expect-error `idle` is a state of the socket connection, not of the app
  const notAState: ValuAppConnectionState = 'idle';
  void notAState;

  // The ack of a call carries what a refusal carries.
  const ack: ValuAck = await valu.Users.current();
  const scope: string | undefined = ack.error?.scope;
  const retryable: boolean | undefined = ack.error?.retryable;
  if (ack.error?.message === 'consent_required' && scope) {
    await valu.auth.requestConsent([scope]);
  }

  // A function of the tree is typed: its ack has `data`, and the unwrapped tree gives the payload.
  const current = await valu.Users.current();
  void current.data;
  const me = await valu.data.Users.current();
  void me;

  // By name, for a caller that holds a string.
  const byName: ValuAck<{ rooms: unknown[] }> = await valu.call('Rooms.searchMyRooms', { filter: 'all' }, { timeoutMs: 5_000 });
  void byName.data?.rooms;
  const payload: { rooms: unknown[] } = await valu.invoke('Rooms.searchMyRooms', { filter: 'all' });
  void payload;
  const tools = valu.toolDefinitions({ service: 'Rooms' });
  void tools[0]?.function.name;

  // Typed app intents: an app's intents on its title's namespace, or folded onto a service.
  const opened: ValuAck = await valu.Chats.openChannel({ userId: 'u-2', route: '/thread' });
  await valu.Rooms.showRoom({ roomId: 'r-1' });
  await valu.data.MyCart.openCart();
  // @ts-expect-error open-channel takes no such param
  await valu.Chats.openChannel({ usr: 'u-2' });
  // valu.Apps: the reads take an app id in order or as params; open and send take the caller's app.
  await valu.Apps.isLoaded('textchat');
  await valu.Apps.isLoaded({ applicationId: 'textchat' });
  await valu.Apps.list();
  await valu.Apps.open('events', { route: '/week' });
  await valu.Apps.send('ws-other-app', 'refresh', { full: true });
  // @ts-expect-error an app id is a string
  await valu.Apps.open(42);
  // The app's own route.
  const moved: ValuAck = await valu.route.push('/inbox');
  await valu.route.replace('/inbox');
  const stop: () => void = valu.onRoute((route) => { void route; });
  stop();
  void opened; void moved;

  void state;
  void retryable;
}

// The embedded app pins where the parent speaks from, and how long it waits for it.
export const embedded = createValuApp({ mode: 'embedded', hostOrigins: ['https://live.valuverse.io'], readyTimeoutMs: 5_000 });
// @ts-expect-error a duration is a number
export const badTimeout = createValuApp({ readyTimeoutMs: '5s' });

// Valu Social's half: the frame server over its own connection.
export async function valuSocial(webSocketService: { emitAsync(endpoint: string, data?: object, timeout?: number): Promise<any> }): Promise<void> {
  // One per framed app: its slug, and no cache.
  const services = await connectValuServices({ socket: webSocketService, userId: 'u1', applicationId: 'my-app', cache: null });
  const frames: FrameServer = createFrameServer({ services, log: (level, message) => { void level; void message; } });
  const info: ValuApiReadyInfo = frames.readyInfo({ user: { id: 'u1', name: 'Ada' }, network: null });
  const calls: boolean = info.calls;
  const userId: string | undefined = info.user?.id;
  const ack: ValuAck = await frames.handle({ service: 'Users', action: 'current', params: {}, requestId: 1, timeoutMs: 30_000 });
  void calls; void userId; void ack.error?.code;
  // Typed app intents: the intents runner, with the frame's own Application looked up per call.
  const withIntents = createFrameServer({
    services,
    intents: async (target, id, action, params) => ({ target, id, action, params }),
    toFrame: (appId) => appId.startsWith('ws'),
  });
  const intents: true | undefined = withIntents.readyInfo().intents;
  const served: boolean = withIntents.intents;
  void intents; void served;
  // An intents-only server: no services.
  createFrameServer({ intents: async () => ({}) });
  // @ts-expect-error intents is a function
  createFrameServer({ services, intents: 'run' });
  // @ts-expect-error the services need a call()
  createFrameServer({ services: {} });
  // @ts-expect-error an app state is an object of capabilities
  createFrameServer({ services, appState: 'state' });
  const samePath: typeof createFrameServer = frameServerByPath;
  void samePath;
}
