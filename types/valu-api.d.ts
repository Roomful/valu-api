declare module '@arkeytyp/valu-api' {
    // The generated per-function types live next door. They are a MODULE (they
    // import this one), so they are imported rather than merged — that is what
    // lets `api.services.Users.current()` be typed without generating anything
    // into this hand-written file.
    import type { ValuServices, ValuServicesData, ApplicationIntentName } from './valu-services';

    export type { ValuServices, ValuServicesData, ApplicationIntentName };

    export class ValuApi {
        static API_READY: string;
        static ON_ROUTE : string;

        /**
         * @param options Defaults to the postMessage bridge. Pass a transport to speak
         *  over something else — see {@link SocketTransport}.
         */
        constructor(options?: { transport?: Transport });

        get connected(): boolean;

        /** The transport this instance speaks over. */
        get transport(): Transport;

        /**
         * The declared-service surface: descriptor lookup, param validation,
         * scopes, cache and the callbacks policy, over this transport.
         */
        get services(): ValuServiceApi;
        /**
         * Application intents, asked for by name. No method per intent: the
         * application registers them at runtime (docs/sdk-structure.md).
         */
        get intents(): ApplicationIntents;

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
            message?: string;
            description?: string;
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

    /** What carries a call: the postMessage bridge, or a socket. */
    export abstract class Transport {
        static READY: string;
        static TRIGGER: string;
        static NEW_INTENT: string;
        static RECONNECTED: string;
        static RESOURCE_UPDATED: string;

        get connected(): boolean;
        /** Whether this transport speaks the postMessage bridge at all. */
        get supportsPostMessage(): boolean;
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
        constructor(options?: { target?: EventTarget });
        get applicationId(): string | undefined;
    }

    /** Declared functions over a ValuSocket. Does not speak the bridge. */
    export class SocketTransport extends Transport {
        constructor(options: {
            socket: ValuSocket;
            /** For the 11 `valuguru` functions. Absent means they answer 503. */
            guru?: ValuGuruSocket;
            /** For the 5 `app-state` functions. */
            appState?: AppState;
            fetchImpl?: typeof fetch;
            config?: Partial<ValuConfig>;
            now?: () => Date;
            /** The calling application — Commerce and ApplicationStorage need it. */
            applicationId?: string | null;
            registry?: ServiceRegistry;
        });
        get socket(): ValuSocket;
        get guru(): ValuGuruSocket | null;
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

    export type ServiceBinding = 'socket' | 'local' | 'postmessage';
    /**
     * WHICH thing serves a function. `binding` says the kind; this says the
     * one. Phase 2 found that "socket" was three different things.
     */
    export type ServiceChannel = 'roomful' | 'valuguru' | 'app-state' | 'local' | 'postmessage';
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
        binding: ServiceBinding;
        channel: ServiceChannel;
        mutates: boolean;
        cache: { mode: CacheMode; ttlMs?: number; key?: string | null };
        returns: { type: string; description: string };
        params: { required: DescriptorParam[]; optional: DescriptorParam[] };
        /** Who says this function exists: the app's manifest, or this package. */
        declaredBy: 'manifest' | 'sdk';
        implementedBy: string | null;
    }

    export const SERVICE_DESCRIPTORS: readonly ServiceDescriptor[];
    export const SERVER_ONLY_TOOLS: readonly string[];
    /** The functions this package runs itself — socket + local. */
    export const SERVICE_FUNCTIONS: readonly ServiceDescriptor[];
    /** The intents only the Valu Social application can serve. */
    export const APPLICATION_INTENTS: readonly ServiceDescriptor[];

    /** Resolve `Users.get`, `Users.getUser`, `Users.get_user` or the tool name. */
    export function findDescriptor(name: string): ServiceDescriptor | undefined;
    export interface DescriptorFilter {
        service?: string;
        binding?: ServiceBinding;
        channel?: ServiceChannel;
        declaredBy?: 'manifest' | 'sdk';
        availability?: string;
        mutates?: boolean;
    }
    export function listDescriptors(filter?: DescriptorFilter): ServiceDescriptor[];
    export function listServiceFunctions(filter?: DescriptorFilter): ServiceDescriptor[];
    export function listApplicationIntents(filter?: DescriptorFilter): ServiceDescriptor[];
    export function isServiceFunction(name: string): boolean;
    export function listServices(): string[];
    export function catalogSummary(): {
        total: number; socket: number; local: number; postmessage: number;
        implemented: number; declared: number; sdkDeclared: number;
        sdkable: number; serviceFunctions: number; applicationIntents: number;
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
        service?: string; binding?: ServiceBinding; availability?: string | null; mutates?: boolean;
    }): LlmToolDefinition[];

    /** What a handler is given. Which fields it may rely on is its `channel`. */
    export interface ServiceCallContext {
        /** The Roomful socket. Always present. */
        socket: ValuSocket;
        /** The Valu Guru socket — present for `channel: 'valuguru'`. */
        guru: ValuGuruSocket | null;
        /** State only the Valu Social application holds — needed by
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

        call<T = any>(name: string, params?: object, options?: {
            timeoutMs?: number; retries?: number; bypassCache?: boolean;
        }): Promise<ValuAck<T>>;
        invoke<T = any>(name: string, params?: object, options?: {
            timeoutMs?: number; retries?: number; bypassCache?: boolean;
        }): Promise<T>;
        subscribe(event: 'resource:updated' | 'reconnected' | string, handler: (data: any) => void): () => void;
        seed(name: string, params: object, data: any, options?: { ttlMs?: number }): ValuServiceApi;
        toolDefinitions(filter?: {
            service?: string; binding?: ServiceBinding; availability?: string | null; mutates?: boolean;
        }): LlmToolDefinition[];
        close(): Promise<void>;
    };

    export const ValuServiceApi: {
        new (options: { client: ServiceClient }): ValuServiceApi;
        functions(): ServiceDescriptor[];
        services(): string[];
        summary: typeof catalogSummary;
        toolDefinitions(filter?: {
            service?: string; binding?: ServiceBinding; availability?: string | null; mutates?: boolean;
        }): LlmToolDefinition[];
    };

    /**
     * Build the function surface. Pass a transport, or the pieces of a
     * `SocketTransport` and it builds one.
     */
    export function createValuServices(options: {
        transport?: Transport;
        socket?: ValuSocket;
        guru?: ValuGuruSocket;
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
     * The Valu Guru server's request/response channel — a DIFFERENT socket
     * from `ValuSocket`, with a different envelope and different auth. Commerce
     * and the RAG search ride it.
     */
    export interface ValuGuruSocket {
        readonly networkId?: string;
        /** Run a `valuguru.*` op and resolve its response data. */
        request(op: string, params?: object, options?: { timeoutMs?: number }): Promise<any>;
        /** Send a typed catalogue message (e.g. `{type: 'rag_search'}`). */
        send?(message: object, options?: { timeoutMs?: number }): Promise<any>;
    }

    /** Wrap an AiGuruService-shaped object as a ValuGuruSocket. */
    export function guruAdapter(service: {
        request(op: string, params?: object, options?: object): Promise<any>;
        send?(message: object, options?: object): Promise<any>;
        networkId?: string;
    }): ValuGuruSocket;
    export function guruAck(call: () => Promise<any>, what: string): Promise<ValuAck>;
    export function isGuruSocket(guru: unknown): boolean;

    /**
     * State only the Valu Social application holds. The five `app-state`
     * functions read it;
     * without it they answer 501 naming the capability they wanted.
     */
    export interface AppState {
        getChatHistory?(chatId: string | null): Promise<{ session: any; messages: any[] } | null>;
        getAgentHistory?(agentId: string): Promise<{ agent: any; messages: any[] } | null>;
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

    // --- Application intents: one dynamic call, no functions ------------------

    /**
     * Every intent the Valu Social application can serve, by name.
     *
     * There is no method per intent on purpose — the application registers its
     * intents at runtime, so `run()` takes any `Service.action`, including one
     * newer than this package (docs/sdk-structure.md).
     */
    export class ApplicationIntents {
        constructor(transport: Transport);
        get transport(): Transport;

        /** Declared by the application: the ones it knows how to answer. */
        static list(filter?: { service?: string; availability?: string }): ServiceDescriptor[];
        /** The ones ONLY it can serve — no service function exists. */
        static exclusive(): ServiceDescriptor[];
        static describe(name: string): ServiceDescriptor | undefined;
        list(filter?: { service?: string; availability?: string }): ServiceDescriptor[];
        exclusive(): ServiceDescriptor[];
        describe(name: string): ServiceDescriptor | undefined;

        run(name: ApplicationIntentName | (string & {}), params?: object): Promise<ValuAck>;
    }

    export function parseIntentName(name: string):
        | { applicationId: string; action: string; descriptor?: ServiceDescriptor }
        | undefined;
}
