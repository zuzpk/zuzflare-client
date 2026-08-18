/**
 * Client/proxy.ts ─ Next.js SSR CSRF proxy helper
 *
 * Why this exists
 * ───────────────
 * The Flare server now sets the CSRF token exclusively as an HttpOnly cookie
 * on its own domain (e.g. api.flare.example.com) and also echoes it in the
 * `x-flare-csrf` response header so the browser client can capture it in-
 * memory and send it back as a request header.
 *
 * When your Next.js app runs server-side rendering (SSR / Route Handlers /
 * Server Actions) it operates on a *different* domain (e.g. app.example.com).
 * The browser's HttpOnly Flare cookie is scoped to the Flare domain and is
 * therefore NOT automatically forwarded by the browser to your Next.js
 * server-side fetch calls.
 *
 * Solution — two-cookie strategy
 * ────────────────────────────────
 * 1. Browser → Flare domain    : Flare sets `__flare_csrf_<appId>` as HttpOnly
 *                                on the Flare domain. Browser also reads the
 *                                token from the `x-flare-csrf` header and keeps
 *                                it in-memory for direct API calls.
 *
 * 2. Browser → Next.js domain  : Mount `createCsrfProxy()` at a route such as
 *                                `/api/flare/csrf`. On first browser load call
 *                                this route; it hits Flare's /auth/config,
 *                                reads the `x-flare-csrf` header, and sets
 *                                it as an HttpOnly cookie on the *Next.js*
 *                                domain too (`__flare_csrf_<appId>`).
 *                                All subsequent SSR fetch calls from the
 *                                Next.js server can then read this cookie from
 *                                the incoming request and forward it as the
 *                                `x-flare-csrf` header to Flare.
 *
 * Usage (Next.js App Router)
 * ─────────────────────────────
 * // app/api/flare/csrf/route.ts
 * import { createCsrfProxy } from "@zuzjs/flare-client/proxy";
 * export const GET = createCsrfProxy({ endpoint: "https://api.flare.example.com", appId: "my-app" });
 *
 * // In any Server Component / Route Handler:
 * import { extractCsrfFromRequest, buildFlareHeaders } from "@zuzjs/flare-client/proxy";
 * const csrf = extractCsrfFromRequest(request, "my-app");
 * const res = await withGet(`${FLARE}/auth/whatever`, { headers: buildFlareHeaders(csrf), ignoreKind: true });
 *
 * Usage (Next.js Pages Router)
 * ──────────────────────────────
 * // pages/api/flare/csrf.ts
 * import { createCsrfProxyHandler } from "@zuzjs/flare-client/proxy";
 * export default createCsrfProxyHandler({ endpoint: "...", appId: "my-app" });
 */

import { withGet } from "@zuzjs/core";
import { AuthConfigResponse } from "../types/response";

// Types
export interface CsrfProxyConfig {
    /** Base URL of the Flare server, e.g. "https://api.flare.example.com" */
    endpoint: string;
    /** App ID passed to Flare's /auth/config */
    appId: string;
    /** Optional Flare API key */
    apiKey?: string;
    /**
     * Name of the proxy cookie written on the Next.js domain.
    * Defaults to `__flare_csrf_<appId>`.
     */
    proxyCookieName?: string;
    /**
     * Max-Age for the proxy cookie in seconds.
     * Defaults to 3600 (1 hour).
     */
    proxyCookieMaxAge?: number;
}

// Shared helpers
function defaultProxyCookieName(appId: string): string {
    return `__flare_csrf_${appId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function defaultServerCsrfCookieName(appId: string): string {
    return `__flare_csrf_${appId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function readHeaderCaseInsensitive(headers: Record<string, any>, name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers ?? {})) {
        if (k.toLowerCase() === lower && typeof v === 'string') {
            return v;
        }
    }
    return undefined;
}

