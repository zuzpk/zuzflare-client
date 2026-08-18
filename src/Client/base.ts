import { uuid2, withGet, withPatch, withPost, withPut } from "@zuzjs/core";
import { FlareError } from "../Errors";
import ErrorCodes from "../Errors/codes";
import { CollectionQuery, CollectionReference, DocumentReference } from "../Query";
import {
    ChangeEvent,
    ChangeOperation,
    ConnectionState,
    DataMapperFn,
    FlareConfig,
    PresenceCallback,
    PresenceJoinCallback,
    PresenceLeaveCallback,
    PresenceMember,
    QueryPresetMap,
    QueryPresetParams,
    QueryPresetRow,
    QueryPresetSpec,
    SnapshotEvent,
    StructuredJoinClause,
    StructuredQuery,
    SubscribeOptions,
    SubscriptionCallback,
    SubscriptionError,
    SubscriptionErrorCallback,
    SubscriptionHandle,
    VectorFieldConfig,
} from "../types";
import { FlareAction, FlareEvent } from "../types/message";
import { runtimeImport } from "./runtime-import";
import { FlareTransport } from "./transport";

type ConnectionListener = (state: ConnectionState) => void;
type ErrorListener = (error: Error) => void;

type HttpResponseSnapshot = {
    status: number;
    headers: Record<string, string>;
    data: any;
};

const FIELD_TO_WIRE: Record<string, string> = {
    id: "_id",
    createdAt: "_createdAt",
    updatedAt: "_updatedAt",
};

const FIELD_FROM_WIRE: Record<string, string> = {
    _id: "id",
    _createdAt: "createdAt",
    _updatedAt: "updatedAt",
};

export type ActiveSubscription = {
    baseId: string;
    liveId: string;
    collection: string;
    docId?: string;
    query?: StructuredQuery;
    callback: SubscriptionCallback;
    options: SubscribeOptions;
};

export type QueryPresetHandler<
    Params extends Record<string, unknown> = Record<string, unknown>,
    Row = any,
> = (
    ref: CollectionQuery<any, any>,
    params: Params,
) => CollectionQuery<Row, any>;

/** Embedder function registered by the user */
export type EmbedFn = (input: string | { contentBase64: string; mime?: string }, mode?: "text" | "image") => Promise<number[]>;

export class FlareBase<TPresetMap extends QueryPresetMap = {}> {

    protected transport: FlareTransport;
    protected readonly config: FlareConfig;
    protected readonly pendingAcks   = new Map<string, (value: any) => void>();
    protected readonly subscriptions = new Map<string, SubscriptionCallback>();
    protected readonly activeSubscriptions = new Map<string, ActiveSubscription>();
    protected readonly queryPresets = new Map<string, QueryPresetHandler<any, any>>();
    protected readonly subscriptionErrorHandlers = new Map<string, Set<SubscriptionErrorCallback>>();
    protected readonly subscriptionPermissionHandlers = new Map<string, Set<SubscriptionErrorCallback>>();
    protected readonly subscriptionLastErrors = new Map<string, SubscriptionError>();
    protected readonly offlineQueue: any[] = [];
    protected currentState: ConnectionState = 'disconnected';
    protected connectionListeners: ConnectionListener[] = [];
    protected errorListeners: ErrorListener[] = [];
    protected isDebug: boolean = false;
    protected socketAuthUid: string = 'anon';
    protected pendingSubscriptionReplay = false;
    protected subscriptionReplayPromise: Promise<void> = Promise.resolve();
    protected requestTraceSeq = 0;
    protected requestTimingEnabled = true;
    protected httpInFlight = new Map<string, Promise<HttpResponseSnapshot>>();
    protected httpResponseCache = new Map<string, HttpResponseSnapshot>();
    protected readonly maxHttpCacheEntries = 200;

    // Presence
    protected presenceCallbacks   = new Map<string, PresenceCallback[]>();
    protected presenceJoinCbs     = new Map<string, PresenceJoinCallback[]>();
    protected presenceLeaveCbs    = new Map<string, PresenceLeaveCallback[]>();
    protected presenceHeartbeatTimer?: ReturnType<typeof setInterval>;

    // Vector auto-embed
    protected embedder?: EmbedFn;
    protected vectorSchema = new Map<string, Map<string, VectorFieldConfig>>();

    // Helpers
    protected throwFetchFlareError(payload: unknown, fallbackMessage: string, fallbackCode: string): never {
        const errorPayload = payload as { error?: unknown; message?: unknown };
        // console.log(`throwFetchFlareError:`, { payload, errorPayload, fallbackMessage, fallbackCode });
        const code = typeof errorPayload?.error === 'string' && errorPayload.error.length > 0
            ? errorPayload.error
            : fallbackCode;
        const message = typeof errorPayload?.message === 'string' && errorPayload.message.length > 0
            ? errorPayload.message
            : fallbackMessage;
        throw new FlareError(message, code, payload);
    }

    protected nowMs(): number {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }

    protected normalizeHeaders(headers?: HeadersInit): Record<string, string> {
        if (!headers) return {};
        const out: Record<string, string> = {};
        if (headers instanceof Headers) {
            headers.forEach((value, key) => { out[key] = value; });
        } else if (Array.isArray(headers)) {
            for (const [key, value] of headers) out[String(key)] = String(value);
        } else {
            for (const [key, value] of Object.entries(headers)) out[String(key)] = String(value);
        }
        return out;
    }

    protected redactHeaders(headers: Record<string, string>): Record<string, string> {
        const out = { ...headers };
        for (const key of Object.keys(out)) {
            const lower = key.toLowerCase();
            if (lower === 'authorization' || lower === 'x-flare-csrf' || lower === 'x-csrf-token') {
                out[key] = '[redacted]';
            }
        }
        return out;
    }

