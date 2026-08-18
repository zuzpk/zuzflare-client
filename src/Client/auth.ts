import {
    Apple,
    AuthGuard,
    AuthToken,
    Credentials,
    Dropbox,
    Facebook,
    GitHub,
    Google,
    OAuthProvider,
    ProviderId,
    Twitter,
} from "@zuzjs/auth";
import { getCookie } from "@zuzjs/core";
import { FlareError } from "../Errors";
import ErrorCodes from "../Errors/codes";
import { AuthConfigListener, AuthResult, AuthStateListener, BrowserPushRegistrationOptions, BrowserPushTokenOptions, CopyObjectInput, DeleteObjectInput, DeleteObjectsInput, DownloadObjectInput, DownloadObjectResult, FlareAuthConfig, FlareAuthHydrationInput, FlareAuthHydrationOptions, FlareAuthSession, FlareAuthUser, FlareStorageSignedUrlResult, FlareStorageTransferManagerConfig, GetObjectInput, GetObjectResult, GetObjectUrlInput, HeadObjectInput, HeadObjectsInput, ListObjectsInput, ListObjectsResult, PushSendResult, PutObjectInput, PutObjectResult, QueryPresetMap, RegisterPushTokenInput, SendPushNotificationInput, StorageBucket, StorageBucketInput, StorageObjectMeta, StorageProgress, StorageSignedUrlInput } from "../types";
import { FlareAction, FlareEvent } from "../types/message";
import { FlareBase } from "./base";
import { runtimeImport } from "./runtime-import";
import { FlareStorage, FlareStorageTransport } from "./storage";

export class FlareAuth<TPresetMap extends QueryPresetMap = {}> extends FlareBase<TPresetMap> {

    static AUTH_TRACE_STORAGE_KEY = 'zuzjs.flare.auth.trace';

    protected pushServiceWorkerInitPromise?: Promise<ServiceWorkerRegistration | null>;
    
    /** Current authentication configuration */
    protected userId?: string;
    protected authToken?: string;
    protected authTicket?: string;
    protected authConfig?: FlareAuthConfig;
    protected authStateListeners: AuthStateListener[] = [];
    protected authConfigListeners: AuthConfigListener[] = [];
    protected authSession: FlareAuthSession | null = null;
    protected currentProfile: FlareAuthUser | undefined = undefined;
    protected authBootstrapAttempted = false;
    protected authBootstrapPromise?: Promise<void>;
    protected socketAuthSyncPromise?: Promise<void>;
    protected authGuard?: AuthGuard;

    /** In-memory CSRF token extracted from the `x-flare-csrf` response header */
    protected csrfToken?: string;
    protected csrfBootstrapAttempted = false;
    protected csrfInitPromise?: Promise<void>;

    /** Lazy singleton FlareStorage service. */
    private _storageService: FlareStorage | null = null;

    protected isAuthTraceEnabled(): boolean {
        
        const fromGlobal = (globalThis as any)?.__FLARE_AUTH_TRACE__;
        if (fromGlobal === true || fromGlobal === false) return fromGlobal;

        if (typeof window !== 'undefined') {
            try {
                const value = window.localStorage.getItem(FlareAuth.AUTH_TRACE_STORAGE_KEY);
                if (value === '1' || value === 'true') return true;
                if (value === '0' || value === 'false') return false;
            } catch {
                // Ignore storage access issues.
            }
        }

        const envValue = (globalThis as any)?.process?.env?.FLARE_AUTH_TRACE;
        return envValue === '1' || envValue === 'true';
    }

    protected traceAuth(event: string, details?: Record<string, unknown>): void {
        if (!this.isAuthTraceEnabled()) return;
        if (typeof console === 'undefined') return;
        const payload = {
            event,
            appId: this.config.appId,
            ts: Date.now(),
            uid: this.authSession?.uid ?? this.userId ?? null,
            hasAccessToken: Boolean(this.authSession?.accessToken),
            hasRefreshToken: Boolean(this.authSession?.refreshToken),
            ...(details ?? {}),
        };
        console.info('[FLARE_AUTH_TRACE]', payload);
    }

    setAuthTrace(enabled: boolean, persist = true): void {
        (globalThis as any).__FLARE_AUTH_TRACE__ = enabled;
        if (persist && typeof window !== 'undefined') {
            try {
                window.localStorage.setItem(FlareAuth.AUTH_TRACE_STORAGE_KEY, enabled ? '1' : '0');
            } catch {
                // Ignore storage access issues.
            }
        }
    }

    // AUTHENTICATION_MANAGEMENT