function readSetCookieValues(headers: Record<string, any>): string[] {
    const raw = readHeaderCaseInsensitive(headers, 'set-cookie');
    if (typeof raw === 'string' && raw.length > 0) {
        return [raw];
    }

    for (const [k, v] of Object.entries(headers ?? {})) {
        if (k.toLowerCase() === 'set-cookie' && Array.isArray(v)) {
            return v.filter((item) => typeof item === 'string');
        }
    }

    return [];
}

function extractCookieValue(setCookieHeaders: string[], cookieName: string): string | undefined {
    for (const header of setCookieHeaders) {
        const parts = header.split(';').map((p) => p.trim());
        const [pair] = parts;
        if (!pair) continue;

        const eq = pair.indexOf('=');
        if (eq <= 0) continue;

        const name = decodeURIComponent(pair.slice(0, eq));
        const value = pair.slice(eq + 1);

        if (name === cookieName) {
            return decodeURIComponent(value);
        }
    }

    return undefined;
}

/**
 * Fetch the CSRF token from Flare's /auth/config endpoint.
 * Returns the full response object or undefined when the server does not respond.
 */
async function fetchAuthConfigFromFlare(config: CsrfProxyConfig): Promise<any> {

    const url = new URL('/auth/config', config.endpoint);
    url.searchParams.set('appId', config.appId);
    if (config.apiKey) url.searchParams.set('apiKey', config.apiKey);

    return await withGet<any>(url.toString(), {
        ignoreKind: true,
        withCredentials: true,
        returnRawResponse: true,
        headers: config.apiKey ? { 'x-flare-api-key': config.apiKey } : {},
        appendCookiesToBody: false,
        appendTimestamp: false,
    }).catch(() => null);

    
}

/**
 * Fetch the CSRF token from Flare's /auth/config endpoint.
 * Returns the token value extracted from the `x-flare-csrf` response header,
 * or undefined when the server does not send one.
 */
async function fetchCsrfTokenFromFlare(config: CsrfProxyConfig): Promise<AuthConfigResponse | undefined> {

    const res = await fetchAuthConfigFromFlare(config);

    const authConfig : AuthConfigResponse | undefined = (res as any)?.data as AuthConfigResponse | undefined;

    const responseHeaders = ((res as any)?.headers ?? {}) as Record<string, any>;

    const tokenFromHeader =
        readHeaderCaseInsensitive(responseHeaders, 'x-flare-csrf') ??
        readHeaderCaseInsensitive(responseHeaders, 'x-csrf-token') ??
        readHeaderCaseInsensitive(responseHeaders, 'csrf-token');

    if (typeof tokenFromHeader === 'string' && tokenFromHeader.length > 0) {
        return {
            csrfToken: tokenFromHeader,
            ...authConfig
        } as any;
    }

    const cookieNameFromBody = authConfig?.cookie?.csrfTokenName;
    const csrfCookieName = cookieNameFromBody && cookieNameFromBody.length > 0
        ? cookieNameFromBody
        : defaultServerCsrfCookieName(config.appId);

    const setCookieValues = readSetCookieValues(responseHeaders);
    const tokenFromCookie = extractCookieValue(setCookieValues, csrfCookieName);

    if (typeof tokenFromCookie === 'string' && tokenFromCookie.length > 0) {
        return {
            csrfToken: tokenFromCookie,
            ...authConfig
        } as any;
    }

    return undefined;
}

/**
 * Build the Set-Cookie header value for the proxy cookie.
 */