    protected stableStringify(value: unknown): string {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
            return value.toString();
        }
        if (typeof value !== 'object') return String(value);
        if (Array.isArray(value)) return `[${value.map(v => this.stableStringify(v)).join(',')}]`;
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        return `{${keys.map(k => `${k}:${this.stableStringify(obj[k])}`).join(',')}}`;
    }

    protected buildHttpCacheKey(
        method: string,
        url: string,
        headers: Record<string, string>,
        body: unknown,
        credentials?: RequestCredentials,
    ): string {
        const sortedHeaderEntries = Object.entries(headers)
            .map(([k, v]) => [k.toLowerCase(), v] as const)
            .sort(([a], [b]) => a.localeCompare(b));
        const headerStr = sortedHeaderEntries.map(([k, v]) => `${k}:${v}`).join('|');
        const bodyStr = this.stableStringify(body);
        return `${method}|${url}|${credentials ?? ''}|${headerStr}|${bodyStr}`;
    }

    protected shouldCacheResponse(method: string, url: string): boolean {
        if (method === 'GET') return true;
        // Session refresh can be called multiple times during middleware/page boot.
        if (method === 'POST' && /\/auth\/refresh(?:\?|$)/.test(url)) return true;
        return false;
    }

    protected rememberHttpResponse(key: string, value: HttpResponseSnapshot): void {
        this.httpResponseCache.set(key, value);
        if (this.httpResponseCache.size <= this.maxHttpCacheEntries) return;
        const first = this.httpResponseCache.keys().next().value;
        if (first) this.httpResponseCache.delete(first);
    }

    protected createTimedFetchTrace(
        snapshot: HttpResponseSnapshot,
        requestId: number,
        startedAtMs: number,
        method: string,
        url: string,
        networkMs: number,
    ): {
        response: {
            status: number;
            ok: boolean;
            headers: { get: (name: string) => string | null };
            json: () => Promise<any>;
        };
        requestId: number;
        startedAtMs: number;
        networkMs: number;
        method: string;
        url: string;
    } {
        return {
            response: {
                status: snapshot.status,
                ok: snapshot.status >= 200 && snapshot.status < 300,
                headers: {
                    get: (name: string) => {
                        const lower = name.toLowerCase();
                        for (const [k, v] of Object.entries(snapshot.headers)) {
                            if (k.toLowerCase() === lower) return String(v);
                        }
                        return null;
                    },
                },
                json: async () => snapshot.data ?? {},
            },
            requestId,
            startedAtMs,
            networkMs,
            method,
            url,
        };
    }

    protected logHttpTiming(...args: any[]) {
        if (!this.requestTimingEnabled) return;
        this.log('[FlareClient][http]', ...args);
    }

    protected mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): HeadersInit {
        if (!base) return extra;
        if (base instanceof Headers) {
            const h = new Headers(base);
            for (const [k, v] of Object.entries(extra)) h.set(k, v);
            return h;
        }
        if (Array.isArray(base)) return [...base, ...Object.entries(extra)];
        return { ...(base as Record<string, string>), ...extra };
    }

    protected toWireField(field: string): string {
        const key = String(field ?? "").trim();
        if (!key) return key;
        return FIELD_TO_WIRE[key] ?? key;
    }

    protected fromWireField(field: string): string {
        const key = String(field ?? "").trim();
        if (!key) return key;
        if (FIELD_FROM_WIRE[key]) return FIELD_FROM_WIRE[key];
        // For auto-prefixed server fields, expose a non-underscore key in client payloads.
        if (key.startsWith("_") && !key.startsWith("__") && key.length > 1) return key.slice(1);
        return key;
    }

    protected normalizeOutboundData(value: unknown): unknown {
        if (Array.isArray(value)) return value.map((v) => this.normalizeOutboundData(v));
        if (!value || typeof value !== "object") return value;

        // Preserve sentinels (operation markers) as-is so server can translate
        // them into atomic DB operators. A sentinel is expected to be an object
        // with a string `__op` property (e.g. { __op: 'inc', v: 1 }).
        const maybeSentinel = value as Record<string, unknown>;
        if (typeof maybeSentinel.__op === 'string') {
            return maybeSentinel;
        }

        const input = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(input)) {
            out[this.toWireField(key)] = this.normalizeOutboundData(val);
        }
        return out;
    }

    protected normalizeInboundData(value: unknown): unknown {
        if (Array.isArray(value)) return value.map((v) => this.normalizeInboundData(v));
        if (!value || typeof value !== "object") return value;

        const input = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(input)) {
            out[this.fromWireField(key)] = this.normalizeInboundData(val);
        }
        return out;
    }

    private getDataMapper(name: string): DataMapperFn | null {
        const registry = this.config.dataMapper;
        if (!registry || typeof registry !== "object") return null;
        const mapper = (registry as Record<string, unknown>)[name];
        return typeof mapper === "function" ? (mapper as DataMapperFn) : null;
    }

    private runMapper(name: string, row: unknown): unknown {
        const mapper = this.getDataMapper(name);
        if (!mapper || row == null || typeof row !== "object") return row;
        try {
            return mapper(row as Record<string, unknown>);
        } catch (err) {
            this.log(`dataMapper for "${name}" failed`, err);
            return row;
        }
    }

    private applyJoinAliasMappers(row: unknown, joins: StructuredJoinClause[]): unknown {
        if (!row || typeof row !== "object" || !Array.isArray(joins) || joins.length === 0) {
            return row;
        }

        let out = row as Record<string, unknown>;
        for (const join of joins) {
            const alias = String(join?.as ?? "").trim();
            if (!alias) continue;

            const nested = Array.isArray(join?.joins) ? join.joins : [];
            const aliasValue = out[alias];

            let nextAliasValue: unknown = aliasValue;
            if (Array.isArray(aliasValue)) {
                nextAliasValue = aliasValue.map((item) => this.applyJoinAliasMappers(item, nested));
            } else if (aliasValue && typeof aliasValue === "object") {
                nextAliasValue = this.applyJoinAliasMappers(aliasValue, nested);
            }

            nextAliasValue = Array.isArray(nextAliasValue)
                ? nextAliasValue.map((item) => this.runMapper(alias, item))
                : this.runMapper(alias, nextAliasValue);

            if (nextAliasValue !== aliasValue) {
                if (out === row) out = { ...out };
                out[alias] = nextAliasValue;
            }
        }

        return out;
    }

    public mapInboundResult(collection: string, payload: unknown, query?: StructuredQuery): unknown {
        const joins = Array.isArray(query?.joins) ? query.joins : [];

        const mapRow = (row: unknown): unknown => {
            const withJoinAliases = this.applyJoinAliasMappers(row, joins);
            return this.runMapper(collection, withJoinAliases);
        };

        if (Array.isArray(payload)) return payload.map((row) => mapRow(row));
        return mapRow(payload);
    }

    protected normalizeOutboundAnyFilter(filter: Record<string, unknown>): Record<string, unknown> {
        if (Array.isArray(filter.or)) {
            return {
                ...filter,
                or: filter.or.map((f) => this.normalizeOutboundAnyFilter(f as Record<string, unknown>)),
            };
        }
        if (Array.isArray((filter as any).and)) {
            return {
                ...filter,
                and: (filter as any).and.map((f: unknown) => this.normalizeOutboundAnyFilter(f as Record<string, unknown>)),
            };
        }
        if (typeof filter.field === "string") {
            return {
                ...filter,
                field: this.toWireField(filter.field),
            };
        }
        return { ...filter };
    }

    protected normalizeOutboundQuery(query: unknown): unknown {
        if (!query) return query;

        if (typeof query !== "object") return query;

        const q = query as Record<string, unknown>;
        const out: Record<string, unknown> = { ...q };

        const normalizeJoin = (join: Record<string, unknown>): Record<string, unknown> => {
            const jOut: Record<string, unknown> = { ...join };
            const localField = String(join?.localField ?? "").trim() || "id";

            jOut.localField = this.toWireField(localField);
            jOut.foreignField = this.toWireField(String(join?.foreignField ?? ""));

            if (Array.isArray(join.where)) {
                jOut.where = join.where.map((f) => this.normalizeOutboundAnyFilter(f as Record<string, unknown>));
            }
            if (Array.isArray(join.orderBy)) {
                jOut.orderBy = join.orderBy.map((o: any) => ({ ...o, field: this.toWireField(String(o?.field ?? "")) }));
            }
            if (join.groupBy && typeof join.groupBy === "object" && Array.isArray((join.groupBy as any).fields)) {
                jOut.groupBy = {
                    ...(join.groupBy as Record<string, unknown>),
                    fields: (join.groupBy as any).fields.map((f: unknown) => this.toWireField(String(f ?? ""))),
                };
            }
            if (Array.isArray(join.having)) {
                jOut.having = join.having.map((h: any) => ({ ...h, field: this.toWireField(String(h?.field ?? "")) }));
            }
            if (Array.isArray(join.select)) {
                jOut.select = join.select.map((f: unknown) => this.toWireField(String(f ?? "")));
            }
            if (typeof join.distinctField === "string") {
                jOut.distinctField = this.toWireField(join.distinctField);
            }
            if (join.vectorSearch && typeof join.vectorSearch === "object") {
                jOut.vectorSearch = {
                    ...(join.vectorSearch as Record<string, unknown>),
                    field: this.toWireField(String((join.vectorSearch as any).field ?? "")),
                };
            }
            if (Array.isArray(join.joins)) {
                jOut.joins = join.joins.map((child) => normalizeJoin(child as Record<string, unknown>));
            }

            return jOut;
        };

        if (Array.isArray(q.where)) {
            out.where = q.where.map((f) => this.normalizeOutboundAnyFilter(f as Record<string, unknown>));
        }
        if (Array.isArray(q.orderBy)) {
            out.orderBy = q.orderBy.map((o: any) => ({ ...o, field: this.toWireField(String(o?.field ?? "")) }));
        }
        if (q.groupBy && typeof q.groupBy === "object" && Array.isArray((q.groupBy as any).fields)) {
            out.groupBy = {
                ...(q.groupBy as Record<string, unknown>),
                fields: (q.groupBy as any).fields.map((f: unknown) => this.toWireField(String(f ?? ""))),
            };
        }
        if (Array.isArray(q.having)) {
            out.having = q.having.map((h: any) => ({ ...h, field: this.toWireField(String(h?.field ?? "")) }));
        }
        if (Array.isArray(q.select)) {
            out.select = q.select.map((f: unknown) => this.toWireField(String(f ?? "")));
        }
        if (typeof q.distinctField === "string") {
            out.distinctField = this.toWireField(q.distinctField);
        }
        if (q.vectorSearch && typeof q.vectorSearch === "object") {
            out.vectorSearch = {
                ...(q.vectorSearch as Record<string, unknown>),
                field: this.toWireField(String((q.vectorSearch as any).field ?? "")),
            };
        }
        if (Array.isArray(q.joins)) {
            out.joins = q.joins.map((j) => normalizeJoin(j as Record<string, unknown>));
        }

        return out;
    }

    protected async timedFetch(label: string, input: string, init?: RequestInit): Promise<{
        response: {
            status: number;
            ok: boolean;
            headers: { get: (name: string) => string | null };
            json: () => Promise<any>;
        };
        requestId: number;
        startedAtMs: number;
        networkMs: number;
        method: string;
        url: string;
    }> {
        const requestId = ++this.requestTraceSeq;
        const startedAtMs = this.nowMs();
        const method = String(init?.method ?? 'GET').toUpperCase();
        const baseHeaders = this.normalizeHeaders(init?.headers);
        const headers = this.redactHeaders(baseHeaders);
        const methodBody = init?.body;
        const cacheKey = this.buildHttpCacheKey(method, input, baseHeaders, methodBody, init?.credentials);
        const shouldCache = this.shouldCacheResponse(method, input);

        this.logHttpTiming(`#${requestId} ${label} start`, { method, url: input, headers, hasBody: Boolean(init?.body) });

        try {
            if (shouldCache) {
                const cached = this.httpResponseCache.get(cacheKey);
                if (cached) {
                    this.logHttpTiming(`#${requestId} ${label} cache-hit`, { method, url: input });
                    return this.createTimedFetchTrace(cached, requestId, startedAtMs, method, input, 0);
                }
            }

            const inFlight = this.httpInFlight.get(cacheKey);
            if (inFlight) {
                const shared = await inFlight;
                const networkMs = this.nowMs() - startedAtMs;
                this.logHttpTiming(`#${requestId} ${label} deduped`, {
                    method,
                    url: input,
                    networkMs: Number(networkMs.toFixed(2)),
                });
                return this.createTimedFetchTrace(shared, requestId, startedAtMs, method, input, networkMs);
            }

            const merged = this.mergeHeaders(init?.headers, { 'x-flare-request-id': String(requestId) });
            const requestHeaders = this.normalizeHeaders(merged);
            const logRequestHeaders = this.redactHeaders(requestHeaders);
            const options = {
                timeout: Math.ceil((this.config.connectionTimeout ?? 10_000) / 1000),
                ignoreKind: true,
                headers: requestHeaders,
                withCredentials: init?.credentials === 'include',
                returnRawResponse: true as const,
                appendCookiesToBody: false,
                appendTimestamp: false,
            };

            this.logHttpTiming(`#${requestId} ${label} request`, {
                method,
                url: input,
                headers: logRequestHeaders,
                hasBody: Boolean(init?.body),
            });
            const methodUpper = method.toUpperCase();

            const executeRequest = async (): Promise<HttpResponseSnapshot> => {
                const rawResponse: any = methodUpper === 'GET'
                    ? await withGet(input, options)
                    : methodUpper === 'PUT'
                        ? await withPut(input, methodBody, options)
                        : methodUpper === 'PATCH'
                            ? await withPatch(input, methodBody, options)
                            : await withPost(input, methodBody, options);

                const responseSnapshot: HttpResponseSnapshot = {
                    status: Number(rawResponse?.status ?? 0),
                    headers: Object.fromEntries(
                        Object.entries((rawResponse?.headers ?? {}) as Record<string, unknown>)
                            .map(([k, v]) => [k, String(v)]),
                    ),
                    data: rawResponse?.data ?? {},
                };

                if (shouldCache) this.rememberHttpResponse(cacheKey, responseSnapshot);
                return responseSnapshot;
            };

            const requestPromise = executeRequest();
            this.httpInFlight.set(cacheKey, requestPromise);
            const snapshot = await requestPromise.finally(() => {
                this.httpInFlight.delete(cacheKey);
            });

            const networkMs = this.nowMs() - startedAtMs;
            this.logHttpTiming(`#${requestId} ${label} response`, {
                status: snapshot.status,
                networkMs: Number(networkMs.toFixed(2)),
            });
            return this.createTimedFetchTrace(snapshot, requestId, startedAtMs, method, input, networkMs);
        } catch (err: any) {
            const networkMs = this.nowMs() - startedAtMs;
            this.logHttpTiming(`#${requestId} ${label} failed`, {
                networkMs: Number(networkMs.toFixed(2)),
                message: err?.message ?? String(err),
            });
            throw err;
        }
    }

    protected async parseJsonWithTiming(label: string, trace: {
        requestId: number;
        startedAtMs: number;
        response: {
            status: number;
            ok: boolean;
            headers: { get: (name: string) => string | null };
            json: () => Promise<any>;
        };
        networkMs: number;
        method: string;
        url: string;
    }): Promise<any> {
        const parseStartMs = this.nowMs();
        const json = await trace.response.json().catch(() => ({}));
        const parseMs = this.nowMs() - parseStartMs;
        const totalMs = this.nowMs() - trace.startedAtMs;
        this.logHttpTiming(`#${trace.requestId} ${label} complete`, {
            method: trace.method,
            url: trace.url,
            status: trace.response.status,
            networkMs: Number(trace.networkMs.toFixed(2)),
            parseMs: Number(parseMs.toFixed(2)),
            totalMs: Number(totalMs.toFixed(2)),
        });
        return json;
    }

    protected getHttpBase(): string {
        // When httpBase is configured, all auth HTTP calls go through that proxy
        // (e.g. a Next.js catch-all route that handles CSRF server-side).
        if (this.config.httpBase) {
            return this.config.httpBase.replace(/\/$/, '');
        }
        const url = new URL(this.config.endpoint);
        return `${url.protocol}//${url.host}`;
    }

    protected log(...args: any[]) {
        if (this.isDebug) {
            console.log('[FlareClient]', ...args);
        }
    }

    // Constructor
    constructor(config: FlareConfig) {
        this.config = {
            autoReconnect: true,
            reconnectDelay: 2,
            maxReconnectDelay: 60,
            debug: false,
            connectionTimeout: 10000,
            ...config,
        };

        this.isDebug = this.config.debug || false;
        this.requestTimingEnabled = this.config.requestTiming ?? true;

        const { hostname, port, protocol } = new URL(this.config.endpoint);
        const isSecure = protocol === 'https:';
        const wsProtocol = isSecure ? 'wss' : 'ws';
        const wsPort = port || (isSecure ? '443' : '80');
        const rawWsPath = String(this.config.wsPath ?? '/').trim();
        const normalizedWsPath = `/${rawWsPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
        const wsPath = normalizedWsPath;
        const url = `${wsProtocol}://${hostname}:${wsPort}${wsPath}?appId=${this.config.appId}${this.config.apiKey ? `&apiKey=${this.config.apiKey}` : ''}${this.config.appVersion ? `&appVersion=${this.config.appVersion}` : ''}`;
        
        this.transport = new FlareTransport({
            url,
            publicKey: this.config.publicKey,
            autoReconnect: this.config.autoReconnect,
            reconnectDelay: this.config.reconnectDelay!,
            maxReconnectDelay: this.config.maxReconnectDelay!,
            onMessage: (msg) => this.handleIncoming(msg),
            onOpen: () => this.onConnected(),
            onClose: () => this.onDisconnected(),
            onError: (error) => this.handleTransportError(error),
            debug: this.isDebug,
        });
        
    }

    // Connection
    connect(): void {
        this.setState('connecting');
        this.transport.connect();
    }

    disconnect(): void {
        this.transport.disconnect();
        this.setState('disconnected');
    }

    get connectionState(): ConnectionState {
        return this.currentState;
    }

    get isConnected(): boolean {
        return this.currentState === 'connected';
    }

    onConnectionStateChange(listener: ConnectionListener): () => void {
        this.connectionListeners.push(listener);
        return () => {
            this.connectionListeners = this.connectionListeners.filter(l => l !== listener);
        };
    }

    onError(callback: ErrorListener): () => void {
        this.errorListeners.push(callback);
        return () => {
            this.errorListeners = this.errorListeners.filter(l => l !== callback);
        };
    }

    // Data access
    collection<T = any>(name: string): CollectionQuery<T, TPresetMap> {
        return new CollectionReference<T, TPresetMap>(this as any, name) as CollectionQuery<T, TPresetMap>;
    }

    /**
     * Generates a 24-character hex document ID (Mongo ObjectId compatible format).
     * UUID v4 without dashes, first 24 chars.
     *
     * ```ts
     * const id = db.generateFlareId();
     * await db.collection('orders').doc(id).set({ total: 99 });
     * ```
     */
    generateFlareId(): string {
        return crypto.randomUUID().replace(/-/g, '').substring(0, 24);
    }

    registerQueryPreset<Name extends string, Params extends Record<string, unknown>, Row = any>(
        name: Name,
        handler: QueryPresetHandler<Params, Row>,
    ): this & FlareBase<TPresetMap & Record<Name, QueryPresetSpec<Params, Row>>> {
        const key = String(name ?? "").trim();
        if (!key) throw new FlareError("Preset name is required", ErrorCodes.QueryFailed);
        if (typeof handler !== "function") {
            throw new FlareError(`Query preset "${key}" handler must be a function`, ErrorCodes.QueryFailed);
        }
        this.queryPresets.set(key, handler);
        return this as this & FlareBase<TPresetMap & Record<Name, QueryPresetSpec<Params, Row>>>;
    }

    registerQueryPresets<
        TRegistry extends Record<string, QueryPresetHandler<any, any>>,
    >(
        presets: TRegistry,
    ): this & FlareBase<TPresetMap & {
        [K in keyof TRegistry]: TRegistry[K] extends QueryPresetHandler<infer Params, infer Row>
            ? QueryPresetSpec<Params, Row>
            : QueryPresetSpec<Record<string, unknown>, any>
    }> {
        for (const [name, handler] of Object.entries(presets ?? {})) {
            this.registerQueryPreset(name, handler);
        }
        return this as this & FlareBase<TPresetMap & {
            [K in keyof TRegistry]: TRegistry[K] extends QueryPresetHandler<infer Params, infer Row>
                ? QueryPresetSpec<Params, Row>
                : QueryPresetSpec<Record<string, unknown>, any>
        }>;
    }

    hasQueryPreset(name: string): boolean {
        return this.queryPresets.has(String(name ?? "").trim());
    }

    applyQueryPreset<Name extends keyof TPresetMap & string>(
        ref: CollectionReference<any, TPresetMap>,
        name: Name,
        params: QueryPresetParams<TPresetMap[Name]>,
    ): CollectionQuery<QueryPresetRow<TPresetMap[Name]>, TPresetMap>;
    applyQueryPreset<T = any>(
        ref: CollectionQuery<T, TPresetMap>,
        name: string,
        params?: Record<string, unknown>,
    ): CollectionQuery<T, TPresetMap>;
    applyQueryPreset<T = any>(
        ref: CollectionQuery<T, TPresetMap>,
        name: string,
        params: Record<string, unknown> = {},
    ): CollectionQuery<T, TPresetMap> {
        const key = String(name ?? "").trim();
        const preset = this.queryPresets.get(key);
        if (!preset) throw new FlareError(`Unknown query preset "${key}"`, ErrorCodes.QueryFailed);

        const result = preset(ref as CollectionQuery<any, any>, params ?? {});
        if (!result || typeof (result as any).get !== "function") {
            throw new FlareError(`Query preset "${key}" must return a CollectionReference`, ErrorCodes.QueryFailed);
        }
        return result as CollectionQuery<T, TPresetMap>;
    }

    /**
     * Returns a DocumentReference for the given collection.
     * When called with no ID, a 20-character Flare ID is auto-generated —
     * read `.id` from the returned ref before any network call.
     *
     * ```ts
     * const ref = db.doc('orders');          // auto-ID
     * const id  = ref.id;
     * await ref.set({ total: 99, id });
     *
     * const existing = db.doc('orders', knownId);  // known ID
     * ```
     */
    doc<T = any>(collection: string): DocumentReference<T> & { id: string };
    doc<T = any>(collection: string, id: string): DocumentReference<T>;
    doc<T = any>(collection: string, id?: string): DocumentReference<T> {
        const resolvedId = id ?? this.generateFlareId();
        const ref = new DocumentReference<T>(this as any, collection, resolvedId) as DocumentReference<T> & { id: string };
        ref.id = resolvedId;
        return ref;
    }

    async ping(): Promise<number> {
        const start = Date.now();
        await this.send(FlareAction.PING, {});
        return Date.now() - start;
    }

    async call<T = Record<string, unknown>>(topic: string, payload: Record<string, unknown> = {}): Promise<T> {
        const response = await this.send(FlareAction.CALL, { topic, payload });
        const ok = response.ok ?? response.success;
        if (!ok) {
            throw new FlareError(response.error ?? `CALL "${topic}" failed`, ErrorCodes.QueryFailed);
        }
        return (response.data ?? response.result) as T;
    }

    async trackAnalytics(event: string, payload: Record<string, unknown> = {}): Promise<void> {
        const eventName = String(event ?? "").trim();
        if (!eventName) {
            throw new FlareError("Analytics event is required", ErrorCodes.QueryFailed);
        }

        await this.call("analytics.track", {
            event: eventName,
            ...payload,
        });
    }

    async query<T = Record<string, unknown>>(collection: string, q: StructuredQuery = {}): Promise<T[]> {
        const outboundQuery = this.normalizeOutboundQuery(q) as StructuredQuery;

        if (typeof process !== "undefined" && process.versions?.node && this.config.grpcUrl && this.config.transport !== "ws" && this.config.transport !== "http") {
            try {
                const { runGrpcQuery } = await runtimeImport("./grpc") as typeof import("./grpc");
                const grpcRows = await runGrpcQuery<T>(this.config, collection, outboundQuery);
                if (grpcRows) {
                    const mapped = this.mapInboundResult(collection, grpcRows, q);
                    return (mapped as T[]) ?? [];
                }
            } catch (err) {
                this.log("gRPC query fallback to websocket", err);
            }
        }

        const response = await this.send(FlareAction.QUERY, { collection, query: outboundQuery });
        const mapped = this.mapInboundResult(collection, response.data, q);
        return (mapped as T[]) ?? [];
    }

    // Vector
    setEmbedder(fn: EmbedFn): void {
        this.embedder = fn;
    }

    markVectorField(collection: string, field: string, config: VectorFieldConfig = { dimensions: 1536 }): void {
        if (!this.vectorSchema.has(collection)) this.vectorSchema.set(collection, new Map());
        this.vectorSchema.get(collection)!.set(field, config);
    }

    async embedVectorFields(collection: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
        const fields = this.vectorSchema.get(collection);
        if (!fields) return data;
        const result = { ...data };
        for (const [field, cfg] of fields) {
            const raw = result[field];
            const mode = cfg.mode ?? "text";
            const embedFn = cfg.embed ?? this.embedder;
            if (!embedFn) {
                this.log(`[vector] No embedder for field "${field}" — skipping`);
                continue;
            }

            if (mode === "image") {
                let input: string | null = null;
                if (typeof raw === "string") {
                    input = raw;
                } else if (typeof raw === "object" && raw !== null && "contentBase64" in raw) {
                    const maybeContent = (raw as { contentBase64?: unknown }).contentBase64;
                    if (typeof maybeContent === "string" && maybeContent.length > 0) {
                        input = maybeContent;
                    }
                } else if (ArrayBuffer.isView(raw)) {
                    const bytes = raw as Uint8Array;
                    const bytesView = bytes.subarray(0, bytes.byteLength);
                    let binary = "";
                    for (let i = 0; i < bytesView.byteLength; i += 1) binary += String.fromCharCode(bytesView[i]);
                    if (typeof btoa === "function") {
                        input = btoa(binary);
                    } else if (typeof Buffer !== "undefined") {
                        input = Buffer.from(bytesView).toString("base64");
                    }
                } else if (raw instanceof ArrayBuffer) {
                    const bytes = new Uint8Array(raw);
                    let binary = "";
                    for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
                    if (typeof btoa === "function") {
                        input = btoa(binary);
                    } else if (typeof Buffer !== "undefined") {
                        input = Buffer.from(bytes).toString("base64");
                    }
                }

                if (!input) {
                    this.log(`[vector] Unsupported image payload for field "${field}" — skipping`);
                    continue;
                }
                try {
                    result[field] = await embedFn(input, "image");
                } catch (err) {
                    this.log(`[vector] Failed to embed field "${field}"`, err);
                }
                continue;
            }

            if (typeof raw === "string") {
                try {
                    result[field] = await embedFn(raw, "text");
                } catch (err) {
                    this.log(`[vector] Failed to embed field "${field}"`, err);
                }
            } else {
                this.log(`[vector] Unsupported text payload for field "${field}" — skipping`);
            }
        }
        return result;
    }

    // Presence
    async joinPresence(room: string, meta?: Record<string, unknown>): Promise<() => void> {
        await this.send(FlareAction.PRESENCE_JOIN, { room, meta });
        this._startPresenceHeartbeat(room, meta);
        return () => this.leavePresence(room);
    }

    async leavePresence(room: string): Promise<void> {
        await this.send(FlareAction.PRESENCE_LEAVE, { room });
        this._stopPresenceHeartbeat();
    }

    onPresenceState(room: string, cb: PresenceCallback): () => void {
        if (!this.presenceCallbacks.has(room)) this.presenceCallbacks.set(room, []);
        this.presenceCallbacks.get(room)!.push(cb);
        return () => {
            const cbs = this.presenceCallbacks.get(room) ?? [];
            this.presenceCallbacks.set(room, cbs.filter(c => c !== cb));
        };
    }

    onPresenceJoin(room: string, cb: PresenceJoinCallback): () => void {
        if (!this.presenceJoinCbs.has(room)) this.presenceJoinCbs.set(room, []);
        this.presenceJoinCbs.get(room)!.push(cb);
        return () => {
            const cbs = this.presenceJoinCbs.get(room) ?? [];
            this.presenceJoinCbs.set(room, cbs.filter(c => c !== cb));
        };
    }

    onPresenceLeave(room: string, cb: PresenceLeaveCallback): () => void {
        if (!this.presenceLeaveCbs.has(room)) this.presenceLeaveCbs.set(room, []);
        this.presenceLeaveCbs.get(room)!.push(cb);
        return () => {
            const cbs = this.presenceLeaveCbs.get(room) ?? [];
            this.presenceLeaveCbs.set(room, cbs.filter(c => c !== cb));
        };
    }

    private _startPresenceHeartbeat(room: string, meta?: Record<string, unknown>) {
        if (this.presenceHeartbeatTimer) return;
        this.presenceHeartbeatTimer = setInterval(() => {
            if (this.isConnected) {
                this.send(FlareAction.PRESENCE_HEARTBEAT, { meta }).catch(() => {});
            }
        }, 20_000);
    }

    private _stopPresenceHeartbeat() {
        if (this.presenceHeartbeatTimer) {
            clearInterval(this.presenceHeartbeatTimer);
            this.presenceHeartbeatTimer = undefined;
        }
    }

    // Offline
    async syncOffline(): Promise<void> {
        if (this.offlineQueue.length === 0) return;
        this.log('Syncing offline operations', this.offlineQueue.length);
        const operations = [...this.offlineQueue];
        this.offlineQueue.length = 0;
        const response = await this.send(FlareAction.OFFLINE_SYNC, { operations });
        if (response.conflicts && response.conflicts.length > 0) {
            this.log('Offline sync conflicts', response.conflicts);
            response.conflicts.forEach((conflict: any) => {
                const op = operations.find(o => o.id === conflict.operationId);
                if (op) this.offlineQueue.push(op);
            });
        }
    }

    // Subscription management
    protected async beforeActivateSubscription(_entry: ActiveSubscription): Promise<void> {
        // Hook for subclasses that need to prepare auth/session state before subscribe.
    }

    protected async activateSubscription(entry: ActiveSubscription): Promise<void> {
        if (!this.isConnected) {
            this.pendingSubscriptionReplay = true;
            return;
        }
        await this.beforeActivateSubscription(entry);
        this.subscriptions.set(entry.liveId, entry.callback);
        try {
            const response = await this.send(FlareAction.SUBSCRIBE, {
                collection: entry.collection,
                docId: entry.docId,
                query: entry.query,
                skipSnapshot: entry.options.skipSnapshot,
            });
            if (!this.activeSubscriptions.has(entry.baseId)) {
                this.subscriptions.delete(entry.liveId);
                return;
            }
            if (response.subscriptionId && response.subscriptionId !== entry.liveId) {
                this.subscriptions.delete(entry.liveId);
                entry.liveId = response.subscriptionId;
                this.subscriptions.set(entry.liveId, entry.callback);
                this.log('Subscription remapped', entry.baseId, '→', entry.liveId);
            }
        } catch (err) {
            this.subscriptions.delete(entry.liveId);
            this.pendingSubscriptionReplay = true;
            const parsed = this.toSubscriptionError(err);
            this.emitSubscriptionError(entry.baseId, parsed);
            this.log('Subscription failed', err);
        }
    }

    protected toSubscriptionError(err: unknown): SubscriptionError {
        const rawMessage = err instanceof Error ? err.message : String(err ?? 'Unknown subscription error');
        const match = rawMessage.match(/^\[([^\]]+)\]\s*(.*)$/);
        const code = match?.[1];
        const message = (match?.[2] ?? rawMessage).trim() || rawMessage;
        const permissionDenied = code === ErrorCodes.PermissionDenied || rawMessage.includes(ErrorCodes.PermissionDenied);
        return {
            code,
            message,
            permissionDenied,
            raw: err,
        };
    }

    protected emitSubscriptionError(baseId: string, error: SubscriptionError): void {
        this.subscriptionLastErrors.set(baseId, error);
        const all = this.subscriptionErrorHandlers.get(baseId);
        if (all) {
            for (const cb of all) {
                try { cb(error); } catch (err) { this.log('Subscription error callback failed', err); }
            }
        }
        if (error.permissionDenied) {
            const onlyPermission = this.subscriptionPermissionHandlers.get(baseId);
            if (onlyPermission) {
                for (const cb of onlyPermission) {
                    try { cb(error); } catch (err) { this.log('Subscription permission callback failed', err); }
                }
            }
        }
    }

    protected async replayActiveSubscriptions(): Promise<void> {
        if (!this.isConnected) {
            this.pendingSubscriptionReplay = true;
            return;
        }
        const entries = Array.from(this.activeSubscriptions.values());
        if (entries.length === 0) {
            this.pendingSubscriptionReplay = false;
            return;
        }
        this.pendingSubscriptionReplay = false;
        this.subscriptionReplayPromise = this.subscriptionReplayPromise.then(async () => {
            for (const entry of entries) {
                if (!this.activeSubscriptions.has(entry.baseId)) continue;
                const previousLiveId = entry.liveId;
                this.subscriptions.delete(previousLiveId);
                entry.liveId = entry.baseId;
                if (previousLiveId) {
                    await this.send(FlareAction.UNSUBSCRIBE, { subscriptionId: previousLiveId }).catch(() => undefined);
                }
                await this.activateSubscription(entry);
            }
        }).catch((err) => {
            this.pendingSubscriptionReplay = true;
            this.log('Subscription replay failed', err);
        });
        await this.subscriptionReplayPromise;
    }

    subscribe(
        subId: string,
        collection: string,
        docId: string | undefined,
        query: StructuredQuery | undefined,
        callback: SubscriptionCallback,
        options: SubscribeOptions = {},
    ): SubscriptionHandle {
        this.log('Creating subscription', subId, collection, docId);
        const entry: ActiveSubscription = { baseId: subId, liveId: subId, collection, docId, query, callback, options };
        this.activeSubscriptions.set(subId, entry);
        if (!this.subscriptionErrorHandlers.has(subId)) {
            this.subscriptionErrorHandlers.set(subId, new Set());
        }
        if (!this.subscriptionPermissionHandlers.has(subId)) {
            this.subscriptionPermissionHandlers.set(subId, new Set());
        }
        this.activateSubscription(entry).catch((err) => { this.log('Subscription activation failed', err); });

        const unsubscribe = () => {
            const activeEntry = this.activeSubscriptions.get(subId);
            const liveId = activeEntry?.liveId ?? subId;
            this.log('Unsubscribing', liveId);
            this.activeSubscriptions.delete(subId);
            this.subscriptions.delete(liveId);
            this.subscriptionErrorHandlers.delete(subId);
            this.subscriptionPermissionHandlers.delete(subId);
            this.subscriptionLastErrors.delete(subId);
            if (this.isConnected) {
                this.send(FlareAction.UNSUBSCRIBE, { subscriptionId: liveId })
                    .catch(err => this.log('Unsubscribe failed', err));
            }
        };

        const handle = unsubscribe as SubscriptionHandle;
        handle.unsubscribe = unsubscribe;
        handle.onError = (cb: SubscriptionErrorCallback) => {
            this.subscriptionErrorHandlers.get(subId)?.add(cb);
            const last = this.subscriptionLastErrors.get(subId);
            if (last) {
                try { cb(last); } catch (err) { this.log('Subscription error callback failed', err); }
            }
            return handle;
        };
        handle.onPermissionDenied = (cb: SubscriptionErrorCallback) => {
            this.subscriptionPermissionHandlers.get(subId)?.add(cb);
            const last = this.subscriptionLastErrors.get(subId);
            if (last?.permissionDenied) {
                try { cb(last); } catch (err) { this.log('Subscription permission callback failed', err); }
            }
            return handle;
        };
        handle.catch = (cb: SubscriptionErrorCallback) => handle.onError(cb);

        return handle;
    }

    // Internal send
    async send(type: FlareAction, payload: any): Promise<any> {
        if (type === FlareAction.WRITE && payload.collection && payload.data) {
            const embedded = await this.embedVectorFields(payload.collection, payload.data);
            payload = { ...payload, data: this.normalizeOutboundData(embedded) };
        }
        if ((type === FlareAction.SUBSCRIBE || type === FlareAction.QUERY) && payload?.query) {
            payload = { ...payload, query: this.normalizeOutboundQuery(payload.query) };
        }
        return new Promise((resolve, reject) => {
            const id = uuid2(18);
            const message = { id, type, ts: Date.now(), ...payload };
            this.pendingAcks.set(id, (response) => {
                if (response.type === FlareEvent.ERROR) {
                    reject(new Error(`[${response.code}] ${response.message}`));
                } else {
                    resolve(response);
                }
            });
            if (this.isConnected) {
                this.transport.send(message);
            } else {
                this.log('Queueing message for offline', message);
                this.offlineQueue.push(message);
                reject(new Error('Not connected - message queued'));
            }
            setTimeout(() => {
                if (this.pendingAcks.has(id)) {
                    this.pendingAcks.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, this.config.connectionTimeout);
        });
    }

    // Internal lifecycle
    private handleTransportError(error: Error) {
        this.log('Transport error', error);
        this.errorListeners.forEach(listener => {
            try { listener(error); } catch (err) { this.log('Error listener error', err); }
        });
    }

    protected onConnected() {
        this.setState('connected');
        this.log('Connected to FlareServer');
        if (this.activeSubscriptions.size > 0) {
            this.pendingSubscriptionReplay = true;
        }
        if (this.offlineQueue.length > 0) {
            this.syncOffline().catch(err => { this.log('Offline sync failed', err); });
        }
    }

    protected onDisconnected() {
        if (this.currentState !== 'disconnected') this.setState('reconnecting');
        if (this.activeSubscriptions.size > 0) this.pendingSubscriptionReplay = true;
        this.log('Disconnected from FlareServer');
    }

    protected setState(state: ConnectionState) {
        if (this.currentState === state) return;
        this.currentState = state;
        this.log('Connection state changed', state);
        this.connectionListeners.forEach(listener => {
            try { listener(state); } catch (err) { this.log('Connection listener error', err); }
        });
    }

    protected handleIncoming(msg: any) {
        this.log('Received message', msg.type, msg);

        if (msg.type === FlareEvent.QUERY_RESULT && Array.isArray(msg.data)) {
            msg = { ...msg, data: this.normalizeInboundData(msg.data) };
        }

        if (
            msg.type === FlareEvent.ACK     ||
            msg.type === FlareEvent.PONG    ||
            msg.type === FlareEvent.AUTH_OK ||
            msg.type === FlareEvent.CALL_RESPONSE ||
            msg.type === FlareEvent.QUERY_RESULT
        ) {
            const resolve = this.pendingAcks.get(msg.correlationId || msg.id);
            if (resolve) {
                resolve(msg);
                this.pendingAcks.delete(msg.correlationId || msg.id);
            }
            return;
        }

        if (msg.type === FlareEvent.ERROR) {
            this.log('Server error', msg.code, msg.message);
            const error = new Error(`[${msg.code}] ${msg.message}`);
            this.errorListeners.forEach(listener => {
                try { listener(error); } catch (err) { this.log('Error listener error', err); }
            });

            const target = Array.from(this.activeSubscriptions.values())
                .find((entry) => entry.liveId === msg.correlationId || entry.baseId === msg.correlationId);
            if (target) {
                this.emitSubscriptionError(target.baseId, {
                    code: typeof msg.code === 'string' ? msg.code : undefined,
                    message: String(msg.message ?? 'Subscription error'),
                    permissionDenied: msg.code === ErrorCodes.PermissionDenied,
                    raw: msg,
                });
            }

            if (msg.correlationId) {
                const resolve = this.pendingAcks.get(msg.correlationId);
                if (resolve) {
                    resolve(msg);
                    this.pendingAcks.delete(msg.correlationId);
                }
            }
            return;
        }

        if (msg.type === FlareEvent.PRESENCE_STATE) {
            const cbs = this.presenceCallbacks.get(msg.room) ?? [];
            cbs.forEach(cb => { try { cb(msg.members as PresenceMember[]); } catch {} });
            return;
        }
        if (msg.type === FlareEvent.PRESENCE_JOIN) {
            const cbs = this.presenceJoinCbs.get(msg.room) ?? [];
            cbs.forEach(cb => { try { cb(msg as PresenceMember); } catch {} });
            return;
        }
        if (msg.type === FlareEvent.PRESENCE_LEAVE) {
            const cbs = this.presenceLeaveCbs.get(msg.room) ?? [];
            cbs.forEach(cb => { try { cb(msg.uid as string); } catch {} });
            return;
        }

        if (msg.type === FlareEvent.SNAPSHOT) {
            const callback = this.subscriptions.get(msg.subscriptionId);
            if (callback) {
                const active = Array.from(this.activeSubscriptions.values())
                    .find((entry) => entry.liveId === msg.subscriptionId);
                const normalized = this.normalizeInboundData(Array.isArray(msg.data) ? msg.data : (msg.data != null ? [msg.data] : []));
                const mapped = this.mapInboundResult(
                    String(msg.collection ?? active?.collection ?? ""),
                    normalized,
                    active?.query,
                );
                const event: SnapshotEvent = {
                    type: 'snapshot',
                    subscriptionId: msg.subscriptionId,
                    collection: msg.collection,
                    data: Array.isArray(mapped) ? mapped : [],
                };
                try { callback(event); } catch (err) { this.log('Subscription callback error', err); }
            }
            return;
        }

        if (msg.type === FlareEvent.CHANGE) {
            const callback = this.subscriptions.get(msg.subscriptionId);
            if (callback) {
                const active = Array.from(this.activeSubscriptions.values())
                    .find((entry) => entry.liveId === msg.subscriptionId);
                const normalizedData = msg.operation === 'delete' ? null : this.normalizeInboundData(msg.data);
                const mappedData = msg.operation === 'delete'
                    ? null
                    : this.mapInboundResult(
                        String(msg.collection ?? active?.collection ?? ""),
                        normalizedData,
                        active?.query,
                    );
                const event: ChangeEvent = {
                    type: 'change',
                    subscriptionId: msg.subscriptionId,
                    collection: msg.collection,
                    docId: msg.docId as string,
                    operation: msg.operation as ChangeOperation,
                    data: mappedData,
                };
                try { callback(event); } catch (err) { this.log('Subscription callback error', err); }
            }
        }
    }
}
