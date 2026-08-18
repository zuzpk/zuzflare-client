/**
 * Client/index.ts ─ entry point
 *
 * FlareClient is the public-facing class. All logic lives in:
 *   - Client/base.ts  → transport, subscriptions, presence, vector, offline
 *   - Client/auth.ts  → CSRF capture, all auth & session methods
 *
 * CSRF Protection (SSR-Only by Default)
 * ────────────────────────────────────
 * FlareClient does NOT automatically fetch CSRF on construction. Instead:
 *
 *   1. SSR (Next.js): Middleware fetches /auth/config once, sets CSRF as HttpOnly
 *      cookie on response. Methods automatically use this cookie (no extra calls).
 *
 *   2. Browser-only (SPA): Explicitly call client.ensureCsrfProtection() before
 *      mutations to fetch /auth/config and cache CSRF token in memory.
 *
 * Why? Eliminates redundant /auth/config calls in SSR, where every method used
 * to fetch it again internally. Now CSRF bootstrapping happens once (in middleware),
 * and auth methods just use getCsrfHeaders() which returns the cached token
 * (if available) or empty object (relying on HttpOnly cookie validation).
 *
 * This file wires FlareAuth together and leaves CSRF bootstrapping to the user.
 */
import type { QueryPresetMap } from "../types";
import { FlareConfig } from "../types";
import { FlareAuth } from "./auth";

class FlareClient<TPresetMap extends QueryPresetMap = {}> extends FlareAuth<TPresetMap> {

    private autoPushRegisteredIdentity?: string;
    private autoPushInProgress = false;

    constructor(config: FlareConfig) {
        super(config);
        // CSRF is disabled by default — use server-to-server only.
        // Call this.ensureCsrfProtection() explicitly on the client to enable browser CSRF.
        // this.ensureCsrfProtection();
        this.log('FlareClient initialized', config);

        if ( config.pushNotifications === true ){
            this.enableAutoPushNotificationsAfterAuth();
        }

    }

    private enableAutoPushNotificationsAfterAuth() {
        const attempt = async () => {
            const session = this.authSession;
            const uid = String(session?.uid ?? '').trim() || 'anon';
            const accessToken = String(session?.accessToken ?? '').trim();
            const identity = uid !== 'anon' && accessToken ? uid : 'anon';

            if (this.autoPushRegisteredIdentity === identity) {
                return;
            }
            if (this.autoPushInProgress) {
                return;
            }

            this.autoPushInProgress = true;
            try {
                await this.autoEnablePushNotifications();
                this.autoPushRegisteredIdentity = identity;
            } catch (err) {
                this.log('Auto push enable failed', err);
            } finally {
                this.autoPushInProgress = false;
            }
        };

        this.onAuthStateChanged(() => {
            attempt().catch(() => undefined);
        });

        attempt().catch(() => undefined);
    }

    async autoEnablePushNotifications() {
        await this.setupPushServiceWorker().catch(() => undefined);
        await this.requestPushPermission();

        const { token } = await this.acquireBrowserPushToken();
        await this.registerPushToken({ token, platform: 'web', topics: [this.config.appId] });

    }
}

export default FlareClient;
