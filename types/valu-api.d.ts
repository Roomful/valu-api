declare module '@arkeytyp/valu-api' {
    // The generated per-function types live next door. They are a MODULE (they
    // import this one), so they are imported rather than merged — that is what
    // lets `valu.Users.current()` be typed without generating anything into
    // this hand-written file. The import names the package path: inside an
    // ambient `declare module` a relative path does not resolve, and a consumer
    // would get `ValuServices` (and so `ValuApp`) as `any`.
    import type { ValuServices, ValuServicesData } from '@arkeytyp/valu-api/types/valu-services';

    export type { ValuServices, ValuServicesData };

    export class ValuApi {
        static API_READY: string;
        static ON_ROUTE : string;
        /**
         * A Commerce event the app subscribed to with the
         * `Commerce.subscribe-events` service intent. Listeners receive a
         * {@link CommerceEvent}.
         */
        static ON_COMMERCE: string;

        /**
         * @param options Defaults to the postMessage bridge — the connection an
         *  iframe application has to the Valu Social application around it.
         *
         *  Service functions are NOT on this object: they run over a socket,
         *  from anywhere, and `createValuServices({ socket })` is how you get
         *  them (docs/socket-functions.md), or over the host of a dedicated
         *  app, which `createValuApp()` sets up (docs/connecting.md).
         */
        constructor(options?: { transport?: Transport });

        get connected(): boolean;

        /** The transport this instance speaks over. */
        get transport(): Transport;

        /**
         * Registers an application instance to handle lifecycle events.
         * @param appInstance An instance of a class extending ValuApplication.
         */
        setApplication(appInstance: ValuApplication): void;

        /**
         * Sends an intent to another Valu application and returns the response.
         * @param intent The Intent object containing the target application ID, action, and parameters.
         * @returns A promise resolving to the response from the target application.
         */
        sendIntent(intent: Intent): Promise<any>;
        callService(intent: Intent): Promise<any>;

        addEventListener(event: string, callback: (data: any) => void): void;
        removeEventListener(event: string, callback: (data: any) => void): void;
        getApi(apiName: string, version?: number): Promise<APIPointer>;
        runConsoleCommand(command: string): Promise<any | string>;

        /**
         * Pushes a new route onto the navigation stack.
         *
         * Use this when:
         *   navigating forward
         *   opening a new view
         *   preserving back-navigation history
         * @param path
         */
        pushRoute(path: string): void;

        /**
         * Replaces the current route without adding a new history entry.
         * Use this when:
         *    redirecting
         *    normalizing URLs
         *    preventing back-navigation to the previous route
         * @param {string }path
         */
        replaceRoute(path: string): void;
    }

    export class APIPointer {
        get guid(): string;
        get apiName(): string;
        get version(): number;

        addEventListener(event: string, callback: (data: any) => void): void;
        removeEventListener(event: string, callback: (data: any) => void): void;
        run(functionName: string, params?: any): Promise<any>;
    }

    export type IntentParams = Record<string, any>;

    export class Intent {
        // Predefined actions
        static ACTION_VIEW: string;
        static ACTION_OPEN: string;

        // Fields
        private readonly _applicationId: string;
        private readonly _action: string;
        private readonly _params: IntentParams;

        /**
         * @param applicationId The ID of the application this intent targets.
         * @param action The action to perform (defaults to 'open').
         * @param params Optional parameters for the action.
         */
        constructor(applicationId: string, action?: string, params?: IntentParams);

        /** Application ID this intent targets */
        get applicationId(): string;

        /** Action this intent performs */
        get action(): string;

        /** Additional parameters for this intent */
        get params(): IntentParams;

        /**
         * Validates if a given object is a valid Intent instance.
         * @param obj Any object to validate.
         * @returns True if the object is a valid Intent instance.
         */
        static isValid(obj: any): boolean;

        /**
         * Returns a stringified representation of the intent.
         */
        toString(): string;
    }

    /**
     * Abstract base class for Valu iframe applications.
     *
     * Developers should extend this class to implement application-specific logic
     * for handling lifecycle events within the Valu Social ecosystem.
     *
     * The Valu API will automatically call these lifecycle methods when the Valu Social
     * application sends corresponding events (e.g., app launch, new intent, destroy).
     */
    export class ValuApplication {
        /**
         * Called when the app is first launched with an Intent.
         *
         * @param intent - The Intent that triggered the app launch.
         * @returns A value or a Promise resolving to a value that will be sent back to the caller.
         */
        onCreate(intent: Intent): Promise<any> | any;

        /**
         * Called when the app receives an Intent while already running (docked).
         *
         * @param intent - The incoming Intent.
         * @returns A value or a Promise resolving to a value that will be sent back to whoever triggered the Intent.
         */
        onNewIntent(intent: Intent): Promise<any> | any;

        /**
         * Called when the app is about to be destroyed.
         *
         * Use this to clean up resources (e.g., closing connections, clearing timers).
         */
        onDestroy(): void;

        /**
         * Called when the application’s router context changes.
         *
         * This typically happens when:
         *  the app moves between main / side / modal containers
         *  Valu Social updates routing or layout state
         * @param context - updated application route
         */
        onUpdateRouterContext(context: string): void;

        /**
         * Called with a Commerce event the app subscribed to, after the
         * `ValuApi.ON_COMMERCE` listeners. Subscribe with the
         * `Commerce.subscribe-events` service intent; nothing arrives otherwise.
         *
         * Optional on an app that does not extend this class.
         * @param event - what changed, never the new state: re-read with the matching intent
         */
        onCommerceEvent(event: CommerceEvent): void;
    }

    /**
     * The Commerce event names the platform posts today. The Valu Social
     * application's manifest is the authority (`Commerce.subscribe-events`),
     * so any other string is accepted too: a name added after this package was
     * published still arrives, it just does not autocomplete.
     */
    export type CommerceEventName =
        | 'cart-updated'
        | 'order-updated'
        | 'delivery-updated'
        | 'catalogue-updated'
        | 'seller-product-updated'
        | 'seller-store-updated'
        | 'seller-promotions-updated';

    /**
     * What an `ON_COMMERCE` listener and `onCommerceEvent` receive: the event
     * name and its fields, as the host posted them — e.g.
     * `{event: 'cart-updated', count}`, `{event: 'order-updated', orderId, status}`,
     * `{event: 'catalogue-updated', productId, change}` (`productId: null` = re-read the shelf).
     */
    export interface CommerceEvent {
        event: CommerceEventName | (string & {});
        [field: string]: any;
    }
    // ---------------------------------------------------------------------
    // The SDK surface (Phase 1). See docs/callbacks-policy.md for the
    // contract every service function is written against, and
    // types/valu-services.d.ts for the generated per-function types.
    // ---------------------------------------------------------------------

    /** Ack envelope returned by every Valu call: `{data}` or `{error}`. */
    export interface ValuAck<T = any> {
        data?: T;
        error?: {
            status?: boolean;
            code?: number;
            /**
             * What the host's refusals name themselves with (dedicated mode):
             * `sign_in_required` (401); `not_a_member` (401: the user's last sign-in was
             * refused because they are not a member of the app's network, and it stays the
             * answer until the next sign-in attempt starts); `forbidden` and
             * `consent_required` (403); `not_available` (501); `busy` (429); `timeout` (408).
             */
            message?: string;
            description?: string;
            /**
             * The scope a refusal is about. Present on a `403` `consent_required`
             * answer of the host (dedicated mode): the scope the user has not given
             * this app yet. Pass it to `auth.requestConsent([scope])`.
             */
            scope?: string;
            /**
             * `false` when repeating the call is not safe: a call that WRITES and
             * was cut off (`503`) or ran out of time (`408`) after it was handed to
             * the host may have been applied. The app decides whether to repeat it.
             * Absent when the call is safe to repeat (it never ran, or it only reads).
             */
            retryable?: boolean;
        };
    }

    /** The minimal socket surface every networked function depends on. */
    export interface ValuSocket {
        readonly userId: string;
        readonly networkId: string;
        readonly selfUserId: string | null;
        emit(ns: string, data?: Record<string, unknown>, timeoutMs?: number): Promise<ValuAck>;
        onResourceUpdated?(handler: (data: any) => void): () => void;
        readonly underlying?: ValuSocket;
    }

    export const ERROR_CODES: {
        INVALID_PARAMS: 400;
        FORBIDDEN: 403;
        UNKNOWN_FUNCTION: 404;
        TIMEOUT: 408;
        UNSUPPORTED: 501;
        DISCONNECTED: 503;
    };

    export class ValuServiceError extends Error {
        code?: number;
        description?: string;
        service?: string;
        fn?: string;
        ack?: ValuAck;
    }

    export function isAckError(ack?: ValuAck): boolean;
    export function ackErrorMessage(ack?: ValuAck, fallback?: string): string;
    export function unwrapAck<T = any>(ack: ValuAck<T>, context?: { service?: string; fn?: string; fallback?: string }): T;
    export function normalizeAck(ack?: ValuAck): ValuAck;
    export function dataAck<T>(data: T): ValuAck<T>;
    export function errorAck(code?: number, message?: string, description?: string): ValuAck;

    /** What carries a call: the postMessage bridge, a socket, or the host. A
     * socket transport and the host transport serve service functions; the
     * bare postMessage bridge does not. */
    export abstract class Transport {
        static READY: string;
        static TRIGGER: string;
        static NEW_INTENT: string;
        static RECONNECTED: string;
        static RESOURCE_UPDATED: string;

        get connected(): boolean;
        /** Whether this transport can run service functions. `SocketTransport`
         * and `HostTransport` can; `PostMessageTransport` cannot, and
         * `ServiceClient` refuses a transport that does not. */
        get servesServiceFunctions(): boolean;
        get name(): string;
        open(): Promise<void>;
        request(name: string, message: object, requestId?: number): Promise<any>;
        notify(name: string, message: object): void;
        callService(descriptor: ServiceDescriptor, params?: object, options?: { timeoutMs?: number; attempt?: number }): Promise<ValuAck>;
        subscribe(event: string, handler: (data: any) => void): () => void;
        addEventListener(event: string, handler: (data: any) => void): void;
        removeEventListener(event: string, handler: (data: any) => void): void;
        close(): Promise<void>;
    }

    /** The postMessage bridge to the Valu Social application — today's traffic,
     * unchanged. */
    export class PostMessageTransport extends Transport {
        constructor(options?: {
            target?: EventTarget;
            /** Origins the first `api:ready` may come from. No default. The peer
             * is bound once, to `window.parent` when embedded, and later
             * messages are taken only from it. */
            hostOrigins?: string[];
        });
        get applicationId(): string | undefined;
    }

    /**
     * The page's side of the host bridge in dedicated mode: a hidden iframe on
     * the host origin, the `host:hello` handshake, and the one transport besides
     * `SocketTransport` that serves service functions (each call is an
     * `api:call` the host checks the grants of). `createValuApp` builds it; make
     * one yourself only to share it. See docs/connecting.md, "Dedicated mode".
     *
     * Events (`subscribe`): `Transport.READY` once, with the `api:ready`
     * message; `Transport.TRIGGER` for every host push, `{action, data}`;
     * `Transport.RECONNECTED` after a reconnect the host reports.
     */
    export class HostTransport extends Transport {
        constructor(options: {
            /** Where the host is served: a bare origin, `https://valuguru.texpo.io`. */
            hostOrigin: string;
            /** The app's address, `<workspace>/<slug>`, sent in `host:hello`: dev hosts only. */
            app?: string;
            window?: Window;
            document?: Document;
            /** How long the handshake waits for `api:ready`. Default 10 000. */
            readyTimeoutMs?: number;
            /** Between a pong (or the start) and the next `host:ping`. Default 15 000. */
            pingIntervalMs?: number;
            /** How long a ping waits for its pong before the host counts as dead. Default 10 000. */
            pingTimeoutMs?: number;
            /** Runs the `local` functions. Default: a `SocketTransport` with no socket. */
            localTransport?: Transport;
            fetchImpl?: typeof fetch;
            config?: Partial<ValuConfig>;
            setTimeout?: (fn: () => void, ms: number) => unknown;
            clearTimeout?: (id: any) => void;
        });
        /** Inject the host iframe and shake hands. Rejects with `code` `host_unreachable`
         * or the host's own (`unknown_app`, `nested`, `protocol_unsupported`,
         * `resolve_unavailable`). */
        open(): Promise<void>;
        get applicationId(): string | null;
        /** What the host last said of the user and itself; `null` before the handshake. */
        get hostState(): HostState | null;
        /** What `api:ready` named (`connecting` while a stored session is still being
         * confirmed; from a host that names none, what `signedIn` implies), then every
         * `connection` push. */
        get connectionState(): ValuAppConnectionState;
    }

    /** What `api:ready` and the `auth` pushes say of the user. */
    export interface HostState {
        signedIn: boolean;
        user: ValuUser | null;
        network: ValuNetwork | null;
        protocol: number;
        mode: string;
    }

    /** Declared functions over a ValuSocket. Does not speak the bridge. */
    export class SocketTransport extends Transport {
        constructor(options: {
            /** `null` for a transport that serves only the `local` functions. */
            socket: ValuSocket | null;
            /** For the 3 `app-state` functions. */
            appState?: AppState;
            fetchImpl?: typeof fetch;
            config?: Partial<ValuConfig>;
            now?: () => Date;
            /** The calling application — ApplicationStorage and CMS need it. */
            applicationId?: string | null;
            registry?: ServiceRegistry;
        });
        get socket(): ValuSocket | null;
        get appState(): AppState | null;
        get config(): ValuConfig;
        get applicationId(): string | null;
        /** Which channels this transport can actually serve. */
        get channels(): Record<string, boolean>;
        /** False means the transport cannot push — the consumer must poll. */
        get supportsPush(): boolean;
        /** Swap in a re-opened socket: re-attaches push, drops stale caches. */
        handleReconnect(socket?: ValuSocket): void;
    }

    /** The app's WebSocket service, as a ValuSocket. */
    export class BrowserSocketAdapter implements ValuSocket {
        constructor(options: {
            socket: { emitAsync(endpoint: string, data?: object, timeout?: number): Promise<any> };
            userId: string;
            networkId?: string;
            selfUserId?: string | null;
            onResourceUpdated?(handler: (data: any) => void): () => void;
        });
        readonly userId: string;
        readonly networkId: string;
        readonly selfUserId: string | null;
        emit(ns: string, data?: Record<string, unknown>, timeoutMs?: number): Promise<ValuAck>;
    }

    /** RoomfulConnectionManager, as a ValuSocket. */
    export class NodeSocketAdapter implements ValuSocket {
        constructor(options: { connection: ValuSocket | { emit: Function; userId?: string }; networkId?: string });
        readonly userId: string;
        readonly networkId: string;
        readonly selfUserId: string | null;
        readonly underlying: ValuSocket;
        emit(ns: string, data?: Record<string, unknown>, timeoutMs?: number): Promise<ValuAck>;
    }

    // ---------------------------------------------------------------------
    // Getting a socket — the two doors. See docs/connecting.md.
    // ---------------------------------------------------------------------

    /** A socket.io client socket, in the little this package needs of one. */
    export interface SocketIoLike {
        emit(event: string, ...args: any[]): any;
        on(event: string, handler: (...args: any[]) => void): any;
        off?(event: string, handler: (...args: any[]) => void): any;
        removeListener?(event: string, handler: (...args: any[]) => void): any;
        removeAllListeners?(): any;
        connect?(): any;
        close?(): any;
        disconnect?(): any;
        readonly connected?: boolean;
    }

    /** The brand: a socket this package built carries it, and is never re-wrapped. */
    export const VALU_SOCKET: symbol;
    export function isValuSocket(value: unknown): boolean;

    /** A socket.io socket somebody else opened and authorized, as a ValuSocket. */
    export class SocketIoSocketAdapter implements ValuSocket {
        constructor(options: {
            socket: SocketIoLike;
            userId?: string;
            networkId?: string;
            selfUserId?: string | null;
            timeoutMs?: number;
        });
        readonly userId: string;
        readonly networkId: string;
        readonly selfUserId: string | null;
        /** The socket.io socket, for consumers keying per-connection state. */
        readonly transport: SocketIoLike;
        emit(ns: string, data?: Record<string, unknown>, timeoutMs?: number): Promise<ValuAck>;
        onResourceUpdated(handler: (data: any) => void): () => void;
    }

    export type ValuConnectionState =
        'idle' | 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed';

    export interface ValuUserInfo {
        selfUserId: string | null;
        networkId: string | null;
        user: Record<string, unknown> | null;
        network: Record<string, unknown> | null;
    }

    export interface ValuSocketConnectionOptions {
        /** The user's Roomful session id. First-party runtimes only — see
         * docs/connecting.md and docs/authorization.md. */
        sessionId: string;
        host?: string;
        /** The socket.io-client factory. Pass it: socket.io is not a dependency. */
        io?: Function;
        fetchImpl?: typeof fetch;
        /** Run the init.client bootstrap. Default: true when a fetch exists. */
        bootstrap?: boolean;
        userId?: string;
        networkId?: string;
        /** Merged over SOCKET_IO_OPTIONS. */
        socketOptions?: Record<string, unknown>;
        timeoutMs?: number;
        readyTimeoutMs?: number;
        recoveryTimeoutMs?: number;
        onConnectionLost?(reason: string): void;
    }

    /** A Roomful socket this package opens from a session id and authorizes. */
    export class ValuSocketConnection implements ValuSocket {
        constructor(options: ValuSocketConnectionOptions);
        /** Opens, authorizes, and resolves on the platform's `user_info` push.
         * The one call here that rejects — there is no ack to fail into. */
        connect(): Promise<ValuSocketConnection>;
        readonly userId: string;
        readonly networkId: string;
        readonly selfUserId: string | null;
        readonly state: ValuConnectionState;
        readonly connected: boolean;
        readonly connectedAt: number | null;
        readonly host: string;
        readonly user: Record<string, unknown> | null;
        readonly network: Record<string, unknown> | null;
        readonly displayName: string | null;
        readonly transport: SocketIoLike | null;
        emit(ns: string, data?: Record<string, unknown>, timeoutMs?: number): Promise<ValuAck>;
        onResourceUpdated(handler: (data: any) => void): () => void;
        /** After a drop that re-authorized. */
        onReconnected(handler: (info: { selfUserId: string | null; networkId: string }) => void): () => void;
        onConnectionLost(handler: (reason: string) => void): () => void;
        /** Any platform push, forwarded exactly as it arrived. */
        on(event: string, handler: (payload: any) => void): () => void;
        close(): Promise<void>;
        /** Safe to print: never the session id. */
        describe(): {
            host: string;
            state: ValuConnectionState;
            networkId: string;
            userId: string;
            selfUserId: string | null;
            connectedAt: number | null;
            connectErrors: number;
            lastError: string | null;
            session: string;
        };
    }

    export const DEFAULT_API_HOST: string;
    export const READY_TIMEOUT_MS: number;
    export const RECOVERY_TIMEOUT_MS: number;
    export const ROOMFUL_SOCKET_PATH: '/socket';
    export const SOCKET_IO_OPTIONS: Readonly<Record<string, unknown>>;
    export function isSocketIoSocket(value: unknown): boolean;
    export function loadSocketIo(injected?: Function | { default: Function }): Promise<Function>;
    export function emitOverSocketIo(
        socket: SocketIoLike,
        ns: string,
        data?: Record<string, unknown>,
        timeoutMs?: number,
    ): Promise<ValuAck>;
    export function readUserInfo(payload: any): ValuUserInfo;
    export function displayNameOf(user: Record<string, any> | null): string | null;

    /** Options for adapting a connection that is already authorized. */
    export interface AdoptSocketOptions {
        userId?: string;
        networkId?: string;
        selfUserId?: string | null;
        onResourceUpdated?(handler: (data: any) => void): () => void;
        timeoutMs?: number;
    }

    /** Make a ValuSocket out of whatever authorized connection you hold. */
    export function adoptValuSocket(input: unknown, options?: AdoptSocketOptions): ValuSocket;

    /** A ValuSocket by either door: adopt `socket`, or open one from `sessionId`. */
    export function openValuSocket(
        options: ({ socket: unknown } & AdoptSocketOptions)
            | ValuSocketConnectionOptions,
    ): Promise<ValuSocket>;

    /**
     * WHICH connection answers a function — the only axis, and the one a caller
     * has to satisfy. There is no 'postmessage': this package declares nothing
     * it cannot run itself over a connection.
     */
    export type ServiceChannel = 'roomful' | 'app-state' | 'local';
    export type CacheMode = 'none' | 'read-through' | 'seeded';

    export interface DescriptorParam {
        name: string;
        type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'string[]' | 'object[]' | 'FileList';
        description: string;
        options?: string[];
    }

    /** One declared function: what it is, what it takes, and who may call it. */
    export interface ServiceDescriptor {
        key: string;
        service: string;
        action: string;
        fn: string;
        method: string;
        toolName: string;
        description: string;
        availability: string[];
        scopes: string[];
        channel: ServiceChannel;
        mutates: boolean;
        cache: { mode: CacheMode; ttlMs?: number; key?: string | null };
        returns: { type: string; description: string };
        params: { required: DescriptorParam[]; optional: DescriptorParam[] };
        /** Params this package added beyond the manifest's (scripts/extensions.js). */
        sdkParams: string[];
        /** Who says this function exists: the app's manifest, or this package. */
        declaredBy: 'manifest' | 'sdk';
        implementedBy: string | null;
    }

    export const SERVICE_DESCRIPTORS: readonly ServiceDescriptor[];
    export const SERVER_ONLY_TOOLS: readonly string[];
    /** The catalogue, under the name that says what it is. Same array. */
    export const SERVICE_FUNCTIONS: readonly ServiceDescriptor[];
    /**
     * Declared intents the Valu Social application serves and this package does
     * not — names, not descriptors, because there is no function for any of
     * them here. Ask for one by name over the bridge: `ValuApi.callService`.
     */
    export const APPLICATION_ONLY_INTENTS: readonly string[];
    /**
     * Why each of those is not a function here:
     * `'no-rpc'` — nothing but the application process can answer it;
     * `'valu-guru'` — the Valu Guru server answers it, on its own socket,
     * which this package does not hold;
     * `'not-ported'` — the Roomful socket answers it, and this package does
     * not implement it yet.
     */
    export const APPLICATION_INTENT_REASON: Readonly<Record<string, 'no-rpc' | 'valu-guru' | 'not-ported'>>;

    /** Resolve `Users.get`, `Users.getUser`, `Users.get_user` or the tool name. */
    export function findDescriptor(name: string): ServiceDescriptor | undefined;
    export interface DescriptorFilter {
        service?: string;
        channel?: ServiceChannel;
        declaredBy?: 'manifest' | 'sdk';
        availability?: string;
        mutates?: boolean;
    }
    export function listDescriptors(filter?: DescriptorFilter): ServiceDescriptor[];
    export function listServiceFunctions(filter?: DescriptorFilter): ServiceDescriptor[];
    export function isServiceFunction(name: string): boolean;
    export function listServices(): string[];
    export function catalogSummary(): {
        total: number; roomful: number; 'app-state': number;
        local: number; socket: number;
        implemented: number; declared: number; sdkDeclared: number;
        serviceFunctions: number; applicationOnly: number;
        remaining: number; serverOnly: number;
    };

    export function validateParams(descriptor: ServiceDescriptor, params?: object): { ok: boolean; errors: string[] };
    export function validationAck(descriptor: ServiceDescriptor, params?: object): ValuAck | null;

    export interface LlmToolDefinition {
        type: 'function';
        function: { name: string; description: string; parameters: Record<string, any> };
    }
    export function toolDefinition(descriptor: ServiceDescriptor): LlmToolDefinition;
    export function toolDefinitions(filter?: {
        service?: string; channel?: ServiceChannel; availability?: string | null; mutates?: boolean;
    }): LlmToolDefinition[];

    /** What a handler is given. Which fields it may rely on is its `channel`. */
    export interface ServiceCallContext {
        /** The Roomful socket. Always present. */
        socket: ValuSocket;
        /** State only the application's own process holds — needed by
         * `channel: 'app-state'`. */
        appState: AppState | null;
        /** `fetch`, for the local HTTP functions and the upload pipeline. */
        fetchImpl: typeof fetch | null;
        /** The origins the local resource-URL builders need. */
        config: ValuConfig;
        /** WHICH application is calling. The runtime stamps it; params never do. */
        applicationId: string | null;
        /** The clock, when one was injected. */
        now?: () => Date;
        descriptor: ServiceDescriptor;
        timeoutMs: number;
        attempt: number;
    }

    export type ServiceHandler = (
        params: Record<string, any>,
        ctx: ServiceCallContext,
    ) => Promise<ValuAck>;

    /** Fill a registry with every implemented function. */
    export function registerAll(registry?: ServiceRegistry): ServiceRegistry;

    /** Where a declared function's implementation is registered. */
    export class ServiceRegistry {
        define(name: string, handler: ServiceHandler): this;
        get(name: string): ServiceHandler | undefined;
        has(name: string): boolean;
        implemented(): string[];
        delete(name: string): boolean;
    }
    export const serviceRegistry: ServiceRegistry;

    export class ServiceCache {
        constructor(options?: { now?: () => number; maxEntries?: number });
        get size(): number;
        get(descriptor: ServiceDescriptor, params?: object): ValuAck | undefined;
        set(descriptor: ServiceDescriptor, params: object, ack: ValuAck): ValuAck;
        seed(descriptor: ServiceDescriptor, params: object, data: any, options?: { ttlMs?: number }): this;
        invalidateService(service: string): number;
        invalidateEntity(entityId: string): number;
        onResourceUpdated(payload: any): number;
        clear(): void;
    }

    /** One call path: validate, check scope, cache, transport, retry. */
    export class ServiceClient {
        constructor(options: {
            transport: Transport;
            cache?: ServiceCache | null;
            auth?: AuthProvider;
            hooks?: { sleep?: (ms: number) => Promise<void>; random?: () => number };
        });
        get transport(): Transport;
        get cache(): ServiceCache | null;
        /** Resolves the ack envelope. Never rejects. */
        call<T = any>(name: string, params?: object, options?: {
            timeoutMs?: number; retries?: number; bypassCache?: boolean;
        }): Promise<ValuAck<T>>;
        /** `call` unwrapped: returns data, throws ValuServiceError. */
        invoke<T = any>(name: string, params?: object, options?: {
            timeoutMs?: number; retries?: number; bypassCache?: boolean;
        }): Promise<T>;
        subscribe(event: 'resource:updated' | 'reconnected' | string, handler: (data: any) => void): () => void;
        seed(name: string, params: object, data: any, options?: { ttlMs?: number }): this;
        close(): Promise<void>;
    }

    /**
     * The service functions as functions: `valu.Users.current()`.
     *
     * The tree is `ValuServices` (generated, one method per function, each
     * answering an ack); `data` is the same tree unwrapped. Both run through
     * the one `ServiceClient` on `client`.
     */
    export type ValuServiceApi = ValuServices & {
        readonly client: ServiceClient;
        readonly transport: Transport;
        readonly cache: ServiceCache | null;
        /** The same functions, returning the payload and throwing on error. */
        readonly data: ValuServicesData;
        /** The socket every function here runs over — share this, do not open a
         * second one. */
        readonly socket: ValuSocket | null;
        /** The connection this API opened, or null when it adopted somebody
         * else's. Only `close()` cares, and only about the first case. */
        readonly connection: ValuSocketConnection | null;

        call<T = any>(name: string, params?: object, options?: {
            timeoutMs?: number; retries?: number; bypassCache?: boolean;
        }): Promise<ValuAck<T>>;
        invoke<T = any>(name: string, params?: object, options?: {
            timeoutMs?: number; retries?: number; bypassCache?: boolean;
        }): Promise<T>;
        subscribe(event: 'resource:updated' | 'reconnected' | string, handler: (data: any) => void): () => void;
        seed(name: string, params: object, data: any, options?: { ttlMs?: number }): ValuServiceApi;
        toolDefinitions(filter?: {
            service?: string; channel?: ServiceChannel; availability?: string | null; mutates?: boolean;
        }): LlmToolDefinition[];
        close(): Promise<void>;
    };

    export const ValuServiceApi: {
        new (options: { client: ServiceClient; connection?: { close(): unknown } }): ValuServiceApi;
        functions(): ServiceDescriptor[];
        services(): string[];
        summary: typeof catalogSummary;
        toolDefinitions(filter?: {
            service?: string; channel?: ServiceChannel; availability?: string | null; mutates?: boolean;
        }): LlmToolDefinition[];
    };

    /**
     * Build the function surface: a socket in, every service function out.
     * Runs the same in a Valu Social build, in a Node script, in a server-side
     * agent and in an iframe application that has a socket.
     */
    export function createValuServices(options: {
        transport?: SocketTransport;
        socket?: ValuSocket;
        appState?: AppState;
        fetchImpl?: typeof fetch;
        config?: Partial<ValuConfig>;
        now?: () => Date;
        applicationId?: string;
        registry?: ServiceRegistry;
        cache?: ServiceCache | null;
        auth?: AuthProvider;
        hooks?: { sleep?: (ms: number) => Promise<void>; random?: () => number };
    }): ValuServiceApi;

    /** Everything `createValuServices` takes, minus the socket it no longer has
     * to be handed. */
    export type ValuServiceOptions = Omit<Parameters<typeof createValuServices>[0], 'socket'>;

    /**
     * The function surface, socket and all — either door (docs/connecting.md).
     *
     *   await connectValuServices({ socket: webSocketService, userId })  // adopt
     *   await connectValuServices({ sessionId, io })                     // open
     *
     * Adds three things over `createValuServices`: either door, reconnect wired
     * for a connection it opened, and `close()` closing only what it opened.
     */
    export function connectValuServices(
        options: ValuServiceOptions
            & (({ socket: unknown } & AdoptSocketOptions) | ValuSocketConnectionOptions),
    ): Promise<ValuServiceApi>;

    // ---------------------------------------------------------------------
    // createValuApp — the one entry point an app uses. See docs/connecting.md,
    // "Dedicated mode".
    // ---------------------------------------------------------------------

    /** `dedicated`: a top-level page that runs on its own host iframe and signs
     * the user in through a popup. `embedded`: a page inside Valu Social. */
    export type ValuMode = 'dedicated' | 'embedded';

    export interface ValuUser {
        id: string;
        name: string | null;
    }

    export interface ValuNetwork {
        id: string;
        name: string | null;
    }

    /**
     * Why an auth push happened, when it has a reason. `cancelled`,
     * `master_mismatch`, `not_a_member`, `invalid_token`, `unavailable` and
     * `timeout` (the host gave up redeeming the sign-in token after 15 s) answer a
     * sign-in; `session_expired` and `signed_out_elsewhere` say the session ended.
     * `unavailable` also arrives with `signedIn: true`: a stored session the host
     * has kept while the master is unreachable, which it retries (the connection is
     * `reconnecting`, or `offline`); the next auth push, with no reason, says it opened.
     */
    export type ValuAuthReason =
        | 'cancelled' | 'master_mismatch' | 'not_a_member' | 'invalid_token' | 'unavailable' | 'timeout'
        | 'session_expired' | 'signed_out_elsewhere';

    export interface ValuAuthState {
        signedIn: boolean;
        user: ValuUser | null;
        network: ValuNetwork | null;
        /** The reason of the last auth push, until the next push. Absent when it had none. */
        reason?: ValuAuthReason | (string & {});
    }

    /**
     * The state of an app's link to its host (`valu.connection.state`), not of a
     * socket: {@link ValuConnectionState} is `ValuSocketConnection`'s.
     *
     * - `connecting`: the host is up and has said who the user is from storage (so
     *   `auth.state.signedIn` may already be `true`), but the master has not confirmed
     *   it yet. `createValuApp` does not wait for it; `ready` follows, with an auth push.
     * - `ready`: signed in, link up.
     * - `reconnecting`: the link dropped, or the master could not be reached at the
     *   start; the host is retrying and the user stays signed in.
     * - `offline`: the browser is offline, or the host could not be restarted (`lastError`).
     * - `signed_out`: no user.
     */
    export type ValuAppConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'offline' | 'signed_out';

    /** What a `connection` `change` handler receives. */
    export interface ValuConnectionChange {
        state: ValuAppConnectionState;
        /** True for the notice that a dropped link is back: what the app cached about the platform predates it. */
        reconnected: boolean;
        lastError: { code: string } | null;
    }

    /**
     * The `code` of the Errors a `createValuApp` call rejects with.
     *
     * - `createValuApp()`: `host_unreachable`, or the host's own: `unknown_app`, `nested`,
     *   `protocol_unsupported`, `resolve_unavailable`.
     * - `auth.signIn()`: `popup_blocked`, `cancelled`, `timeout`, `master_mismatch`,
     *   `not_a_member`, `invalid_token`, `unavailable`, `session_expired`, `not_available`
     *   (embedded), `closed`.
     * - `auth.requestConsent()`: `popup_blocked`, `not_available` (embedded), `closed`;
     *   `host_restarted`, `host_unreachable` when the host went away meanwhile.
     * - `auth.signOut()`: `not_available` (embedded), `closed`, `host_restarted`, `host_unreachable`.
     * - `closed`: `valu.close()` ran, before the call or while it waited.
     */
    export type ValuAppErrorCode =
        | 'popup_blocked' | 'cancelled' | 'timeout' | 'master_mismatch' | 'not_a_member'
        | 'invalid_token' | 'unavailable' | 'session_expired' | 'not_available' | 'closed'
        | 'host_unreachable' | 'host_restarted'
        | 'unknown_app' | 'nested' | 'protocol_unsupported' | 'resolve_unavailable';

    export interface ValuAppError extends Error {
        code: ValuAppErrorCode | (string & {});
    }

    export interface ValuAuth {
        /** Who the user is, now. A new object on every read, but its `user` and
         * `network` are shared objects (the same on every read), not copies: do
         * not mutate them. In embedded mode: always signed out; the embedding
         * application owns the session. */
        readonly state: ValuAuthState;
        /**
         * Sign in through a popup on the Valu sign-in origin. Call it from a click:
         * the popup opens before anything is awaited, or the browser blocks it
         * (`popup_blocked`). Resolves with the new state; rejects `cancelled`
         * (the user turned it down or closed the window), `timeout` (five minutes, or the
         * host gave up redeeming the token after 15 s), `master_mismatch`, `not_a_member`, `invalid_token`, `unavailable` or
         * `session_expired` (the session the host held ended meanwhile).
         */
        signIn(): Promise<ValuAuthState>;
        /** Sign out of this app's session. The user's Valu Social sign-in is untouched. */
        signOut(): Promise<void>;
        /**
         * Ask the user to let this app use `scopes` (`rooms:read` …), in a popup:
         * call it from a click. Resolves whether the user approved.
         */
        requestConsent(scopes: string[]): Promise<boolean>;
        /** Every auth push, with the new state. Returns the way to stop. */
        on(event: 'change', handler: (state: ValuAuthState) => void): () => void;
    }

    export interface ValuConnection {
        readonly state: ValuAppConnectionState;
        /** The reason of the last connection push that had one (`host_unreachable` …); cleared when the link is back. */
        readonly lastError: { code: string } | null;
        /** Every connection push. Returns the way to stop. */
        on(event: 'change', handler: (change: ValuConnectionChange) => void): () => void;
    }

    export interface CreateValuAppOptions {
        /** Where the host is served: a bare origin. Default `https://valuguru.texpo.io`. */
        hostOrigin?: string;
        /** The Valu brand users sign in through (`https://chabaduniverse.com` for a Chabad-network
         * app). Default `https://live.valuverse.io`. */
        signInOrigin?: string;
        /** The app's address, `<workspace>/<slug>`, sent in `host:hello`: dev hosts only. */
        app?: string;
        /**
         * Embedded only: the origins the embedding application's `api:ready` may
         * come from (the sender must be `window.parent` regardless). Omitted: any
         * origin. Dedicated mode ignores it; its host is the one at `hostOrigin`.
         */
        hostOrigins?: string[];
        /** Default: `dedicated` for a top-level page or one loaded with `?valu-mode=dedicated`,
         * `embedded` for a framed one. */
        mode?: ValuMode;
        window?: Window;
        document?: Document;
        /** Opens a window. Default `window.open`. */
        popup?: (url: string, name: string, features: string) => Window | null;
        /** Dedicated only: `fetch` for the functions that run in the page (`Http.*`). */
        fetchImpl?: typeof fetch;
        /** Dedicated only: runs those functions instead. */
        localTransport?: Transport;
        /** Timers: the popup poll, the sign-in deadline, the host handshake and ping. For a test that turns the clock itself. */
        setTimeout?: (fn: () => void, ms: number) => unknown;
        clearTimeout?: (id: any) => void;
    }

    /**
     * What `createValuApp` returns: the service functions (`valu.Users.current()`,
     * every method answers an ack; `call`, `invoke` and `toolDefinitions` for a
     * caller that holds a name) next to `auth`, `network`, `connection` and the
     * bridge methods.
     */
    export type ValuApp = ValuServices & {
        readonly mode: ValuMode;
        /** Dedicated: already resolved. Embedded: resolves on the parent's `api:ready`. */
        readonly ready: Promise<void>;
        readonly auth: ValuAuth;
        /** The network the host runs in, or `null` (signed out, or embedded). A shared object: do not mutate it. */
        readonly network: ValuNetwork | null;
        readonly connection: ValuConnection;
        /** The same functions, returning the payload and throwing `ValuServiceError`. */
        readonly data: ValuServicesData;
        /**
         * The `ValuApi` underneath. Dedicated: for the lifecycle (`setApplication`) only; `getApi`,
         * `runConsoleCommand` and `sendIntent` are Valu Social's and the host answers them
         * `not_available`, and the routes are not answered. Embedded: all of it.
         */
        readonly bridge: ValuApi;

        /**
         * Call a service function by name (`'Rooms.searchMyRooms'`, `'Rooms.search-my-rooms'`),
         * for a caller that holds a string. The same call as `valu.Rooms.searchMyRooms(...)`:
         * resolves the ack and never rejects, and a `consent_required` refusal gets the
         * same retry. Embedded: `501`.
         */
        call<T = any>(name: string, params?: object, options?: {
            timeoutMs?: number; retries?: number; bypassCache?: boolean;
        }): Promise<ValuAck<T>>;
        /** `call`, unwrapped: resolves the payload, throws `ValuServiceError`. */
        invoke<T = any>(name: string, params?: object, options?: {
            timeoutMs?: number; retries?: number; bypassCache?: boolean;
        }): Promise<T>;
        /** LLM tool definitions of the service functions; by default the ones an AI caller may reach. */
        toolDefinitions(filter?: {
            service?: string; channel?: ServiceChannel; availability?: string | null; mutates?: boolean;
        }): LlmToolDefinition[];

        /**
         * Ask the host to run one of ITS intents: the Commerce data intents and
         * `Application.get-identity-token` (dedicated). A refusal is an answer, not a rejection,
         * and is not retried: `{success: false, code: 'consent_required', scope}` is yours to
         * pass to `auth.requestConsent([scope])`. Its other refusal codes: `sign_in_required`,
         * `not_a_member` (the user's sign-in was refused for not being a member of the network),
         * `busy`, `timeout`, `unavailable`.
         */
        callService(intent: Intent): Promise<any>;
        /** Embedded: Valu Social runs the intent. Dedicated: `not_available`. */
        sendIntent(intent: Intent): Promise<any>;
        /**
         * Listen for Commerce events (`ValuApi.ON_COMMERCE`). Returns the way to stop. Nothing
         * arrives until the app subscribes: `callService(new Intent('Commerce', 'subscribe-events', {events}))`.
         */
        onCommerceEvent(handler: (event: CommerceEvent) => void): () => void;
        addEventListener(event: string, callback: (data: any) => void): void;
        /** Pass the handler: a call without one clears every listener of the event, `onCommerceEvent`'s too. */
        removeEventListener(event: string, callback: (data: any) => void): void;
        /** Fail what is waiting, drop the caches, remove the host iframe or the window listener. */
        close(): Promise<void>;
    };

    /**
     * Make the app's one object. Dedicated: opens the host and resolves once it
     * has answered; rejects with an Error whose `code` says why not
     * (`host_unreachable`, `unknown_app` …, see {@link ValuAppErrorCode}).
     * Embedded: resolves at once; `valu.ready` follows the parent's `api:ready`.
     */
    export function createValuApp(options?: CreateValuAppOptions): Promise<ValuApp>;

    export interface AppToken {
        token: string;
        expiresAt: number;
        scopes: string[];
        applicationId?: string;
    }

    export class TokenStore {
        constructor(options?: { now?: () => number });
        set(token: AppToken): AppToken;
        get(): AppToken | null;
        isStale(skewMs?: number): boolean;
        scopes(): string[];
        clear(): void;
        /** Safe to log: never contains the token itself. */
        describe(): { present: boolean; applicationId?: string; scopes?: string[]; expiresAt?: number; stale?: boolean };
    }

    export class AuthProvider {
        constructor(options: {
            acquire: () => Promise<AppToken>;
            revoke?: (token: AppToken) => Promise<void>;
            skewMs?: number;
            now?: () => number;
        });
        get store(): TokenStore;
        getToken(options?: { force?: boolean }): Promise<AppToken>;
        refresh(): Promise<AppToken>;
        revoke(): Promise<void>;
        /** The socket handshake payload: the app token, never the session. */
        handshake(context?: { applicationId?: string; networkId?: string }): Promise<{
            token: string; applicationId?: string; networkId?: string;
        }>;
        scopes(): string[];
        hasScope(scope: string): boolean;
        scopeAck(scopes?: string[]): ValuAck | null;
    }

    /** Throws if a payload carries the user's own credential. */
    export function assertNoCredentialLeak<T>(payload: T, where?: string): T;

    // ---------------------------------------------------------------------
    // Another application's REST API, called from a page on a Valu host —
    // the Valu Guru gateway's trusted-host door. See src/AppApi.js.
    // ---------------------------------------------------------------------

    /** The header a page names its network in. */
    export const NETWORK_HEADER: 'x-valu-network';
    /** The header a page narrows its scopes with (absent = every declared scope). */
    export const SCOPE_HEADER: 'x-valu-scope';

    /** A refusal, from the gateway or from the target, in the `{ error: { code, message } }` envelope. */
    export class AppApiError extends Error {
        constructor(status: number, code: string, message: string, body?: unknown);
        status: number;
        code: string;
        body: unknown;
    }

    /** `{application}` or `{workspace}/{application}`; anything else throws. */
    export function normalizeAddress(address: string): string;

    export interface AppApiClientOptions {
        /** The Valu Guru server origin, e.g. `https://valuguru.app`. */
        gatewayBase: string;
        /** The network id every call is scoped to, or a function answering it. */
        network: string | (() => string | Promise<string>);
        /** The signed-in user's platform identity token (the `Application.get-identity-token` intent). */
        identityToken?: () => Promise<string | { token: string } | null | undefined>;
        /** Scopes to ask for on every call. Absent = every scope the target declares. */
        scope?: string | string[];
        fetch?: typeof fetch;
        now?: () => number;
    }

    export type AppApiInit = RequestInit & { scope?: string | string[] };

    export interface AppApiClient {
        readonly gatewayBase: string;
        /** The gateway URL for an address and a path after it. */
        urlFor(address: string, path?: string): string;
        /** One call; the Response as the target (or the gateway) sent it. */
        call(address: string, path: string, init?: AppApiInit): Promise<Response>;
        /** `call` with the body read as JSON; a refusal is thrown as `AppApiError`. */
        json<T = any>(address: string, path: string, init?: AppApiInit & { body?: any }): Promise<T>;
        /** The target's OpenAPI document, read through the gateway. Public. */
        openapi(address: string): Promise<any>;
        get<T = any>(address: string, path: string, init?: AppApiInit): Promise<T>;
        post<T = any>(address: string, path: string, body?: any, init?: AppApiInit): Promise<T>;
        put<T = any>(address: string, path: string, body?: any, init?: AppApiInit): Promise<T>;
        patch<T = any>(address: string, path: string, body?: any, init?: AppApiInit): Promise<T>;
        delete<T = any>(address: string, path: string, init?: AppApiInit): Promise<T>;
        /** Forget the cached identity token (sign-out). */
        forgetIdentity(): void;
    }

    export function createAppApiClient(options: AppApiClientOptions): AppApiClient;

    export interface ResolvedPolicy {
        timeoutMs: number;
        retries: number;
        backoffMs: number;
        backoffFactor: number;
        maxBackoffMs: number;
        jitter: number;
    }

    export const DEFAULT_TIMEOUT_MS: number;
    export const DEFAULT_POLICY: ResolvedPolicy;
    export function forDescriptor(descriptor?: Partial<ServiceDescriptor>, overrides?: Partial<ResolvedPolicy>): ResolvedPolicy;
    export function isRetriable(ack: ValuAck): boolean;
    export function backoffFor(attempt: number, policy: ResolvedPolicy, random?: () => number): number;
    export function runWithPolicy(
        attempt: (attempt: number) => Promise<ValuAck>,
        policy: ResolvedPolicy,
        hooks?: { sleep?: (ms: number) => Promise<void>; random?: () => number },
    ): Promise<ValuAck>;
}