    protected async fetchAuthMe(token?: string): Promise<{ id?: string; email?: string | null; email_verified?: boolean }> {
        const base = this.getHttpBase();
        // Template literal preserves path-prefixed base (e.g. '/api/flare').
        const qs = new URLSearchParams({ appId: this.config.appId });
        if (this.config.apiKey) qs.set('apiKey', this.config.apiKey);
        const urlStr = `${base}/auth/me?${qs.toString()}`;
        const trace = await this.timedFetch('fetchAuthMe', urlStr, {
            credentials: 'include',
            headers: { 
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) 
            },
            // headers: { Authorization: `Bearer ${token}`, ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
        });
        const json = await this.parseJsonWithTiming('fetchAuthMe', trace);
        // console.log(`--fetchAuthMe`, { url: urlStr, response: trace.response, json });
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Failed to fetch profile', ErrorCodes.QueryFailed);
        return json as { email?: string | null; email_verified?: boolean };
    }

    isBootstrapAttempted(): boolean {
        return this.authBootstrapAttempted;
    }

    async updateProfile(profileUpdates: Partial<FlareAuthUser>): Promise<void> {
        if (this.authSession?.uid) {
            const updatedProfile = {
                ...this.currentProfile,
                ...profileUpdates,
            };
            // console.log('Updating profile with', this.currentProfile, profileUpdates, updatedProfile);
            this.currentProfile = updatedProfile as FlareAuthUser;
            this.emitAuthState()
        }
    }

    async hydrateAuthState(input: FlareAuthHydrationInput | null, options?: FlareAuthHydrationOptions): Promise<void> {

        const source = options?.source ?? 'hydrateAuthState';

        // console.log(`--- hydrateAuthState called with input:`, input, `options:`, options); // --- IGNORE ---

         if (!input) {
            this.setAuthSession(null, `${source}.clear`);
            return;
        }

        const uid = (input.uid ?? input.id ?? (input as any)?.sub ?? null) as string | null;
        if (!uid || typeof uid !== 'string') {
            this.traceAuth('hydrateAuthState.skipped', { source, reason: 'missing_uid' });
            return;
        }

        const profileCandidate = {
            ...(this.currentProfile ?? {}),
            ...(input.profile ?? {}),
            ...input,
            uid,
            id: uid,
        } as Record<string, unknown>;


        this.currentProfile = profileCandidate as FlareAuthUser;

        if (options?.markBootstrapAttempted !== false) {
            this.authBootstrapAttempted = true;
        }

        // Capture Ticket
        const hasWebSocketTicket = typeof input.ticket === 'string' && input.ticket.length > 0;
        if ( hasWebSocketTicket ){
            this.authTicket = input.ticket as string;
            this.traceAuth('hydrateAuthState.ticket_captured', { source });
            await this.syncSocketAuth(this.authTicket).catch(() => undefined);
            this.traceAuth('hydrateAuthState.completed', { source, uid });
            this.emitAuthState();
        }
        
        // Capture Session
        // 
const hasAccessToken = typeof input.accessToken === 'string' && input.accessToken.length > 0;
        // if (hasAccessToken) {
        //     this.setAuthSession({
        //         uid,
        //         accessToken: input.accessToken as string,
        //         refreshToken: typeof input.refreshToken === 'string' ? input.refreshToken : null,
        //         provider: input.provider,
        //         email: typeof input.email === 'string' ? input.email : null,
        //         emailVerified: typeof input.emailVerified === 'boolean'
        //             ? input.emailVerified
        //             : (typeof input.email_verified === 'boolean' ? input.email_verified : undefined),
        //     }, `${source}.session`);

        //     if (options?.syncSocket !== false) {
        //         await this.syncSocketAuth(input.accessToken as string).catch(() => undefined);
        //     }
        //     return;
        // }

        // this.traceAuth('hydrateAuthState.profile_only', {
        //     source,
        //     uid,
        // });
        // this.emitAuthState();

        // if (options?.syncSocket !== false) {

        //     
const authCredential = this.getAuthTicket()
        //     if (authCredential) {
        //         await this.syncSocketAuth(authCredential).catch(() => undefined);
        //     }

        //     // Ticket-first socket sync for profile-only hydration path.
        //     // if (this.getAuthTicket()) {
        //     //     
const syncedWithTicket = await this.syncSocketAuth(null)
        //     //         .then(() => this.socketAuthUid !== 'anon')
        //     //         .catch(() => false);
        //     //     if (syncedWithTicket) return;
        //     // }

        //     await this.ensureSessionForSocketAuth(`${source}.profile_only`).catch(() => false);
        // }

    }

    async loadAuthConfig(): Promise<FlareAuthConfig> {

        const base = this.getHttpBase();
        // Use template literal so a path-prefixed base (e.g. '/api/flare') is preserved.
        // new URL('/auth/config', base) would drop any path prefix in base.
        const qs = new URLSearchParams({ appId: this.config.appId });
        if (this.config.apiKey) qs.set('apiKey', this.config.apiKey);
        const urlStr = `${base}/auth/config?${qs.toString()}`;

        const trace = await this.timedFetch('loadAuthConfig', urlStr, {
            credentials: 'include',
            headers: this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {},
        });

        const json = await this.parseJsonWithTiming('loadAuthConfig', trace);
        if (!trace.response.ok) {
            this.throwFetchFlareError(json, 'Failed to load auth config', ErrorCodes.QueryFailed);
        }

        this.authConfig = json as FlareAuthConfig;
        // Capture the CSRF token sent as an HttpOnly cookie by the server.
        // The header echo lets us read it here and use it for future requests.
        this.csrfToken = this.extractCsrfToken(json, trace.response) ?? this.csrfToken;

        this.authConfigListeners.forEach((listener) => {
            try { listener(this.authConfig!); } catch (e) { this.log('Auth config listener error', e); }
        });

        return this.authConfig;
    }

    onAuthConfigLoaded(listener: AuthConfigListener): () => void {
        this.authConfigListeners.push(listener);
        if (this.authConfig) listener(this.authConfig);
        return () => {
            this.authConfigListeners = this.authConfigListeners.filter((l) => l !== listener);
        };
    }

    onAuthStateChanged(listener: AuthStateListener): () => void {

        this.authStateListeners.push(listener);
        const bootstrapMode = this.config.authBootstrapMode ?? 'refresh';

        const hasHttpBootstrapBase = (() => {
            try {
                return Boolean(this.getHttpBase());
            } catch {
                return false;
            }
        })();

        const emitCurrentState = () => {
            try {
                const payload = this.authSession
                    ? ({ ...this.authSession, ...(this.currentProfile ?? {}) } as FlareAuthSession & FlareAuthUser)
                    : (this.currentProfile && typeof this.currentProfile.uid === 'string'
                        ? (this.currentProfile as FlareAuthSession & FlareAuthUser)
                        : null);
                listener(payload);
            } catch (e) { this.log('Auth state listener error during initialization', e); }
        };

        const shouldBootstrapFromCookieSession =
            bootstrapMode === 'refresh' &&
            !this.authSession &&
            !this.authBootstrapAttempted &&
            typeof window !== 'undefined' &&
            typeof document !== 'undefined' &&
            hasHttpBootstrapBase;

        const shouldWaitForInFlightBootstrap =
            !this.authSession &&
            Boolean(this.authBootstrapPromise);

        if (shouldBootstrapFromCookieSession) {
            this.traceAuth('onAuthStateChanged.bootstrap.start', {
                listenerCount: this.authStateListeners.length,
            });
            this.authBootstrapAttempted = true;
            if (!this.authBootstrapPromise) {
                this.authBootstrapPromise = this.refreshAuthSession()
                    .catch(() => null)
                    .then(() => undefined)
                    .finally(() => {
                        this.authBootstrapPromise = undefined;
                    });
            }

            this.authBootstrapPromise.finally(() => {
                if (!this.authStateListeners.includes(listener)) return;
                this.traceAuth('onAuthStateChanged.bootstrap.done', {
                    hasSession: Boolean(this.authSession),
                });
                if (!this.authSession) emitCurrentState();
            });
        } else if (shouldWaitForInFlightBootstrap) {
            this.traceAuth('onAuthStateChanged.bootstrap.wait', {
                listenerCount: this.authStateListeners.length,
            });
            this.authBootstrapPromise?.finally(() => {
                if (!this.authStateListeners.includes(listener)) return;
                if (!this.authSession) emitCurrentState();
            });
        } else {
            emitCurrentState();
        }

        return () => {
            this.authStateListeners = this.authStateListeners.filter((l) => l !== listener);
        };
    }

    getCurrentUser(): FlareAuthUser | undefined {
        return this.currentProfile;
    }

    getAuthTicket(): string | undefined {
        return this.authTicket;
    }

    consumeAuthTicket(): string | undefined {
        const ticket = this.authTicket;
        this.authTicket = undefined; // Ensure it's one-time use
        return ticket;
    }

    // CSRF helpers

    private getDefaultCsrfCookieName(): string {
        return `__flare_csrf_${this.config.appId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    }

    /**
     * Extract CSRF token from a server response.
     * The server now sends it ONLY as the `x-flare-csrf` response header
     * (not in the JSON body). We still support the body field as a fallback
     * for older server versions.
     */
    protected extractCsrfToken(
        json: unknown,
        response?: { headers: { get: (name: string) => string | null } },
    ): string | undefined {
        // Fallback: older server versions may still include it in the body
        const payload = json as Record<string, unknown> | null;
        const fromBody = typeof payload?.csrfToken === 'string'
            ? String(payload.csrfToken)
            : (typeof payload?.csrf_token === 'string' ? String(payload.csrf_token) : undefined);
        if (fromBody) return fromBody;

        if (!response) return undefined;

        // Primary: read from response header
        const fromHeader =
            response.headers.get('x-flare-csrf') ??
            response.headers.get('x-csrf-token') ??
            response.headers.get('csrf-token');

        return typeof fromHeader === 'string' && fromHeader.length > 0 ? fromHeader : undefined;
    }


    getCsrfHeaders(): Record<string, string> {
        const token = this.getCsrfToken();
        return token ? { 'x-flare-csrf': token } : {};
    }

    getCsrfCookieName(): string {
        return this.authConfig?.cookie?.csrfTokenName ?? this.getDefaultCsrfCookieName();
    }

    /**
     * Read the CSRF token from a browser-readable cookie (set by the server as
     * a non-HttpOnly fallback) or fall back to the in-memory value captured
     * from the response header.
     *
     * Priority:
     *   1. Non-HttpOnly cookie on the current domain (browser only)
     *   2. In-memory value from `x-flare-csrf` response header
     */
    getCsrfToken(): string | null {
        const fromCookie = getCookie(this.getCsrfCookieName());
        return fromCookie ?? this.csrfToken ?? null;
    }

    async ensureCsrfProtection(): Promise<void> {
        if (this.getCsrfToken()) {
            this.csrfBootstrapAttempted = true;
            return;
        }

        // In httpBase proxy mode, CSRF is expected to be handled by the server
        // (middleware + API proxy route). Skip browser-side /auth/config bootstrap.
        if (this.config.httpBase) {
            this.csrfBootstrapAttempted = true;
            return;
        }

        // Avoid repeated /auth/config requests when CSRF is unavailable.
        // This keeps browser calls from re-fetching CSRF on every method call.
        if (this.csrfBootstrapAttempted) return;

        if (!this.csrfInitPromise) {
            this.csrfBootstrapAttempted = true;
            this.csrfInitPromise = this.loadAuthConfig()
                .then(() => undefined)
                .finally(() => { this.csrfInitPromise = undefined; });
        }

        await this.csrfInitPromise;

        if (!this.getCsrfToken()) {
            this.log('CSRF token unavailable after auth config load', {
                hasAuthConfig: Boolean(this.authConfig),
                csrfCookieName: this.getCsrfCookieName(),
            });
        }
    }

    // SESSION_MANAGEMENT
    protected setAuthSession(session: FlareAuthSession | null, source = 'unknown'): void {
        const previousUid = this.authSession?.uid ?? this.userId ?? null;
        this.authSession = session;
        if (session) {
            this.authToken = session.accessToken;
            this.userId = session.uid;
            this.traceAuth('setAuthSession', {
                source,
                nextUid: session.uid,
                previousUid,
                mode: 'set',
            });
        } else {
            this.traceAuth('setAuthSession', {
                source,
                nextUid: null,
                previousUid,
                mode: 'clear',
            });
            this.authToken = undefined;
            this.userId = undefined;
            this.currentProfile = undefined;
            // Wipe the HTTP cache so stale /auth/refresh responses can't
            // re-hydrate a dead session after sign-out.
            this.httpResponseCache.clear();
            this.httpInFlight.clear();
        }

        this.emitAuthState();
    }

    protected emitAuthState(): void {
        const payload = this.authSession
            ? ({ ...this.authSession, ...(this.currentProfile ?? {}) } as FlareAuthSession & FlareAuthUser)
            : (this.currentProfile && typeof this.currentProfile.uid === 'string'
                ? (this.currentProfile as FlareAuthSession & FlareAuthUser)
                : null);

        this.authStateListeners.forEach((listener) => {
            try {
                listener(payload);
            } catch (err) { this.log('Auth state listener error', err); }
        });
    }

    protected setProfile(profile: FlareAuthUser): void {
        this.currentProfile = profile;
    }

    protected async ensureSessionForSocketAuth(reason: string): Promise<boolean> {
        if (this.authSession?.accessToken && this.authSession?.uid) return true;

        // Prefer one-time websocket ticket over refresh flow when available.
        if (this.isConnected && this.getAuthTicket()) {
            try {
                await this.syncSocketAuth(null);
                if (this.socketAuthUid !== 'anon') {
                    this.traceAuth('ensureSessionForSocketAuth.ticket', {
                        reason,
                        socketAuthUid: this.socketAuthUid,
                    });
                    return true;
                }
            } catch {
                // Ticket failed/expired. Fall through to refresh-based fallback.
            }
        }

        const hasHttpBootstrapBase = (() => {
            try {
                return Boolean(this.getHttpBase());
            } catch {
                return false;
            }
        })();

        const profileUid = this.currentProfile?.uid;
        if (!hasHttpBootstrapBase || !profileUid) return false;

        this.traceAuth('ensureSessionForSocketAuth.start', {
            reason,
            hasInFlightBootstrap: Boolean(this.authBootstrapPromise),
            profileUid,
        });

        if (!this.authBootstrapPromise) {
            this.authBootstrapPromise = this.refreshAuthSession()
                .catch(() => null)
                .then(() => undefined)
                .finally(() => {
                    this.authBootstrapPromise = undefined;
                });
        }

        await this.authBootstrapPromise;
        const hasSession = Boolean(this.authSession?.accessToken && this.authSession?.uid);

        this.traceAuth('ensureSessionForSocketAuth.done', {
            reason,
            hasSession,
            sessionUid: this.authSession?.uid ?? null,
        });

        return hasSession;
    }

    async refreshAuthSession(refresh_token?: string): Promise<FlareAuthSession | null> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        this.traceAuth('refreshAuthSession.start', {
            providedRefreshToken: Boolean(refresh_token),
            hasSessionBefore: Boolean(this.authSession),
        });

        const trace = await this.timedFetch('refreshAuthSession', `${base}/auth/refresh?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body: JSON.stringify({ appId: this.config.appId, apiKey: this.config.apiKey, ...(refresh_token ? { refresh_token } : {}) }),
        });
        const json = await this.parseJsonWithTiming('refreshAuthSession', trace) as Record<string, unknown>;
        if (!trace.response.ok) {
            if (trace.response.status === 401) {
                this.traceAuth('refreshAuthSession.response', {
                    status: trace.response.status,
                    ok: false,
                    reason: 'unauthorized',
                });
                this.setAuthSession(null, 'refreshAuthSession.401');
                await this.syncSocketAuth(null).catch(() => undefined);
                return null;
            }
            this.throwFetchFlareError(json, 'Failed to refresh auth session', ErrorCodes.AuthenticationFailed);
        }

        const accessToken = String(json.access_token ?? '');
        if (!accessToken) throw new FlareError('Refresh succeeded but no access token was returned', ErrorCodes.ParseError);
        const profile : any = await this.fetchAuthMe(accessToken).catch(() => null);
        const nextSession: FlareAuthSession = {
            uid: String(profile?.id ?? this.authSession?.uid ?? this.userId ?? ''),
            accessToken,
            refreshToken: json.refresh_token ? String(json.refresh_token) : this.authSession?.refreshToken ?? null,
            provider: this.authSession?.provider,
            email: profile?.email ?? this.authSession?.email ?? null,
            emailVerified: profile?.email_verified,
        };
        if ( profile ){
            try{
                delete profile.kind;
                profile.uid = profile.id ?? profile.uid;
                delete profile.id
            }catch(e){}
            this.setProfile(profile);
        }
        this.traceAuth('refreshAuthSession.response', {
            status: trace.response.status,
            ok: true,
            nextUid: nextSession.uid,
            hasProfile: Boolean(profile),
        });
        this.setAuthSession(nextSession, 'refreshAuthSession.success');
        if ( typeof window !== 'undefined' ){
            await this.syncSocketAuth(accessToken).catch(() => undefined);
        }
        return nextSession;
    }

    // WEBSOCKET_MANAGEMENT
    protected async updateSocketIdentity(uid?: string, forceReplay = false): Promise<void> {
        const nextUid = typeof uid === 'string' && uid.length > 0 ? uid : 'anon';
        const identityChanged = nextUid !== this.socketAuthUid;
        this.socketAuthUid = nextUid;
        if ((identityChanged || forceReplay || this.pendingSubscriptionReplay) && this.activeSubscriptions.size > 0) {
            await this.replayActiveSubscriptions();
        }
    }
    
    protected async waitUntilConnected(): Promise<void> {

        if (this.transport.connected) return;

        return new Promise((resolve) => {
            const check = setInterval(() => {
                if (this.transport.connected) {
                    clearInterval(check);
                    resolve();
                }
            }, 50); // Check every 50ms
        });
    }

    protected async syncSocketAuth(accessToken?: string | null): Promise<void> {

        const credential = accessToken || this.authTicket || this.authSession?.accessToken;
        if ( !credential )  return;

        if (this.socketAuthSyncPromise) {
            return this.socketAuthSyncPromise;
        }

        this.socketAuthSyncPromise = (async () => {
            try {
                // Wait for transport to be ready
                await this.waitUntilConnected();

                this.log('Executing socket auth with credential type:', accessToken || this.authTicket ? 'ticket' : 'token');

                const response = await this.send(FlareAction.AUTH, { token: credential });

                if (response.type !== FlareEvent.AUTH_OK) {
                    throw new FlareError('Socket auth sync failed', ErrorCodes.AuthenticationFailed);
                }

                if (!credential || response.uid === 'anon') {
                    this.authToken = undefined;
                    this.userId = undefined;
                    this.authTicket = undefined;
                    await this.updateSocketIdentity('anon');
                    return;
                }
        
                this.consumeAuthTicket()
                this.currentProfile = response.profile

                this.setAuthSession({
                    uid: response.uid,
                    accessToken: response.token,
                    refreshToken: this.authSession?.refreshToken ?? null,
                    provider: this.authSession?.provider,
                    email: this.currentProfile?.email ?? this.authSession?.email ?? null,
                    emailVerified: typeof (this.currentProfile as any)?.email_verified === 'boolean'
                        ? (this.currentProfile as any).email_verified
                        : this.authSession?.emailVerified,
                }, 'syncSocketAuth.ticket_or_token');

                await this.updateSocketIdentity(response.uid);
                

            } finally {
                this.socketAuthSyncPromise = undefined;
            }
            
        })();

        return this.socketAuthSyncPromise;
    }

    protected override async beforeActivateSubscription(_entry: any): Promise<void> {
        if (!this.isConnected) return;
        if (this.socketAuthUid !== 'anon') return;

        // Ticket-first: authenticate socket before any subscription activation.
        if (this.authSession?.accessToken || this.getAuthTicket()) {
            await this.syncSocketAuth(this.authSession?.accessToken ?? null).catch(() => undefined);
            if (this.socketAuthUid !== 'anon') return;
        }

        // Fallback for existing cookie-session flow.
        const upgraded = await this.ensureSessionForSocketAuth('beforeActivateSubscription');
        if (!upgraded) return;

        if (this.authSession?.accessToken && this.socketAuthUid === 'anon') {
            await this.syncSocketAuth(this.authSession.accessToken).catch(() => undefined);
        }
    }


    /**
     * Fetch a fresh one-time WebSocket ticket from the server.
     * Called on reconnect when neither an access token nor a cached ticket exists.
     * Requires `config.ticketRefreshUrl` to be configured.
     */
    protected async fetchFreshTicket(): Promise<string | null> {

        try{
            const base = this.getHttpBase();
            const qs = new URLSearchParams({ appId: this.config.appId });
            if (this.config.apiKey) qs.set('apiKey', this.config.apiKey);
            const urlStr = `${base}/ticket?${qs.toString()}`;
            const trace = await this.timedFetch('fetchFreshTicket', urlStr, {
                method: 'GET',
                credentials: 'include',
                headers: this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {},
            });

            const json = await this.parseJsonWithTiming('fetchFreshTicket', trace) as Record<string, unknown>;
            if (!trace.response.ok) {
                this.throwFetchFlareError(json, 'Failed to fetch fresh ticket', ErrorCodes.QueryFailed);
            }

            this.authTicket = json.ticket as string;

            return json.ticket as string;
        }
        catch(err){
            this.log('Error fetching fresh ticket', err);
            return null;
        }
    }


    protected override onConnected() {
        super.onConnected();

        // Do not trigger refresh on connect. Use access token if present,
        // otherwise consume one-time ticket when available.
        if (this.authSession?.accessToken || this.getAuthTicket()) {
            this.syncSocketAuth(this.authSession?.accessToken ?? null).catch((err) => {
                this.log('Socket auth sync failed after connect', err);
            });
        }
    }

    // PUSH_NOTIFICATIONS

    private toUint8ArrayFromBase64Url(value: string): Uint8Array {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        const padding = '='.repeat((4 - normalized.length % 4) % 4);
        const base64 = normalized + padding;
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let idx = 0; idx < raw.length; idx += 1) {
            out[idx] = raw.charCodeAt(idx);
        }
        return out;
    }

    private encodePushTokenFromSubscription(subscription: PushSubscription): string {
        const json = subscription.toJSON() as {
            endpoint?: string;
            keys?: { p256dh?: string; auth?: string };
        };
        const endpoint = String(json.endpoint ?? '').trim();
        const p256dh = String(json.keys?.p256dh ?? '').trim();
        const auth = String(json.keys?.auth ?? '').trim();
        const tokenPayload = JSON.stringify({ endpoint, p256dh, auth });
        return `webpush:${btoa(tokenPayload)}`;
    }

    private async fetchPushSetupConfig(): Promise<{ vapidPublicKey: string; serviceWorkerPath: string }> {

        const base = this.getHttpBase();
        const qs = new URLSearchParams({ appId: this.config.appId });
        if (this.config.apiKey) qs.set('apiKey', this.config.apiKey);
        const urlStr = `${base}/push/config?${qs.toString()}`;
        const trace = await this.timedFetch('fetchPushSetupConfig', urlStr, {
            method: 'GET',
            credentials: 'include',
            headers: this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {},
        });

        const json = await this.parseJsonWithTiming('fetchPushSetupConfig', trace) as Record<string, unknown>;
        if (!trace.response.ok) {
            this.throwFetchFlareError(json, 'Failed to fetch push setup config', ErrorCodes.QueryFailed);
        }

        const vapidPublicKey = String(json.vapidPublicKey ?? '').trim();
        let serviceWorkerPath = String(json.serviceWorkerPath ?? '').trim();

        // When the app uses an HTTP proxy base (e.g. /api/flare), keep push SW
        // under that same base instead of requesting from site root.
        if (serviceWorkerPath.startsWith('/')) {
            try {
                const baseUrl = new URL(base, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
                const basePath = baseUrl.pathname.replace(/\/+$/, '');
                if (basePath && basePath !== '/' && !serviceWorkerPath.startsWith(`${basePath}/`)) {
                    serviceWorkerPath = `${basePath}${serviceWorkerPath}`;
                }
            } catch {
                // Keep original path when base URL parsing fails.
            }
        }

        if (!vapidPublicKey || !serviceWorkerPath) {
            throw new FlareError('Push setup response is missing vapidPublicKey or serviceWorkerPath', ErrorCodes.ParseError, json);
        }

        return { vapidPublicKey, serviceWorkerPath };
    }

    async setupPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {

        if (typeof window === 'undefined' || typeof navigator === 'undefined') {
            return null;
        }
        if (!('serviceWorker' in navigator)) {
            return null;
        }

        if (!this.pushServiceWorkerInitPromise) {
            this.pushServiceWorkerInitPromise = (async () => {
                const config = await this.fetchPushSetupConfig();
                const swUrl = new URL(config.serviceWorkerPath, window.location.origin);
                if (swUrl.origin !== window.location.origin) {
                    throw new FlareError('Service worker URL must be same-origin with the app', ErrorCodes.WriteFailed);
                }
                swUrl.searchParams.set('v', this.config.appVersion ?? '1');
                // Derive scope from the SW file's own directory. Push workers
                // receive push events regardless of scope, so root scope is not
                // required and the browser rejects scopes broader than the SW path.
                const swScope = swUrl.pathname.replace(/\/[^/]*$/, '/') || '/';
                const registration = await navigator.serviceWorker.register(swUrl.pathname + swUrl.search, { scope: swScope });
                return registration;
            })().catch((err) => {
                this.log('Push service worker setup failed', err);
                throw err;
            });
        }

        return this.pushServiceWorkerInitPromise;
    }

    async requestPushPermission(): Promise<NotificationPermission> {
        if (typeof window === 'undefined' || typeof Notification === 'undefined') {
            throw new FlareError('Push permission can only be requested in browser runtime', ErrorCodes.WriteFailed);
        }
        // Already granted — skip the prompt entirely to avoid spurious auth-state changes.
        if (Notification.permission === 'granted') {
            return 'granted';
        }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            throw new FlareError(`Push permission is ${permission}`, ErrorCodes.PermissionDenied);
        }
        return permission;
    }

    async acquireBrowserPushToken(options: BrowserPushTokenOptions = {}): Promise<{ token: string; subscription: PushSubscription }> {
        if (typeof window === 'undefined' || typeof navigator === 'undefined') {
            throw new FlareError('Push token acquisition can only run in browser runtime', ErrorCodes.WriteFailed);
        }
        if (!('serviceWorker' in navigator)) {
            throw new FlareError('Service worker is not supported in this browser', ErrorCodes.WriteFailed);
        }
        if (!('PushManager' in window)) {
            throw new FlareError('Push manager is not supported in this browser', ErrorCodes.WriteFailed);
        }

        await this.requestPushPermission();

        const setupConfig = !options.applicationServerKey
            ? await this.fetchPushSetupConfig()
            : null;

        const registration = options.serviceWorkerRegistration
            ?? await this.setupPushServiceWorker()
            ?? await navigator.serviceWorker.ready;

        let subscription = options.subscription
            ?? await registration.pushManager.getSubscription();

        if (options.forceResubscribe && subscription) {
            await subscription.unsubscribe().catch(() => undefined);
            subscription = null;
        }

        if (!subscription) {
            const vapidPublicKey = options.applicationServerKey ?? setupConfig?.vapidPublicKey;
            if (!vapidPublicKey) {
                throw new FlareError('No VAPID public key available for push subscription', ErrorCodes.WriteFailed);
            }

            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: this.toUint8ArrayFromBase64Url(vapidPublicKey) as unknown as BufferSource,
            });
        }

        
        const token = this.encodePushTokenFromSubscription(subscription);
        // console.log('Acquired push subscription', subscription, token); // --- IGNORE ---

        return { token, subscription };
    }

    async enableBrowserPush(options: BrowserPushRegistrationOptions = {}): Promise<{ registered: boolean; appId: string; uid: string; token: string; platform?: string; subscription: PushSubscription }> {
        const { token, subscription } = await this.acquireBrowserPushToken(options);
        const result = await this.registerPushToken({
            token,
            platform: options.platform ?? 'web',
            deviceId: options.deviceId,
            topics: options.topics,
            authAppId: options.authAppId,
        });
        return {
            ...result,
            subscription,
        };
    }

    async registerPushToken(input: RegisterPushTokenInput): Promise<{ registered: boolean; appId: string; uid: string; token: string; platform?: string }> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();

        const token = String(input.token ?? '').trim();
        if (!token) {
            throw new FlareError('Push token is required', ErrorCodes.WriteFailed);
        }

        const trace = await this.timedFetch('registerPushToken', `${base}/notify/token?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...this.getCsrfHeaders(),
                ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}),
                ...(this.authSession?.accessToken ? { Authorization: `Bearer ${this.authSession.accessToken}` } : {}),
            },
            body: JSON.stringify({
                appId: this.config.appId,
                token,
                platform: input.platform,
                deviceId: input.deviceId,
                topics: input.topics,
                ...(input.authAppId ? { authAppId: input.authAppId } : {}),
            }),
        });

        const json = await this.parseJsonWithTiming('registerPushToken', trace) as Record<string, unknown>;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Failed to register push token', ErrorCodes.WriteFailed);
        return {
            registered: Boolean(json.registered),
            appId: String(json.appId ?? this.config.appId),
            uid: String(json.uid ?? this.authSession?.uid ?? ''),
            token: String(json.token ?? token),
            ...(typeof json.platform === 'string' ? { platform: json.platform } : {}),
        };
    }

    async unregisterPushToken(token: string, authAppId?: string): Promise<{ unregistered: boolean; appId: string; token: string; removed: boolean }> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();

        const normalizedToken = String(token ?? '').trim();
        if (!normalizedToken) {
            throw new FlareError('Push token is required', ErrorCodes.WriteFailed);
        }

        const trace = await this.timedFetch('unregisterPushToken', `${base}/notify/token?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'DELETE',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...this.getCsrfHeaders(),
                ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}),
                ...(this.authSession?.accessToken ? { Authorization: `Bearer ${this.authSession.accessToken}` } : {}),
            },
            body: JSON.stringify({
                appId: this.config.appId,
                token: normalizedToken,
                ...(authAppId ? { authAppId } : {}),
            }),
        });

        const json = await this.parseJsonWithTiming('unregisterPushToken', trace) as Record<string, unknown>;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Failed to unregister push token', ErrorCodes.WriteFailed);
        return {
            unregistered: Boolean(json.unregistered),
            appId: String(json.appId ?? this.config.appId),
            token: String(json.token ?? normalizedToken),
            removed: Boolean(json.removed),
        };
    }

    async sendPushNotification(input: SendPushNotificationInput): Promise<PushSendResult> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();

        const trace = await this.timedFetch('sendPushNotification', `${base}/system/apps/${encodeURIComponent(this.config.appId)}/notifications/send`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...this.getCsrfHeaders(),
                ...(this.authSession?.accessToken ? { Authorization: `Bearer ${this.authSession.accessToken}` } : {}),
                ...(input.authAppId ? { 'x-flare-auth-app-id': input.authAppId } : {}),
            },
            body: JSON.stringify({
                ...input,
                appId: this.config.appId,
            }),
        });

        const json = await this.parseJsonWithTiming('sendPushNotification', trace) as Record<string, unknown>;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Failed to send push notification', ErrorCodes.WriteFailed);
        return {
            sent: Boolean(json.sent),
            appId: String(json.appId ?? this.config.appId),
            targetCount: Number(json.targetCount ?? 0),
            successCount: Number(json.successCount ?? 0),
            failureCount: Number(json.failureCount ?? 0),
            invalidatedTokenCount: Number(json.invalidatedTokenCount ?? 0),
            dryRun: Boolean(json.dryRun),
        };
    }

    // S3-compatible Storage service
    /**
     * Returns the S3-compatible storage service for this app.
     *
     * Works with bucket **names** — no serverId needed.
     * Buckets are created automatically on `putObject()` if they don't exist yet.
     *
     * @example
     * const s = app.storage();
     * await s.putObject({ bucket: 'avatars', key: 'alice.png', body: file });
     * const { contentBase64 } = await s.getObject({ bucket: 'avatars', key: 'alice.png' });
     */
    storage(): FlareStorage {
        if (!this._storageService) {
            this._storageService = new FlareStorage(this._buildStorageTransport());
        }
        return this._storageService;
    }

    private _buildStorageTransport(): FlareStorageTransport {
        const self = this;

        function withAppCredentials(path: string): string {
            const hasQuery = path.includes('?');
            const params = new URLSearchParams();
            params.set('appId', self.config.appId);
            if (self.config.apiKey) params.set('apiKey', self.config.apiKey);
            return `${path}${hasQuery ? '&' : '?'}${params.toString()}`;
        }

        async function ensureSocketConnected(timeoutMs = 8000): Promise<void> {
            if (self.isConnected) return;
            self.connect();
            await new Promise<void>((resolve, reject) => {
                if (self.isConnected) {
                    resolve();
                    return;
                }
                const off = self.onConnectionStateChange((state) => {
                    if (state === 'connected') {
                        clearTimeout(timer);
                        off();
                        resolve();
                    }
                });
                const timer = setTimeout(() => {
                    off();
                    reject(new FlareError('Storage bucket metadata requires an active socket connection', ErrorCodes.QueryFailed));
                }, timeoutMs);
            });
        }

        async function doSocketCall(topic: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
            await ensureSocketConnected();

            if (self.socketAuthUid === 'anon') {
                if (self.authSession?.accessToken || self.getAuthTicket()) {
                    await self.syncSocketAuth(self.authSession?.accessToken ?? null).catch(() => undefined);
                }

                if (self.socketAuthUid === 'anon') {
                    const upgraded = await self.ensureSessionForSocketAuth(`storage:${topic}`).catch(() => false);
                    if (upgraded && self.authSession?.accessToken) {
                        await self.syncSocketAuth(self.authSession.accessToken).catch(() => undefined);
                    }
                }
            }

            if (self.socketAuthUid === 'anon') {
                throw new FlareError('Storage operations require an authenticated socket session', ErrorCodes.AuthenticationFailed);
            }

            const data = await self.call<Record<string, unknown>>(topic, payload);
            return (data ?? {}) as Record<string, unknown>;
        }

        function decodeJwtPayload(token: string): Record<string, unknown> | null {
            try {
                const parts = token.split('.');
                if (parts.length < 2) return null;
                const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);

                if (typeof atob === 'function') {
                    return JSON.parse(atob(padded)) as Record<string, unknown>;
                }

                const fromBuffer = (globalThis as any)?.Buffer;
                if (fromBuffer) {
                    return JSON.parse(fromBuffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
                }

                return null;
            } catch {
                return null;
            }
        }

        function hasSessionIdClaim(token: string | null | undefined): boolean {
            if (!token) return false;
            const payload = decodeJwtPayload(token);
            const sid = payload?.sid;
            return typeof sid === 'string' && sid.trim().length > 0;
        }

        function storageBearerToken(): string | null {
            const memoryToken = self.authSession?.accessToken;
            if (hasSessionIdClaim(memoryToken)) return memoryToken!;

            // Storage system routes require bearer auth in headers.
            // In proxy mode, fall back to app access-token cookie.
            const cookieTokenName =
                self.authConfig?.cookie?.accessTokenName
                ?? `__flare_at_${self.config.appId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

            const cookieToken = getCookie(cookieTokenName);
            if (hasSessionIdClaim(cookieToken)) return cookieToken;

            return null;
        }

        function storageAuthHeaders(): Record<string, string> {
            const token = storageBearerToken();

            return {
                ...self.getCsrfHeaders(),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            };
        }

        function isSessionExpiredPayload(json: Record<string, unknown>, status: number): boolean {
            if (status !== 401) return false;
            const err = String(json.error ?? '').toLowerCase();
            return err === 'session_expired' || err === 'invalid_token' || err === 'missing_token';
        }

        async function refreshStorageSessionOnce(): Promise<boolean> {
            const refreshed = await self.refreshAuthSession().catch(() => null);
            return Boolean(refreshed?.accessToken);
        }

        async function doAuthPost(label: string, url: string, body: unknown): Promise<Record<string, unknown>> {
            const base = self.getHttpBase();
            await self.ensureCsrfProtection();
            const request = async () => {
                const trace = await self.timedFetch(label, `${base}${withAppCredentials(url)}`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        ...storageAuthHeaders(),
                    },
                    body: body !== null ? JSON.stringify(body) : undefined,
                });
                const json = await self.parseJsonWithTiming(label, trace) as Record<string, unknown>;
                return { trace, json };
            };

            let { trace, json } = await request();
            if (!trace.response.ok && isSessionExpiredPayload(json, trace.response.status)) {
                const refreshed = await refreshStorageSessionOnce();
                if (refreshed) {
                    const retried = await request();
                    trace = retried.trace;
                    json = retried.json;
                }
            }

            if (!trace.response.ok) self.throwFetchFlareError(json, `Storage ${label} failed`, ErrorCodes.WriteFailed);
            return json;
        }

        async function doAuthGet(label: string, url: string): Promise<Record<string, unknown>> {
            const base = self.getHttpBase();
            await self.ensureCsrfProtection();
            const request = async () => {
                const trace = await self.timedFetch(label, `${base}${withAppCredentials(url)}`, {
                    method: 'GET',
                    credentials: 'include',
                    headers: storageAuthHeaders(),
                });
                const json = await self.parseJsonWithTiming(label, trace) as Record<string, unknown>;
                return { trace, json };
            };

            let { trace, json } = await request();
            if (!trace.response.ok && isSessionExpiredPayload(json, trace.response.status)) {
                const refreshed = await refreshStorageSessionOnce();
                if (refreshed) {
                    const retried = await request();
                    trace = retried.trace;
                    json = retried.json;
                }
            }

            if (!trace.response.ok) self.throwFetchFlareError(json, `Storage ${label} failed`, ErrorCodes.QueryFailed);
            return json;
        }

        async function doPostWithProgress(
            label: string,
            url: string,
            body: unknown,
            onProgress: (p: StorageProgress) => void,
        ): Promise<Record<string, unknown>> {
            // XHR for browser upload progress; fall back to fetch in non-browser.
            if (typeof XMLHttpRequest === 'undefined') {
                return doAuthPost(label, url, body);
            }
            const base = self.getHttpBase();
            await self.ensureCsrfProtection();
            const bodyStr = JSON.stringify(body);
            return new Promise((resolve, reject) => {
                const total = new TextEncoder().encode(bodyStr).length;

                const sendAttempt = (attempt: number) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', `${base}${withAppCredentials(url)}`);
                    xhr.withCredentials = true;
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    for (const [k, v] of Object.entries(storageAuthHeaders())) xhr.setRequestHeader(k, v);

                    xhr.upload.onprogress = (e) => {
                        const loaded = e.lengthComputable ? e.loaded : 0;
                        const tot = e.lengthComputable ? e.total : total;
                        onProgress({ loaded, total: tot, percent: tot > 0 ? Math.round((loaded / tot) * 100) : 0 });
                    };

                    xhr.onload = () => {
                        let json: Record<string, unknown> = {};
                        try {
                            json = xhr.responseText ? (JSON.parse(xhr.responseText) as Record<string, unknown>) : {};
                        } catch {
                            reject(new FlareError('Failed to parse storage response', ErrorCodes.WriteFailed));
                            return;
                        }

                        if (xhr.status >= 400) {
                            if (attempt === 0 && isSessionExpiredPayload(json, xhr.status)) {
                                refreshStorageSessionOnce()
                                    .then((refreshed) => {
                                        if (refreshed) {
                                            sendAttempt(1);
                                        } else {
                                            const msg = String(json['error_description'] ?? json['message'] ?? json['error'] ?? `HTTP ${xhr.status}`);
                                            reject(new FlareError(msg, ErrorCodes.WriteFailed));
                                        }
                                    })
                                    .catch(() => {
                                        const msg = String(json['error_description'] ?? json['message'] ?? json['error'] ?? `HTTP ${xhr.status}`);
                                        reject(new FlareError(msg, ErrorCodes.WriteFailed));
                                    });
                                return;
                            }

                            const msg = String(json['error_description'] ?? json['message'] ?? json['error'] ?? `HTTP ${xhr.status}`);
                            reject(new FlareError(msg, ErrorCodes.WriteFailed));
                            return;
                        }

                        onProgress({ loaded: total, total, percent: 100 });
                        resolve(json);
                    };

                    xhr.onerror = () => reject(new FlareError('Network error during storage upload', ErrorCodes.WriteFailed));
                    xhr.send(bodyStr);
                };

                sendAttempt(0);
            });
        }

        return {
            appId: this.config.appId,
            get storageRulesHomeBucket() {
                return self.authConfig?.storageRulesHomeBucket ?? undefined;
            },
            transferManager: (typeof this.config.storage === 'object' && this.config.storage?.transferManager)
                ? (this.config.storage.transferManager as FlareStorageTransferManagerConfig)
                : undefined,
            call: (topic, payload) => doSocketCall(topic, payload),
            subscribe: (subId, collection, docId, query, callback, options) =>
                self.subscribe(subId, collection, docId, query as any, callback as any, options ?? {}),
            doPost: (label, path, body) => doAuthPost(label, path, body),
            doGet: (label, path) => doAuthGet(label, path),
            doPostWithProgress,
        };
    }

    // Direct storage method proxies (app.putObject, app.getObject, …)

    /** @see FlareStorage.putObject */
    putObject(input: PutObjectInput): Promise<PutObjectResult> { return this.storage().putObject(input); }
    /** @see FlareStorage.getObject */
    getObject(input: GetObjectInput): Promise<GetObjectResult> { return this.storage().getObject(input); }
    /** @see FlareStorage.getObjectUrl */
    getObjectUrl(input: GetObjectUrlInput): Promise<string> { return this.storage().getObjectUrl(input); }
    /** @see FlareStorage.downloadObject */
    downloadObject(input: DownloadObjectInput): Promise<DownloadObjectResult> { return this.storage().downloadObject(input); }
    /** @see FlareStorage.headObject */
    headObject(input: HeadObjectInput): Promise<StorageObjectMeta> { return this.storage().headObject(input); }
    /** @see FlareStorage.headObjects */
    headObjects(input: HeadObjectsInput): Promise<StorageObjectMeta[]> { return this.storage().headObjects(input); }
    /** @see FlareStorage.listObjects */
    listObjects(input: ListObjectsInput): Promise<ListObjectsResult> { return this.storage().listObjects(input); }
    /** @see FlareStorage.copyObject */
    copyObject(input: CopyObjectInput): Promise<{ ok: boolean }> { return this.storage().copyObject(input); }
    /** @see FlareStorage.copyObjects */
    copyObjects(inputs: CopyObjectInput[]): Promise<{ ok: boolean; errors: Record<string, string> }> { return this.storage().copyObjects(inputs); }
    /** @see FlareStorage.deleteObject */
    deleteObject(input: DeleteObjectInput): Promise<{ ok: boolean }> { return this.storage().deleteObject(input); }
    /** @see FlareStorage.deleteObjects */
    deleteObjects(input: DeleteObjectsInput): Promise<{ ok: boolean; deleted: string[]; errors: Record<string, string> }> { return this.storage().deleteObjects(input); }
    /** @see FlareStorage.createBucket */
    createBucket(name: string, options?: StorageBucketInput): Promise<StorageBucket> { return this.storage().createBucket(name, options); }
    /** @see FlareStorage.listBuckets */
    listBuckets(): Promise<StorageBucket[]> { return this.storage().listBuckets(); }
    /** @see FlareStorage.deleteBucket */
    deleteBucket(name: string): Promise<{ ok: boolean; removedObjects: number }> { return this.storage().deleteBucket(name); }
    /** @see FlareStorage.deleteBuckets */
    deleteBuckets(names: string[]): Promise<{ ok: boolean; deleted: string[]; errors: Record<string, string> }> { return this.storage().deleteBuckets(names); }
    /** @see FlareStorage.getBucketLocation */
    getBucketLocation(name: string): Promise<{ bucket: string; kind: string; region?: string; endpoint?: string }> { return this.storage().getBucketLocation(name); }
    /** @see FlareStorage.createSignedUrl */
    createSignedUrl(input: StorageSignedUrlInput): Promise<FlareStorageSignedUrlResult> {
        return this.storage().createSignedUrl(input);
    }



    async auth(token: string): Promise<AuthResult> {
        const response = await this.send(FlareAction.AUTH, { token });
        if (response.type === FlareEvent.AUTH_OK) {
            const activeToken = response.token ?? token;
            this.authToken = activeToken;
            this.userId = response.uid;
            const profile = await this.fetchAuthMe(activeToken).catch(() => null);
            // console.log(`--profile`, profile)
            this.setAuthSession({
                uid: response.uid ?? response.id,
                accessToken: activeToken,
                refreshToken: this.authSession?.refreshToken ?? null,
                email: profile?.email ?? null,
                emailVerified: profile?.email_verified,
            });
            await this.updateSocketIdentity(response.uid);
            this.log('Authentication successful', response.uid);
            return { uid: response.uid, token: response.token ?? token };
        }
        throw new FlareError('Authentication failed', ErrorCodes.AuthenticationFailed);
    }


    private getAuthRequestContentType(): 'application/x-www-form-urlencoded' | 'application/json' {
        return this.config.authRequestContentType ?? 'application/json';
    }

    private buildAuthRequestBody(fields: Record<string, string | undefined>): {
        contentType: 'application/x-www-form-urlencoded' | 'application/json';
        body: string;
    } {
        const contentType = this.getAuthRequestContentType();
        if (contentType === 'application/json') {
            const payload: Record<string, string> = {};
            for (const [key, value] of Object.entries(fields)) {
                if (value !== undefined) payload[key] = value;
            }
            return { contentType, body: JSON.stringify(payload) };
        }

        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined) form.set(key, value);
        }
        return { contentType, body: form.toString() };
    }

    // Email / password
    protected async requestEmailPasswordToken(email: string, password: string, scope?: string[]): Promise<AuthToken & { kind: string }> {
        if (typeof process !== 'undefined' && process.versions?.node && this.config.grpcUrl && this.config.transport !== 'ws' && this.config.transport !== 'http') {
            try {
                const { runGrpcLogin } = await runtimeImport('./grpc') as typeof import('./grpc');
                const grpcResult = await runGrpcLogin(this.config, email, password);
                if (grpcResult) {
                    return {
                        kind: 'response.ok',
                        access_token: grpcResult.token,
                        refresh_token: grpcResult.refreshToken,
                        expires_in: null,
                        token_type: 'Bearer',
                        scope: scope?.join(' ') ?? null,
                        profile: null,
                        provider: 'credentials' as ProviderId,
                    };
                }
            } catch (err) {
                this.log('gRPC auth login fallback to HTTP', err);
            }
        }

        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        const { contentType, body } = this.buildAuthRequestBody({
            appId: this.config.appId,
            client_id: this.config.apiKey ?? '',
            grant_type: 'password',
            email,
            password,
            scope: scope?.length ? scope.join(' ') : undefined,
        });
        const trace = await this.timedFetch('requestEmailPasswordToken', `${base}/auth/token?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': contentType, ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body,
        });
        const json = await this.parseJsonWithTiming('requestEmailPasswordToken', trace) as Record<string, unknown>;
        const hasAuthErrorPayload = typeof json.error === 'string' && json.error.trim().length > 0;
        if (!trace.response.ok || hasAuthErrorPayload) {
            this.throwFetchFlareError(json, 'Sign-in with email/password failed', ErrorCodes.AuthenticationFailed);
        }
        const kind = typeof json.kind === 'string' && json.kind.trim().length > 0 ? json.kind : 'response.ok';
        return {
            kind,
            access_token: String(json.access_token ?? ''),
            refresh_token: json.refresh_token ? String(json.refresh_token) : null,
            expires_in: json.expires_in ? Number(json.expires_in) : null,
            token_type: String(json.token_type ?? 'Bearer'),
            scope: json.scope ? String(json.scope) : null,
            profile: null,
            provider: 'credentials' as ProviderId,
        };
    }
    
    async signInWithEmailAndPassword(
        email: string,
        password: string,
        options?: { scope?: string[]; createIfMissing?: boolean },
    ): Promise<AuthResult & { kind?: string; accessToken: string; refreshToken: string | null; authToken: AuthToken; created?: boolean }> {

        // console.log(`Attempting sign-in with email: ${email}, options:`, options);
        try {
            const authToken = await this.requestEmailPasswordToken(email, password, options?.scope);
            const result = await this.auth(authToken.access_token);
            const profile = await this.fetchAuthMe(authToken.access_token).catch(() => null);
            this.setAuthSession({
                uid: result.uid,
                accessToken: authToken.access_token,
                refreshToken: authToken.refresh_token,
                provider: authToken.provider,
                email: profile?.email ?? email,
                emailVerified: profile?.email_verified,
            });
            this.log('Credentials sign-in successful', result.uid);
            return { ...result, kind: authToken.kind, accessToken: authToken.access_token, refreshToken: authToken.refresh_token, authToken };
        } catch (err: any) {
            const isNotFound = /invalid_email|user.not.found|no user/i.test(err?.message ?? '');

            // console.log(`FlareError during signInWithEmailAndPassword:`, err, err.message);

            if (options?.createIfMissing && isNotFound) {
                const created = await this.createUserWithEmail(email, password, { scope: options.scope, signInIfAllowed: true });
                if (created.verification_required) {
                    throw new FlareError('Email verification required before sign-in', ErrorCodes.AuthenticationFailed);
                }
                return {
                    uid: created.uid,
                    token: created.token,
                    accessToken: created.accessToken,
                    refreshToken: created.refreshToken,
                    authToken: created.authToken,
                    created: true,
                };
            }
            if (err instanceof FlareError) throw err;

            // console.log(`Error during signInWithEmailAndPassword for email ${email}:`, err instanceof Error ? err.message : 'Sign-in with email/password failed', err.error ??  err.code ?? ErrorCodes.AuthenticationFailed, err);

            // throw new FlareError(err instanceof Error ? err.message : 'Sign-in with email/password failed', err.error ??  err.code ?? ErrorCodes.AuthenticationFailed, err);
            throw new FlareError(
                err.message ?? 'Sign-in with email/password failed', 
                err.error ??  err.code ?? ErrorCodes.AuthenticationFailed, 
                err
            );
        }
    }

    async signInWithEmail(email: string, password: string, options?: { scope?: string[]; createIfMissing?: boolean }) {
        return this.signInWithEmailAndPassword(email, password, options);
    }

    async createUserWithEmail(
        email: string,
        password: string,
        options?: { scope?: string[]; additionalParams?: Record<string, string>; signInIfAllowed?: boolean },
    ): Promise<
        | {
            kind?: string;
            verificationRequired: true;
            verification_required: true;
            emailSent: boolean;
            email_sent: boolean;
            message?: string;
            preview?: { code: string; link: string };
        }
        | (AuthResult & {
            kind?: string;
            accessToken: string;
            access_token: string;
            token_type: string;
            expires_in: number;
            refreshToken: string | null;
            refresh_token: string | null;
            scope: string;
            expires_at: string | number;
            sid: string;
            authToken: AuthToken;
            auth_token: AuthToken;
            verificationRequired: false;
            verification_required: false;
            emailSent: boolean;
            email_sent: boolean;
            preview?: { code: string; link: string };
        })
    > {
        const response = await this.registerWithEmail(email, password, options);
        if (response.verification_required) {
            return {
                kind: response.kind,
                verificationRequired: true,
                verification_required: true,
                emailSent: Boolean(response.email_sent),
                email_sent: Boolean(response.email_sent),
                message: typeof response.message === 'string' ? response.message : undefined,
                preview: response.preview,
            };
        }
        const accessToken = String(response.access_token ?? '');
        if (!accessToken) {
            throw new FlareError('User created but no access token returned', ErrorCodes.AuthenticationFailed);
        }
        const authToken = {
            access_token: accessToken,
            refresh_token: response.refresh_token ? String(response.refresh_token) : null,
            expires_in: response.expires_in ? Number(response.expires_in) : null,
            token_type: String(response.token_type ?? 'Bearer'),
            scope: response.scope ? String(response.scope) : null,
            profile: null,
            provider: 'credentials' as ProviderId,
        } as AuthToken;
        const result = await this.auth(accessToken);
        const profile = await this.fetchAuthMe(accessToken).catch(() => null);
        this.setAuthSession({
            uid: result.uid,
            accessToken,
            refreshToken: authToken.refresh_token,
            provider: 'credentials',
            email: profile?.email ?? email,
            emailVerified: profile?.email_verified,
        });
        // access_token: string;
        // token_type: string;
        //         expires_in: number;
        //         refresh_token: string; 
        //         scope: string;
        //         expires_at: number;
        //         sid: string;
        //         auth_token: AuthToken; 
        //         verification_required?: false; 
        //         email_sent?: boolean; 
        return { 
            ...result, 
            kind: typeof response.kind === 'string' ? response.kind : undefined,
            accessToken,
            access_token: accessToken,
            token_type: authToken.token_type,
            expires_in: authToken.expires_in!,
            refreshToken: authToken.refresh_token,
            refresh_token: authToken.refresh_token!,
            scope: authToken.scope!,
            expires_at: response.expires_at!,
            sid: response.sid!,
            authToken: authToken,
            auth_token: authToken,
            verificationRequired: false,
            verification_required: false,
            emailSent: Boolean(response.email_sent),
            email_sent: Boolean(response.email_sent),
            preview: response.preview
        };
    }

    async createUserWithEmailAndPassword(
        email: string,
        password: string,
        options?: { scope?: string[]; additionalParams?: Record<string, string>; signInIfAllowed?: boolean },
    ) {
        return this.createUserWithEmail(email, password, options);
    }

    async signInOrCreateWithEmail(
        email: string,
        password: string,
        options?: { scope?: string[]; additionalParams?: Record<string, string> },
    ): Promise<
        | { kind?: string; verificationRequired: true; created: true; emailSent: boolean; preview?: { code: string; link: string } }
        | (AuthResult & { accessToken: string; refreshToken: string | null; authToken: AuthToken; created: boolean })
    > {
        try {
            const signedIn = await this.signInWithEmailAndPassword(email, password, { scope: options?.scope });
            return { ...signedIn, created: false };
        } catch (err: any) {
            const isNotFound = /invalid_email|user.not.found|no user/i.test(err?.message ?? '');
            if (!isNotFound) throw err;
            const created = await this.createUserWithEmail(email, password, {
                scope: options?.scope,
                additionalParams: options?.additionalParams,
                signInIfAllowed: true,
            });
            if (created.verification_required) {
                return {
                    kind: created.kind,
                    verificationRequired: true,
                    created: true,
                    emailSent: created.emailSent,
                    preview: created.preview,
                };
            }
            return {
                uid: created.uid,
                token: created.token,
                accessToken: created.accessToken,
                refreshToken: created.refreshToken,
                authToken: created.authToken,
                created: true,
            };
        }
    }

    async signInOrCreateWithEmailAndPassword(
        email: string,
        password: string,
        options?: { scope?: string[]; additionalParams?: Record<string, string> },
    ) {
        return this.signInOrCreateWithEmail(email, password, options);
    }

    // Email verification
    async sendEmailVerification(email: string): Promise<{ sent: boolean; emailSent: boolean; preview?: { code: string; link: string } }> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        const trace = await this.timedFetch('sendEmailVerification', `${base}/auth/verify/send?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body: JSON.stringify({ email, appId: this.config.appId, apiKey: this.config.apiKey }),
        });
        const json = await this.parseJsonWithTiming('sendEmailVerification', trace) as any;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Failed to send verification email', ErrorCodes.AuthenticationFailed);
        return json;
    }

    async verifyEmailWithCode(email: string, code: string): Promise<{ verified: boolean; email: string }> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        const trace = await this.timedFetch('verifyEmailWithCode', `${base}/auth/verify/confirm?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body: JSON.stringify({ email, code, appId: this.config.appId, apiKey: this.config.apiKey }),
        });
        const json = await this.parseJsonWithTiming('verifyEmailWithCode', trace) as any;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Email verification failed', ErrorCodes.AuthenticationFailed);
        return json;
    }

    async confirmEmailLink(token: string, email: string): Promise<{ verified: boolean; email: string }> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        const trace = await this.timedFetch('confirmEmailLink', `${base}/auth/verify/confirm?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body: JSON.stringify({ token, email, appId: this.config.appId, apiKey: this.config.apiKey }),
        });
        const json = await this.parseJsonWithTiming('confirmEmailLink', trace) as any;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Email link verification failed', ErrorCodes.AuthenticationFailed);
        return json;
    }

    // Account recovery
    async sendAccountRecovery(email: string): Promise<{ kind?: string; sent: boolean; emailSent?: boolean; preview?: { code: string; token: string } }> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        const trace = await this.timedFetch('sendAccountRecovery', `${base}/auth/recover/send?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body: JSON.stringify({ email, appId: this.config.appId, apiKey: this.config.apiKey }),
        });
        const json = await this.parseJsonWithTiming('sendAccountRecovery', trace) as any;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Failed to send recovery email', ErrorCodes.AuthenticationFailed);
        return json;
    }

    async recoverAccountWithCode(email: string, code: string, newPassword: string): Promise<{ recovered: boolean; email: string; sessionsRevoked?: number }> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        const trace = await this.timedFetch('recoverAccountWithCode', `${base}/auth/recover/confirm?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body: JSON.stringify({ email, code, newPassword, appId: this.config.appId, apiKey: this.config.apiKey }),
        });
        const json = await this.parseJsonWithTiming('recoverAccountWithCode', trace) as any;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Account recovery failed', ErrorCodes.AuthenticationFailed);
        return json;
    }

    async recoverAccountWithToken(token: string, newPassword: string): Promise<{ recovered: boolean; email: string; sessionsRevoked?: number }> {
        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        const trace = await this.timedFetch('recoverAccountWithToken', `${base}/auth/recover/confirm?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body: JSON.stringify({ token, newPassword, appId: this.config.appId, apiKey: this.config.apiKey }),
        });
        const json = await this.parseJsonWithTiming('recoverAccountWithToken', trace) as any;
        if (!trace.response.ok) this.throwFetchFlareError(json, 'Account recovery failed', ErrorCodes.AuthenticationFailed);
        return json;
    }

    // OAuth
    async signIn(providerId: ProviderId, options?: { returnTo?: string; metaTag?: string }): Promise<any>;
    async signIn(authGuard: Pick<AuthGuard, 'signIn'>, providerId: ProviderId, options?: { returnTo?: string; metaTag?: string }): Promise<any>;
    async signIn(
        arg1: ProviderId | Pick<AuthGuard, 'signIn'>,
        arg2?: ProviderId | { returnTo?: string; metaTag?: string },
        arg3?: { returnTo?: string; metaTag?: string },
    ): Promise<any> {
        const hasExternalAuthGuard = typeof (arg1 as any)?.signIn === 'function';
        const authGuard = hasExternalAuthGuard ? arg1 as Pick<AuthGuard, 'signIn'> : await this.getAuthGuard();
        const providerId = hasExternalAuthGuard ? arg2 as ProviderId : arg1 as ProviderId;
        const options = hasExternalAuthGuard ? arg3 : arg2 as { returnTo?: string; metaTag?: string } | undefined;
        return authGuard.signIn(providerId, options);
    }

    async signInWithGoogle(options?: { returnTo?: string; metaTag?: string }) { return this.signIn('google', options); }
    async signInWithGitHub(options?: { returnTo?: string; metaTag?: string }) { return this.signIn('github', options); }
    async signInWithFacebook(options?: { returnTo?: string; metaTag?: string }) { return this.signIn('facebook', options); }
    async signInWithDropbox(options?: { returnTo?: string; metaTag?: string }) { return this.signIn('dropbox', options); }

    async handleSignInRedirect(autoRedirect?: boolean): Promise<(AuthResult & { authToken: AuthToken; provider?: ProviderId }) | null>;
    async handleSignInRedirect(authGuard: Pick<AuthGuard, 'handleRedirect'>, autoRedirect?: boolean): Promise<(AuthResult & { authToken: AuthToken; provider?: ProviderId }) | null>;
    async handleSignInRedirect(
        arg1?: boolean | Pick<AuthGuard, 'handleRedirect'>,
        arg2 = false,
    ): Promise<(AuthResult & { authToken: AuthToken; provider?: ProviderId }) | null> {
        const hasExternalAuthGuard = typeof (arg1 as any)?.handleRedirect === 'function';
        const authGuard = hasExternalAuthGuard ? arg1 as Pick<AuthGuard, 'handleRedirect'> : await this.getAuthGuard();
        const autoRedirect = hasExternalAuthGuard ? arg2 : (typeof arg1 === 'boolean' ? arg1 : false);
        const authToken = await authGuard.handleRedirect(autoRedirect);
        if (!authToken || !authToken.access_token || !authToken.provider) return null;
        const exchange = await this.exchangeProviderToken(authToken.provider as ProviderId, authToken.access_token);
        const result = await this.auth(exchange.token);
        const profile = await this.fetchAuthMe(exchange.token).catch(() => null);
        this.setAuthSession({
            uid: result.uid,
            accessToken: exchange.token,
            refreshToken: authToken.refresh_token,
            provider: authToken.provider,
            email: profile?.email ?? null,
            emailVerified: profile?.email_verified,
        });
        return { ...result, authToken, provider: authToken.provider as ProviderId };
    }

    private async exchangeProviderToken(provider: ProviderId, accessToken: string): Promise<{ token: string }> {
        const endpoint = `${this.getHttpBase()}/auth/exchange`;
        await this.ensureCsrfProtection();
        const trace = await this.timedFetch('exchangeProviderToken', endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...this.getCsrfHeaders() },
            body: JSON.stringify({ appId: this.config.appId, client_id: this.config.apiKey, provider, access_token: accessToken }),
        });
        const json = await this.parseJsonWithTiming('exchangeProviderToken', trace);
        if (!trace.response.ok) this.throwFetchFlareError(json, 'OAuth token exchange failed', ErrorCodes.AuthenticationFailed);
        if (!json?.token) throw new FlareError('OAuth token exchange failed', ErrorCodes.ParseError, json);
        return { token: String(json.token) };
    }

    protected async getAuthGuard(): Promise<AuthGuard> {
        if (this.authGuard) return this.authGuard;

        const config = await this.loadAuthConfig();
        if (!config.enabled) {
            throw new FlareError('Authentication is disabled for this app', ErrorCodes.AuthenticationFailed);
        }

        const httpBase = this.getHttpBase();
        const tokenProxy = `${httpBase}/auth/oauth/token?appId=${encodeURIComponent(this.config.appId)}`;
        const authProviders: OAuthProvider[] = [];

        const withTokenProxy = (providerId: ProviderId, provider: OAuthProvider): OAuthProvider => ({
            ...provider,
            token_url: tokenProxy,
            tokenParams: { ...(provider.tokenParams ?? {}), provider: providerId },
        });

        if (config.providers.credentials?.enabled) {
            authProviders.push({
                ...Credentials({ clientId: this.config.apiKey }),
                token_url: `${httpBase}/auth/token?appId=${encodeURIComponent(this.config.appId)}`,
                createUserUrl: `${httpBase}/auth/register?appId=${encodeURIComponent(this.config.appId)}`,
                createUserGrantType: 'create_user',
            });
        }

        if (config.providers.google?.enabled && config.providers.google.clientId) {
            authProviders.push(withTokenProxy('google', Google({ clientId: config.providers.google.clientId, scopes: config.providers.google.scopes })));
        }
        if (config.providers.github?.enabled && config.providers.github.clientId) {
            authProviders.push(withTokenProxy('github', GitHub({ clientId: config.providers.github.clientId, scopes: config.providers.github.scopes })));
        }
        if (config.providers.facebook?.enabled && config.providers.facebook.clientId) {
            authProviders.push(withTokenProxy('facebook', Facebook({ clientId: config.providers.facebook.clientId, scopes: config.providers.facebook.scopes })));
        }
        if (config.providers.dropbox?.enabled && config.providers.dropbox.clientId) {
            authProviders.push(withTokenProxy('dropbox', Dropbox({ clientId: config.providers.dropbox.clientId, scopes: config.providers.dropbox.scopes })));
        }
        if (config.providers.apple?.enabled && config.providers.apple.clientId) {
            authProviders.push(withTokenProxy('apple', Apple({ clientId: config.providers.apple.clientId, scopes: config.providers.apple.scopes })));
        }
        if (config.providers.twitter?.enabled && config.providers.twitter.clientId) {
            authProviders.push(withTokenProxy('twitter', Twitter({ clientId: config.providers.twitter.clientId, scopes: config.providers.twitter.scopes })));
        }

        if (authProviders.length === 0) {
            throw new FlareError('No authentication providers are enabled for this app', ErrorCodes.AuthenticationFailed);
        }

        this.authGuard = new AuthGuard({ providers: authProviders, redirectUri: config.redirectUri });
        return this.authGuard;
    }

    async signOut(): Promise<void> {
        try {
            const hasMemorySession = this.authSession?.accessToken || this.authSession?.refreshToken;
            // In proxy mode the server owns the session via cookies, so always
            // attempt the logout call even if in-memory authSession is null
            // (e.g. after a full page reload before the socket sends AUTH_OK).
            if (hasMemorySession || this.config.httpBase) {
                const base = this.getHttpBase();
                await this.ensureCsrfProtection();
                // console.log(`--signOuting`, this.authSession)
                await this.timedFetch('signOut', `${base}/auth/logout?appId=${encodeURIComponent(this.config.appId)}`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.getCsrfHeaders(),
                        ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}),
                        ...(this.authSession?.accessToken ? { Authorization: `Bearer ${this.authSession.accessToken}` } : {}),
                    },
                    body: JSON.stringify({ appId: this.config.appId, apiKey: this.config.apiKey, refresh_token: this.authSession?.refreshToken }),
                }).catch(() => undefined);
            }
        } finally {
            this.setAuthSession(null, 'signOut.finally');
            await this.syncSocketAuth(null).catch(() => undefined);
        }
        this.log('Signed out');
    }

    protected async registerWithEmail(
        email: string,
        password: string,
        options?: { scope?: string[]; additionalParams?: Record<string, string>; signInIfAllowed?: boolean },
    ): Promise<Record<string, any>> {
        if (typeof process !== 'undefined' && process.versions?.node && this.config.grpcUrl && this.config.transport !== 'ws' && this.config.transport !== 'http') {
            try {
                const { runGrpcRegister } = await runtimeImport('./grpc') as typeof import('./grpc');
                const grpcResult = await runGrpcRegister(this.config, email, password);
                if (grpcResult) {
                    return {
                        kind: 'auth.registration',
                        token_type: 'Bearer',
                        access_token: grpcResult.token,
                        refresh_token: null,
                        uid: grpcResult.userId,
                        role: grpcResult.role,
                        verification_required: false,
                        email_sent: false,
                    };
                }
            } catch (err) {
                this.log('gRPC auth register fallback to HTTP', err);
            }
        }

        const base = this.getHttpBase();
        await this.ensureCsrfProtection();
        const { contentType, body } = this.buildAuthRequestBody({
            appId: this.config.appId,
            client_id: this.config.apiKey ?? '',
            grant_type: 'create_user',
            email,
            password,
            scope: options?.scope?.length ? options.scope.join(' ') : undefined,
            additional_params: options?.additionalParams ? JSON.stringify(options.additionalParams) : undefined,
        });
        const trace = await this.timedFetch('registerWithEmail', `${base}/auth/register?appId=${encodeURIComponent(this.config.appId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': contentType, ...this.getCsrfHeaders(), ...(this.config.apiKey ? { 'x-flare-api-key': this.config.apiKey } : {}) },
            body,
        });
        const json = await this.parseJsonWithTiming('registerWithEmail', trace);
        if (!trace.response.ok && trace.response.status !== 202) {
            this.throwFetchFlareError(json, 'User creation failed', ErrorCodes.WriteFailed);
        }
        return json as Record<string, any>;
    }

}