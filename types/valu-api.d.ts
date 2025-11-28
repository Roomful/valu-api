declare module '@arkeytyp/valu-api' {
    export class ValuApi {
        static API_READY: string;

        get connected(): boolean;

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
     * The Valu API will automatically call these lifecycle methods when the host
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
    }
}