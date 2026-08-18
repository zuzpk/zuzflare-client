import FlareClient from "./Client";
// 
// import {
//     CollectionReference,
//     DocumentQueryBuilder,
//     DocumentReference
// } from "./Reference";
import { FlareConfig } from "./types";

/**
 * Singleton instance for easy app-wide access
 */
let flareInstance: FlareClient | null = null;
let flareProxy: FlareClient | null = null;
let flareConfigSignature: string | null = null;

const createFlareProxy = (instance: FlareClient): FlareClient => {
    return new Proxy(instance, {
        get(target, prop, receiver) {
            if (prop === 'onAuthStateChange') {
                return target.onAuthStateChanged.bind(target);
            }
            if (prop === 'onAuthConfigLoaded') {
                return target.onAuthConfigLoaded.bind(target);
            }

            const value = Reflect.get(target, prop, receiver);
            if (typeof value === 'function') {
                return value.bind(target);
            }

            return value;
        },
    }) as FlareClient;
};

const getConfigSignature = (config: FlareConfig): string => {
    return JSON.stringify({
        endpoint: config.endpoint,
        grpcUrl: config.grpcUrl,
        transport: config.transport,
        wsPath: config.wsPath,
        appId: config.appId,
        apiKey: config.apiKey,
        authRequestContentType: config.authRequestContentType,
        publicKey: config.publicKey,
        autoReconnect: config.autoReconnect,
        reconnectDelay: config.reconnectDelay,
        maxReconnectDelay: config.maxReconnectDelay,
        dataMapperKeys: Object.keys(config.dataMapper ?? {}).sort(),
    });
};

/**
 * Initialize and connect to FlareServer
 * Returns a singleton instance
 */
export const connectApp = (config: FlareConfig): FlareClient => {
    const nextSignature = getConfigSignature(config);
    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
    const isNextServerRuntime = !isBrowser && typeof process !== 'undefined' && typeof process.env?.NEXT_RUNTIME === 'string';

    // Next.js server and middleware requests share the same module graph inside
    // a long-lived process. Reusing a mutable auth client there can leak one
    // request's auth state into another, so those runtimes must stay isolated.
    if (isNextServerRuntime) {
        return createFlareProxy(new FlareClient(config));
    }

    if (flareInstance && flareConfigSignature !== nextSignature) {
        flareInstance.disconnect();
        flareInstance = null;
        flareProxy = null;
        flareConfigSignature = null;
    }

    if (!flareInstance) {
        flareInstance = new FlareClient(config);
        flareConfigSignature = nextSignature;

        // Avoid opening Flare WebSocket from Next.js server/middleware runtime.
        // Server-side auth helpers use HTTP only, while browser runtime should
        // continue to auto-connect for realtime subscriptions.
        if (isBrowser || !isNextServerRuntime) {
            flareInstance.connect();
        }
        if (isBrowser) {
            flareInstance.setupPushServiceWorker().catch(() => undefined);
        }
        flareProxy = createFlareProxy(flareInstance);
    }
    return flareProxy ?? flareInstance;
};

/**
 * Get the current Flare instance
 */
export const getFlare = (): FlareClient | null => {
    return flareProxy ?? flareInstance;
};

/**
 * Disconnect and reset the instance
 */
export const disconnectFlare = (): void => {
    if (flareInstance) {
        flareInstance.disconnect();
        flareInstance = null;
        flareProxy = null;
        flareConfigSignature = null;
    }
};

// // Main exports
export * from "./Query";

// Type exports
// Proxy helpers (Next.js SSR CSRF)
export {
    buildFlareHeaders, createCsrfProxy,
    createCsrfProxyHandler,
    extractCsrfFromRequest, type CsrfProxyConfig
} from "./Client/proxy";

export { FlareStorage } from "./Client/storage";
export { FlareError } from "./Errors";
export * from "./serverTimestamp";
export * from "./time";
export * from "./types";
export * from "./types/errors";
export * from "./types/message";
export * from "./types/response";

// Re-export @zuzjs/auth for convenience
export {
    Anonymous,
    Apple,
    AuthGuard,
    Credentials,
    Dropbox,
    Facebook,
    GitHub,
    Google,
    Providers, setupProvider, Twitter, type AuthToken, type CreateUserWithEmailAndPasswordInput, type NormalizedProfile,
    type OAuthProvider,
    type ProviderId,
    type SignInAnonymouslyInput,
    type SignInWithEmailAndPasswordInput
} from "@zuzjs/auth";
export { FlareClient };

// Default export
// 
export default FlareClient;

// Sentinels
export { increment, vector } from "./sentinels";