declare module '@arkeytyp/valu-api' {
    // ---------------------------------------------------------------------
    // The SDK surface added in Phase 2 — the parity matrix implemented.
    // See docs/parity.md for the function-by-function table.
    // ---------------------------------------------------------------------

    /**
     * State no RPC can produce — the application's own memory. The three
     * `app-state` functions read it; without it they answer 501 naming the
     * capability they wanted.
     */
    export interface AppState {
        listDeveloperApplications?(): Promise<any[]>;
        createDeveloperApplication?(manifest: {
            name: string; description?: string; url?: string; icon?: string;
        }): Promise<any>;
        getAgentWallet?(agentId: string): Promise<{
            identityName: string; iAddress: string; balance?: number | null; status?: string; error?: string;
        } | null>;
        /** Optional: decrypt a channel message body (browser key material). */
        decryptMessage?(body: string, message: any): Promise<string>;
    }

    export function noAppStateAck(descriptor: ServiceDescriptor, capability: string): ValuAck;

    /** The two origins the local resource-URL builders need. */
    export interface ValuConfig {
        webBase: string;
        apiGate: string;
    }
    export function resolveConfig(overrides?: Partial<ValuConfig>): ValuConfig;

    /** Anything that can name itself and produce bytes. */
    export interface UploadableFile {
        name: string;
        type?: string;
        contentType?: string;
        bytes?: Uint8Array | ArrayBuffer;
        arrayBuffer?(): Promise<ArrayBuffer>;
    }

    export const MAX_UPLOAD_BYTES: number;
    export function uploadResource(options: {
        socket: ValuSocket; file: UploadableFile; belonging: string;
        networkId?: string; grantToken?: string; fetchImpl?: typeof fetch;
    }): Promise<{ ok: true; resourceId: string; fileName: string } | { ok: false; fileName: string; detail: string }>;
    export function uploadResources(options: {
        socket: ValuSocket; files: UploadableFile[] | ArrayLike<UploadableFile>; belonging: string;
        networkId?: string; grantToken?: string; fetchImpl?: typeof fetch;
    }): Promise<{ resolved: Array<{ id: string; fileName: string }>; failed: Array<{ fileName: string; error: string }> }>;
    export function createUploadSession(socket: ValuSocket, userId: string): Promise<string>;

}