function buildSetCookieValue(name: string, value: string, maxAge: number): string {
    return `${encodeURIComponent(name)}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

// App Router handler (Next.js 13+)
/**
 * Creates a Next.js App Router `GET` handler that:
 *  1. Calls Flare's /auth/config and captures the `x-flare-csrf` header.
 *  2. Sets it as `__flare_csrf_<appId>` HttpOnly cookie on the current domain.
 *  3. Returns the token in JSON for the browser to store in-memory as well.
 *
 * Mount at: `app/api/flare/csrf/route.ts`
 */
export function createCsrfProxy(config: CsrfProxyConfig) {
    const proxyCookieName = config.proxyCookieName ?? defaultProxyCookieName(config.appId);
    const maxAge = config.proxyCookieMaxAge ?? 3600;

    return async function GET(_request: Request): Promise<Response> {
        const authConfig = await fetchCsrfTokenFromFlare(config);
        const csrfToken = authConfig?.csrfToken;
        const headers = new Headers({ 'Content-Type': 'application/json' });

        if (csrfToken) {
            headers.set('Set-Cookie', buildSetCookieValue(proxyCookieName, csrfToken, maxAge));
        }

        return new Response(
            JSON.stringify({ csrfToken: csrfToken ?? null, ...authConfig }),
            { status: 200, headers },
        );
    };
}

// Pages Router handler (Next.js ≤ 12 / hybrid)
/**
 * Creates a Next.js Pages Router API handler (`pages/api/flare/csrf.ts`).
 * Same behaviour as `createCsrfProxy()` but uses the Node.js req/res API.
 */
export function createCsrfProxyHandler(config: CsrfProxyConfig) {
    const proxyCookieName = config.proxyCookieName ?? defaultProxyCookieName(config.appId);
    const maxAge = config.proxyCookieMaxAge ?? 3600;

    return async function handler(req: any, res: any): Promise<void> {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.status(405).json({ error: 'Method not allowed' });
            return;
        }

        const authConfig = await fetchCsrfTokenFromFlare(config);
        const csrfToken = authConfig?.csrfToken;

        if (csrfToken) {
            res.setHeader(
                'Set-Cookie',
                buildSetCookieValue(proxyCookieName, csrfToken, maxAge),
            );
        }

        res.status(200).json({ csrfToken: csrfToken ?? null });
    };
}

// SSR helpers
/**
 * Extract the proxied CSRF token from an incoming Next.js request's cookies.
 *
 * Call this inside Server Components, Route Handlers, or `getServerSideProps`
 * to retrieve the token that was set by `createCsrfProxy`.
 *
 * @example
 * // App Router Route Handler
 * const csrf = extractCsrfFromRequest(request, "my-app");
 */
export function extractCsrfFromRequest(
    request: Request | { cookies: Record<string, string> | { get(name: string): { value: string } | undefined } },
    appId: string,
    proxyCookieName?: string,
): string | null {
    const cookieName = proxyCookieName ?? defaultProxyCookieName(appId);

    // App Router: `request` is a Web `Request` — parse Cookie header manually
    if (request instanceof Request) {
        const cookieHeader = request.headers.get('cookie') ?? '';
        const match = cookieHeader
            .split(';')
            .map(s => s.trim())
            .find(s => s.startsWith(`${encodeURIComponent(cookieName)}=`) || s.startsWith(`${cookieName}=`));
        if (!match) return null;
        const idx = match.indexOf('=');
        return idx >= 0 ? decodeURIComponent(match.slice(idx + 1)) : null;
    }

    // Pages Router / next/headers cookies() helper
    const { cookies } = request as any;
    if (typeof cookies?.get === 'function') {
        return cookies.get(cookieName)?.value ?? null;
    }
    if (cookies && typeof cookies === 'object') {
        return (cookies as Record<string, string>)[cookieName] ?? null;
    }

    return null;
}

/**
 * Build the headers object to attach to a server-side fetch call to Flare,
 * forwarding the CSRF token and (optionally) the Authorization bearer token.
 */
export function buildFlareHeaders(
    csrfToken: string | null,
    options?: { accessToken?: string; apiKey?: string },
): Record<string, string> {
    const headers: Record<string, string> = {};
    if (csrfToken) headers['x-flare-csrf'] = csrfToken;
    if (options?.accessToken) headers['Authorization'] = `Bearer ${options.accessToken}`;
    if (options?.apiKey) headers['x-flare-api-key'] = options.apiKey;
    return headers;
}
