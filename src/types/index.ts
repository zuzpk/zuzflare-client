import { AuthToken } from "@zuzjs/auth";
import { FlareSentinel } from "../sentinels";

/**
 * Client Configuration
 */
export interface FlareConfig {
    /** Base URL for the Flare API. */
    endpoint: string;
    /** Optional gRPC endpoint, e.g. "127.0.0.1:5051" for Node runtimes. */
    grpcUrl?: string;
    /** Transport preference for supported operations. */
    transport?: "auto" | "ws" | "http" | "grpc";
    /**
     * Optional HTTP base URL for auth API calls.
     * When set, all auth HTTP calls go through this base instead of calling
     * Flare directly. Use this to route calls through a Next.js proxy so CSRF
     * is handled entirely server-side.
     * Example: '/api/flare'  (relative, browser resolves against current origin)
     */
    httpBase?: string;
    /**
     * WebSocket path used for realtime transport.
     * Defaults to '/' for backward compatibility.
     */
    wsPath?: string;
    /** Unique identifier for the application. */
    appId: string;
    /** API key for the application. */
    apiKey?: string;
    /**
     * Request content type for credential auth endpoints (/auth/token, /auth/register).
     * Defaults to OAuth-compatible form encoding.
     */
    authRequestContentType?: "application/x-www-form-urlencoded" | "application/json";
    /**
     * Controls how onAuthStateChanged initializes auth in browser runtime.
     * - `refresh` (default): attempt /auth/refresh once in httpBase mode.
     * - `none`: skip automatic refresh bootstrap; listeners receive current in-memory state only.
     */
    authBootstrapMode?: "refresh" | "none";
    /** Public key for the application. */
    publicKey?: string;
    /** Whether to automatically reconnect on connection loss. */
    autoReconnect?: boolean;
    /** Delay between reconnection attempts in milliseconds. */
    reconnectDelay?: number;
    /** Maximum delay between reconnection attempts in milliseconds. */
    maxReconnectDelay?: number;
    /** Enable or disable debug mode. */
    debug?: boolean;
    /** Enable or disable request timing. */
    requestTiming?: boolean;
    /** Connection timeout in milliseconds. */
    connectionTimeout?: number;
    /** Enable automatic push notification registration on supported platforms. */
    pushNotifications?: boolean;
    /**
     * Optional per-collection mapper registry for shaping inbound data.
     *
     * Keys can be:
     * - base collection names (e.g. "boards")
     * - join aliases (`join(..., { as: "team" })` => "team")
     */
    dataMapper?: DataMapperRegistry;
    /**
     * Optional storage auto-provisioning config for bucket/server defaults.
     */
    storage?: boolean | FlareStorageAutoConfig;
    /** Application version. */
    appVersion?: string;
}

/**
 * Options for storage auto-provisioning via `storage` in `FlareConfig`.
 */
export interface FlareStorageAutoConfig {
    /** Human-readable label for the auto-provisioned server. Defaults to `"default"`. */
    name?: string;
    /**
     * Bucket name. Defaults to `"<appId>-storage"`.
     * Must be unique per app per backend kind (embedded vs S3).
     */
    bucket?: string;
    /** Optional key prefix applied to all objects inside the bucket. */
    prefix?: string;
    /**
     * Built-in transfer manager settings.
     *
     * By default uploads/downloads are queued with concurrency 1 each so
     * calling putObject/getObject without await remains safe.
     */
    transferManager?: FlareStorageTransferManagerConfig;
}

export interface FlareStorageTransferManagerConfig {
    /** Enable built-in storage transfer queue. Defaults to true. */
    enabled?: boolean;
    /** Max concurrent uploads (putObject). Defaults to 1. */
    uploadConcurrency?: number;
    /** Max concurrent downloads (getObject). Defaults to 1. */
    downloadConcurrency?: number;
}

export type DataMapperFn<TRow = any, TMapped = any> = (row: TRow) => TMapped;
export type DataMapperRegistry = Record<string, DataMapperFn<any, any>>;

export type FlareAuthProviderId =
  | "credentials"
  | "anonymous"
  | "google"
  | "facebook"
  | "github"
  | "dropbox"
  | "apple"
  | "twitter";

export interface FlareAuthProviderPublicConfig {
    enabled: boolean;
    clientId?: string;
    scopes?: string[];
}

export interface FlareAuthConfig {
    appId: string;
    enabled: boolean;
    needsEmailVerification?: boolean;
    autoSendVerificationEmail?: boolean;
    redirectUri?: string;
    storageRulesHomeBucket?: string | null;
    csrfToken?: string;
    cookie?: {
        accessTokenName?: string;
        refreshTokenName?: string;
        csrfTokenName?: string;
        domain?: string;
        path?: string;
        secure?: boolean;
        sameSite?: "Lax" | "Strict" | "None";
        accessTokenMaxAge?: number;
        refreshTokenMaxAge?: number;
        csrfTokenMaxAge?: number;
    };
    providers: Record<FlareAuthProviderId, FlareAuthProviderPublicConfig>;
}

export interface FlareAuthSession {
    uid: string;
    accessToken: string;
    refreshToken: string | null;
    provider?: string;
    email?: string | null;
    emailVerified?: boolean;
    bfp?: string; // Browser fingerprint for device binding
}

export interface FlareAuthUser {
    uid: string;
    email: string;
    email_verified: string;
    [x: string]: any
}

export interface FlareAuthHydrationInput {
    uid?: string | null;
    id?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    ticket?: string | null;
    provider?: string;
    email?: string | null;
    emailVerified?: boolean;
    email_verified?: boolean;
    profile?: Partial<FlareAuthUser> | null;
}

export interface FlareAuthHydrationOptions {
    source?: string;
    markBootstrapAttempted?: boolean;
    syncSocket?: boolean;
}

export interface RegisterPushTokenInput {
    token: string;
    platform?: string;
    deviceId?: string;
    topics?: string[];
    authAppId?: string;
}

export interface BrowserPushTokenOptions {
    /** Service worker registration used for PushManager subscription. */
    serviceWorkerRegistration?: ServiceWorkerRegistration;
    /** Existing PushSubscription to reuse instead of subscribing again. */
    subscription?: PushSubscription;
    /** Public VAPID key used when creating a new PushSubscription. */
    applicationServerKey?: string;
    /** When true, unsubscribe old subscriptions before creating a new one. */
    forceResubscribe?: boolean;
}

export interface BrowserPushRegistrationOptions extends BrowserPushTokenOptions {
    /** Optional explicit platform label. Defaults to "web". */
    platform?: string;
    deviceId?: string;
    topics?: string[];
    authAppId?: string;
}

export interface SendPushNotificationInput {
    title?: string;
    body?: string;
    image?: string;
    data?: Record<string, unknown>;
    tokens?: string[];
    uid?: string;
    topic?: string;
    priority?: "normal" | "high";
    ttlSeconds?: number;
    dryRun?: boolean;
    authAppId?: string;
}

export interface PushSendResult {
    sent: boolean;
    appId: string;
    targetCount: number;
    successCount: number;
    failureCount: number;
    invalidatedTokenCount: number;
    dryRun: boolean;
}

// Low-level Storage types (backward compat)
export interface FlareStorageServer {
    id: string;
    name: string;
    kind: string;
    endpoint: string;
    bucket: string;
    region: string;
    prefix?: string;
    dataDir?: string;
    forcePathStyle?: boolean;
    frozen?: boolean;
    readOnly?: boolean;
    createdAt?: unknown;
    updatedAt?: unknown;
}

export interface FlareStorageServerInput {
    name: string;
    kind?: string;
    endpoint?: string;
    bucket: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    prefix?: string;
    dataDir?: string;
    forcePathStyle?: boolean;
    frozen?: boolean;
    readOnly?: boolean;
}

export interface FlareStorageServerPatchInput {
    name?: string;
    endpoint?: string;
    bucket?: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    prefix?: string;
    dataDir?: string;
    forcePathStyle?: boolean;
    frozen?: boolean;
    readOnly?: boolean;
}

export interface FlareStorageUploadInput {
    serverId: string;
    path: string;
    contentBase64: string;
    contentType?: string;
    encrypt?: boolean;
}

export interface FlareStorageDownloadInput {
    serverId: string;
    path: string;
    decrypt?: boolean;
}

export interface FlareStorageDeleteInput {
    serverId: string;
    path: string;
}

export interface FlareStorageObjectResult {
    ok: boolean;
    path: string;
    key: string;
    access?: "public" | "private";
    url?: string;
    encrypted?: boolean;
    size?: number;
    contentBase64?: string;
    contentType?: string;
}

export enum FlareStorageSignedAction {
    Upload = "upload",
    Download = "download",
    Delete = "delete",
    Edit = "edit",
}

export interface FlareStorageSignedUrlInput {
    serverId: string;
    path: string;
    action: FlareStorageSignedAction;
    expiresInSeconds?: number;
    sizeBytes?: number;
    contentType?: string;
    access?: "public" | "private";
    encrypt?: boolean;
    decrypt?: boolean;
    forceDownload?: boolean;
    allowedOrigins?: string[];
    embedOnly?: boolean;
}

export interface FlareStorageSignedUrlResult {
    ok: boolean;
    action: FlareStorageSignedAction;
    method: "PUT" | "PATCH" | "GET" | "DELETE";
    token: string;
    urlPath: string;
    url: string;
    expiresInSeconds?: number;
    expiresAt: number;
    forceDownload?: boolean;
    allowedOrigins?: string[];
    embedOnly?: boolean;
}

export interface FlareStorageAwsConfig {
    kind: string;
    endpoint: string;
    region: string;
    bucket: string;
    prefix?: string;
    dataDir?: string;
    forcePathStyle?: boolean;
    accessKeyId: string;
    secretAccessKey: string;
}

export interface FlareStorageRulesPolicy {
    maxEntries?: number;
    maxAgeDays?: number;
}

export interface FlareStorageRulesHistoryResult {
    history: unknown[];
    policy: FlareStorageRulesPolicy;
    restoreEvents: unknown[];
}

// S3-compatible Storage API types
/** Upload progress snapshot. */
export interface StorageProgress {
    /** Bytes sent so far. */
    loaded: number;
    /** Total bytes to send. */
    total: number;
    /** 0–100. */
    percent: number;
}

/** A bucket (backed by a flare storage server). */
export interface StorageBucket {
    /** Internal flare server ID. */
    id: string;
    /** Human-readable label. */
    name: string;
    /** Bucket name used on the backend (s3 bucket / embedded dir name). */
    bucket: string;
    /** Backend kind: "embedded" | "s3" | "managed". */
    kind: string;
    region?: string;
    endpoint?: string;
    prefix?: string;
    frozen?: boolean;
    readOnly?: boolean;
    createdAt?: unknown;
    updatedAt?: unknown;
}

/** Options for createBucket(). */
export interface StorageBucketInput {
    /**
     * Backend kind. Defaults to "managed".
     * "managed" lets flare-node choose embedded or s3-proxy based on server config.
     */
    kind?: string;
    prefix?: string;
    region?: string;
    /** Advanced: explicit s3 endpoint (only needed for kind="s3"). */
    endpoint?: string;
    accessKey?: string;
    secretKey?: string;
    dataDir?: string;
    forcePathStyle?: boolean;
}

/** Object metadata without content. */
export interface StorageObjectMeta {
    key: string;
    bucket: string;
    size: number;
    contentType: string;
    access?: "public" | "private";
    url?: string;
    encrypted: boolean;
    createdAt?: unknown;
    updatedAt?: unknown;
}

/** Upload an object to a bucket. */
export interface PutObjectInput {
    bucket: string;
    /** Object key (path inside the bucket). */
    key: string;
    /**
     * Object body. Accepted forms:
     * - `string` — UTF-8 text
     * - `Uint8Array` / `ArrayBuffer` — raw bytes
     * - `Blob` — browser File / Blob
     * - `contentBase64` field on the object — pre-encoded base64 string
     */
    body?: string | Uint8Array | ArrayBuffer | Blob;
    /** Pre-encoded base64 body. Mutually exclusive with `body`. */
    contentBase64?: string;
    /**
     * Prefer legacy base64 upload path.
     *
     * Default is `false` (raw signed URL upload).
     * If true and payload size exceeds `base64MaxBytes`, SDK auto-falls back to raw upload.
     */
    base64?: boolean;
    /**
     * Max payload bytes allowed for base64 path before auto-fallback to raw upload.
     * Default: 4 MiB.
     */
    base64MaxBytes?: number;
    contentType?: string;
    /** Public/private object access. Defaults to public. */
    access?: "public" | "private";
    /** Encrypt at rest with AES-256-GCM. Defaults to false. */
    encrypt?: boolean;
    /** Upload progress callback. Only fires in browser environments. */
    onProgress?: (progress: StorageProgress) => void;
}

export interface PutObjectResult {
    ok: boolean;
    bucket: string;
    key: string;
    access: "public" | "private";
    /** Alias of contentType for compatibility with legacy callers. */
    type?: string;
    contentType?: string;
    url?: string;
    size: number;
    encrypted: boolean;
}

export interface GetObjectInput {
    bucket: string;
    key: string;
    /** Decrypt on download. Defaults to true. */
    decrypt?: boolean;
}

export interface GetObjectResult {
    ok: boolean;
    bucket: string;
    key: string;
    /** Base64-encoded content. */
    contentBase64: string;
    contentType: string;
    size: number;
    encrypted: boolean;
}

export interface GetObjectUrlInput {
    bucket: string;
    key: string;
    /** Decrypt on download. Defaults to true. */
    decrypt?: boolean;
    /** Signed URL ttl in seconds. Defaults to server policy. */
    expiresInSeconds?: number;
    /** Force attachment response for browser-displayable media. */
    forceDownload?: boolean;
    /** Allowed request origins for accessing the signed file. Defaults to ["*"]. */
    allowedOrigins?: string[];
    /** Restrict access to embedded media contexts (<img>, <video>, <audio>). */
    embedOnly?: boolean;
}

export interface DownloadObjectInput extends GetObjectUrlInput {
    /** Suggested filename for browser downloads. Defaults to key basename. */
    filename?: string;
    /** Open in a new tab instead of forcing attachment download. */
    openInNewTab?: boolean;
}

export interface DownloadObjectResult {
    ok: boolean;
    url: string;
    filename: string;
    /** True when browser click dispatch occurred. */
    triggered: boolean;
}

export interface HeadObjectInput {
    bucket: string;
    key: string;
}

export interface HeadObjectsInput {
    bucket: string;
    keys: string[];
}

export interface ListObjectsInput {
    bucket: string;
    /** Key prefix filter. */
    prefix?: string;
    limit?: number;
    /** Continuation token from a previous ListObjectsResult. */
    cursor?: string;
}

export interface ListObjectsResult {
    bucket: string;
    objects: StorageObjectMeta[];
    count: number;
    hasMore: boolean;
    /** Pass to the next listObjects() call to get the next page. */
    cursor?: string;
}

export interface CopyObjectInput {
    sourceBucket: string;
    sourceKey: string;
    destBucket: string;
    destKey: string;
}

export interface DeleteObjectInput {
    bucket: string;
    key: string;
}

export interface DeleteObjectsInput {
    bucket: string;
    keys: string[];
}

/** Signed URL input using bucket/key names instead of serverId. */
export interface StorageSignedUrlInput {
    bucket: string;
    key: string;
    action: FlareStorageSignedAction;
    expiresInSeconds?: number;
    sizeBytes?: number;
    contentType?: string;
    access?: "public" | "private";
    encrypt?: boolean;
    decrypt?: boolean;
    forceDownload?: boolean;
    allowedOrigins?: string[];
    embedOnly?: boolean;
}

/** Bucket-level security rules. Maps to flare storage rules DSL. */
export interface BucketPolicyInput {
    rulesDsl?: string;
    rules?: Record<string, unknown>;
    rulesHistoryPolicy?: FlareStorageRulesPolicy;
}

/** CORS rule for a bucket. */
export interface BucketCorsRule {
    allowedOrigins: string[];
    allowedMethods: ("GET" | "PUT" | "POST" | "DELETE" | "HEAD")[];
    allowedHeaders?: string[];
    exposeHeaders?: string[];
    maxAgeSeconds?: number;
}

export interface SendEmailInput {
    to: string | string[];
    tag: string;
    values?: Record<string, unknown>;
    authAppId?: string;
}

export interface EmailSendResult {
    sent: boolean;
    appId: string;
    tag: string;
    recipientCount: number;
    acceptedCount: number;
    rejectedCount: number;
    includeVerificationLink?: boolean;
    linkId?: string;
    verifyUrl?: string;
    messageId?: string;
}

export interface VerifyEmailLinkInput {
    token: string;
    tag?: string;
    email?: string;
    authAppId?: string;
}

export interface EmailLinkVerifyResult {
    verified: boolean;
    alreadyVerified: boolean;
    appId: string;
    linkId: string;
    email: string;
    tag: string;
    verifiedAt?: string;
    acceptedByUid?: string;
}

export type AuthStateListener = (session: FlareAuthSession & FlareAuthUser | null) => void;
export type AuthConfigListener = (conf: FlareAuthConfig) => void;

export interface SubscribeOptions {
    skipSnapshot?: boolean;
}

// Query types (mirrors server)
export type QueryOperator =
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "in" | "not-in"
  | "array-contains" | "array-contains-any"
    | "elem-match"
  | "like" | "not-like"
  | "contains"
  | "exists" | "not-exists";

export interface QueryConfig {
    field: string;
    op:    QueryOperator;
    value: unknown;
}

/** OR group */
export interface OrFilter { or: AnyFilter[]; }
/** AND group */
export interface AndFilter { and: AnyFilter[]; }
export type AnyFilter = QueryConfig | OrFilter | AndFilter;

export type WhereCondition = Record<string, string | number | boolean | any[] | FlareSentinel>;

export interface OrderByClause  { field: string; dir?: "asc" | "desc"; }
export interface GroupByClause  { fields: string[]; }
export interface HavingClause   { field: string; op: "==" | "!=" | "<" | "<=" | ">" | ">="; value: number; }
export interface CursorValue    { values: unknown[]; }

export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max" | "distinct";
export interface AggregateSpec  { fn: AggregateFunction; field?: string; alias?: string; }

/**
 * Join definition used by CollectionReference.Join().
 *
 * Example:
 *   Join("tasks", { source: "id", target: "boardId", as: "tasks" })
 */
export interface JoinQueryPattern {
    where?:         AnyFilter[];
    orderBy?:       OrderByClause[];
    limit?:         number;
    offset?:        number;
    startAt?:       CursorValue;
    startAfter?:    CursorValue;
    endAt?:         CursorValue;
    endBefore?:     CursorValue;
    aggregate?:     AggregateSpec[];
    groupBy?:       GroupByClause;
    having?:        HavingClause[];
    vectorSearch?:  VectorSearchClause;
    select?:        string[];
    distinctField?: string;
}

export interface NestedJoinClause extends JoinQueryPattern {
    /** Joined collection name for this nested join. */
    collection: string;
    /** Field from the parent join result. */
    source:     string;
    /** Field from this nested collection to match source. */
    target:     string;
    /** Alias where nested rows are attached in each parent join row. */
    as:         string;
    /** If true, expect at most one joined row. */
    single?:    boolean;
    /** Recursive nested joins. */
    joins?:     NestedJoinClause[];
}

export interface JoinClause extends JoinQueryPattern {
    /** Field from the base collection (defaults to `id` when omitted). */
    source?:      string;
    /** Field from the joined collection that should match source. */
    target:       string;
    /** Alias where joined rows will be attached in each result object. */
    as:           string;
    /** If true, expect at most one joined row (object instead of array on server side). */
    single?:      boolean;
    /** Optional nested joins under this join. */
    joins?:       NestedJoinClause[];
}

/** Internal wire-ready join shape sent to server query engine. */
export interface StructuredJoinClause extends JoinQueryPattern {
    from:         string;
    localField:   string;
    foreignField: string;
    as:           string;
    single?:      boolean;
    joins?:       StructuredJoinClause[];
}

export interface VectorSearchClause {
    field:     string;
    vector:    number[];
    k:         number;
    metric?:   "cosine" | "euclidean" | "dotProduct";
    minScore?: number;
}

/** Full structured query (document query + SQL-style feature set) */
export interface StructuredQuery {
    where?:         AnyFilter[];
    orderBy?:       OrderByClause[];
    limit?:         number;
    offset?:        number;
    startAt?:       CursorValue;
    startAfter?:    CursorValue;
    endAt?:         CursorValue;
    endBefore?:     CursorValue;
    aggregate?:     AggregateSpec[];
    groupBy?:       GroupByClause;
    having?:        HavingClause[];
    joins?:         StructuredJoinClause[];
    vectorSearch?:  VectorSearchClause;
    select?:        string[];
    distinctField?: string;
}

export type QueryPresetSpec<
    Params extends Record<string, unknown> = Record<string, unknown>,
    Row = any,
> = {
    params: Params;
    row: Row;
};

export type QueryPresetMap = Record<string, QueryPresetSpec<any, any>>;

export type QueryPresetParams<TSpec> = TSpec extends QueryPresetSpec<infer Params, any>
    ? Params
    : Record<string, unknown>;

export type QueryPresetRow<TSpec> = TSpec extends QueryPresetSpec<any, infer Row>
    ? Row
    : any;

// Callbacks
export type ChangeOperation = 'insert' | 'update' | 'replace' | 'delete';

/**
 * Fired once when the subscription is first established.
 * `data` is always an array — the full matching collection snapshot.
 */
export interface SnapshotEvent<T = any> {
    type:           'snapshot';
    subscriptionId: string;
    collection:     string;
    data:           T[];
    // snapshot never carries docId / operation
}

/**
 * Fired on every subsequent document mutation that matches the subscription query.
 * `data` is the single affected document (null on delete).
 */
export interface ChangeEvent<T = any> {
    type:           'change';
    subscriptionId: string;
    collection:     string;
    docId:          string;           // always present on change
    operation:      ChangeOperation;
    data:           T | null;         // null only when operation === 'delete'
}

/** Discriminated union — narrow on `event.type` to get the right shape. */
export type SubscriptionData<T = any> = SnapshotEvent<T> | ChangeEvent<T>;

export type SubscriptionCallback<T = any> = (data: SubscriptionData<T>) => void;
export interface SubscriptionError {
    code?: string;
    message: string;
    permissionDenied: boolean;
    raw?: unknown;
}
export type SubscriptionErrorCallback = (error: SubscriptionError) => void;
export interface SubscriptionHandle {
    (): void;
    unsubscribe: () => void;
    onError: (callback: SubscriptionErrorCallback) => SubscriptionHandle;
    onPermissionDenied: (callback: SubscriptionErrorCallback) => SubscriptionHandle;
    catch: (callback: SubscriptionErrorCallback) => SubscriptionHandle;
}
export type DocAddedCallback<T = any>     = (data: T, docId: string) => void;
export type DocUpdatedCallback<T = any>   = (data: T, docId: string) => void;
export type DocDeletedCallback<T = any>   = (docId: string) => void;
export type DocChangedCallback<T = any>   = (data: T | null, docId: string, operation: ChangeOperation) => void;

export type BulkWriteOperation = 'addMany' | 'updateMany' | 'deleteMany';

export interface BulkWriteProgress {
    operation: BulkWriteOperation;
    processed: number;
    succeeded: number;
    failed: number;
    total?: number;
    percent?: number;
    lastDocId?: string;
    lastError?: unknown;
}

export interface BulkWriteResult {
    operation: BulkWriteOperation;
    processed: number;
    succeeded: number;
    failed: number;
    total?: number;
}

export interface BulkWriteOptions {
    /** How many operations to execute per chunk; defaults to 250. */
    batchSize?: number;
    /** Number of in-flight writes within each chunk; defaults to 1. */
    concurrency?: number;
    /** Continue processing remaining items after individual failures. */
    continueOnError?: boolean;
    /** Optional cancellation signal for long-running bulk writes. */
    signal?: AbortSignal;
    /** Progress callback invoked after each processed item. */
    onProgress?: (progress: BulkWriteProgress) => void;
}

export interface UpdateManyItem<T = any> {
    id: string;
    data: Partial<T>;
}

export type StreamFlushReason = 'snapshot' | 'change-batch';

export interface CollectionStreamOptions<T = any> {
    /** Delay before a queued burst is flushed to listeners. */
    flushMs?: number;
    /** Flush immediately when queued changes reach this count. */
    maxBatchSize?: number;
    /** Field used to identify docs inside snapshots when getId is not provided. */
    idField?: keyof T & string;
    /** Custom identifier extractor for snapshot rows. */
    getId?: (doc: T) => string | undefined;
    /** Where newly inserted docs should be placed when they were not in snapshot. */
    insertAt?: 'start' | 'end';
    /** Optional cap to keep only the newest N docs in local stream state. */
    maxDocs?: number;
    /** Optional local sort run after flush. */
    sort?: (a: T, b: T) => number;
}

export interface CollectionStreamMeta {
    reason: StreamFlushReason;
    batchSize: number;
    version: number;
    ready: boolean;
}

export type CollectionStreamListener<T = any> = (rows: readonly T[], meta: CollectionStreamMeta) => void;

export interface CollectionStream<T = any> {
    /** Subscribe to stream updates (call unsubscribe to stop). */
    subscribe: (listener: CollectionStreamListener<T>, emitCurrent?: boolean) => () => void;
    /** Returns the latest immutable snapshot of rows. */
    getSnapshot: () => readonly T[];
    /** Returns true after the initial snapshot has been received. */
    isReady: () => boolean;
    /** Monotonic version incremented on each flush. */
    getVersion: () => number;
    /** Stop the underlying realtime subscription and cleanup timers/listeners. */
    close: () => void;
    /** Attach subscription-level error handler. */
    onError: (callback: SubscriptionErrorCallback) => CollectionStream<T>;
    /** Attach permission-denied handler. */
    onPermissionDenied: (callback: SubscriptionErrorCallback) => CollectionStream<T>;
}

export interface CollectionExternalStore<T = any> {
    /** Standard external-store subscribe signature used by UI store hooks. */
    subscribe: (onStoreChange: () => void) => () => void;
    /** Returns current immutable rows snapshot. */
    getSnapshot: () => readonly T[];
    /** Server snapshot fallback for SSR-safe store hooks. */
    getServerSnapshot: () => readonly T[];
    /** Access to underlying realtime stream for advanced handlers. */
    stream: CollectionStream<T>;
    /** Stops realtime stream and detaches listeners. */
    destroy: () => void;
}

export interface DocumentSnapshot<T = any> { id: string; data: T | null; exists: boolean; }
export interface QuerySnapshot<T = any>    { docs: DocumentSnapshot<T>[]; size: number; empty: boolean; }

export interface OfflineOperation {
    id:         string;
    type:       'write' | 'delete';
    collection: string;
    docId:      string;
    data?:      Record<string, unknown>;
    merge?:     boolean;
    clientTs:   number;
}

export interface AuthResult { uid: string; token?: string; }
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

export interface AuthWithPendingVerificationResult { 
    verificationRequired: true; 
    created: true; 
    emailSent: boolean; 
    preview?: { 
        code: string; 
        link: string 
    } 
}

export interface AuthWithTokenResult extends AuthResult {
    accessToken: string;
    refreshToken: string | null;
    authToken: AuthToken;
    created: boolean;
}

// Presence
export interface PresenceMember {
    uid:      string;
    socketId: string;
    room:     string;
    meta?:    Record<string, unknown>;
    joinedAt: number;
    lastSeen: number;
}

export type PresenceCallback        = (members: PresenceMember[]) => void;
export type PresenceJoinCallback    = (member: PresenceMember) => void;
export type PresenceLeaveCallback   = (uid: string) => void;

// Vector
/** Fields marked as vector will be auto-embedded before write */
export type VectorFieldConfig = {
    /** Dimensions of the vector (e.g. 1536 for OpenAI ada-002) */
    dimensions: number;
    /** Mode for this field: text (default) or image */
    mode?: "text" | "image";
    /** Optional custom embedding function; defaults to client-configured embedder.
        Signature accepts either plain text or an object { contentBase64 } for images. */
    embed?: (input: string | { contentBase64: string; mime?: string }) => Promise<number[]>;
};

// Rules mapping helpers
export type RulePermission = "create" | "read" | "update" | "delete";

export interface FlareRule {
    id: string;
    name: string;
    auth: "any" | "guest" | "auth";
    collection: string;
    document?: string;
    condition?: string;
    permissions: RulePermission[];
}

export interface SecurityRuleEntry {
    ".read"?: string;
    ".write"?: string;
    ".create"?: string;
    ".update"?: string;
    ".delete"?: string;
}

export type SecurityRulesMap = Record<string, SecurityRuleEntry>;

const ruleAuthToExpr = (auth: FlareRule["auth"]): string => {
    if (auth === "guest") return "auth == null";
    if (auth === "auth") return "auth != null";
    return "true";
};

const mergeAuthAndCondition = (authExpr: string, condition?: string): string => {
    const trimmed = String(condition ?? "").trim();
    if (!trimmed) return authExpr;
    if (authExpr === "true") return trimmed;
    return `(${authExpr}) && (${trimmed})`;
};

const splitAuthAndCondition = (expr?: string): { auth: FlareRule["auth"]; condition?: string } => {
    const normalized = String(expr ?? "").trim();
    if (!normalized || normalized === "false") return { auth: "any" };

    if (normalized === "auth != null") return { auth: "auth" };
    if (normalized === "auth == null") return { auth: "guest" };
    if (normalized === "true") return { auth: "any" };

    const grouped = normalized.match(/^\((auth != null|auth == null|true)\)\s*&&\s*\((.+)\)$/);
    if (grouped) {
        return {
            auth: exprToRuleAuth(grouped[1]),
            condition: grouped[2].trim(),
        };
    }

    const flat = normalized.match(/^(auth != null|auth == null|true)\s*&&\s*(.+)$/);
    if (flat) {
        return {
            auth: exprToRuleAuth(flat[1]),
            condition: flat[2].trim(),
        };
    }

    return { auth: "any", condition: normalized };
};

const exprToRuleAuth = (expr?: string): FlareRule["auth"] => {
    const normalized = String(expr ?? "").trim();
    if (normalized === "auth == null") return "guest";
    if (normalized === "auth != null") return "auth";
    return "any";
};

export const flareRulesToSecurityMap = (rules: FlareRule[]): SecurityRulesMap => {
    const map: SecurityRulesMap = {};
    for (const rule of rules) {
        const collection = String(rule.collection || "").trim();
        if (!collection) continue;

        const key = collection === "any" ? "*" : collection;
        const authExpr = mergeAuthAndCondition(ruleAuthToExpr(rule.auth), rule.condition);

        map[key] = {
            ".read": rule.permissions.includes("read") ? authExpr : "false",
            ".create": rule.permissions.includes("create") ? authExpr : "false",
            ".update": rule.permissions.includes("update") ? authExpr : "false",
            ".delete": rule.permissions.includes("delete") ? authExpr : "false",
        };
    }
    return map;
};

export const securityMapToFlareRules = (rules: SecurityRulesMap): FlareRule[] => {
    return Object.entries(rules).map(([collection, permission], index) => {
        const readExpr = permission?.[".read"];
        const createExpr = permission?.[".create"];
        const updateExpr = permission?.[".update"];
        const deleteExpr = permission?.[".delete"];
        const writeExpr = permission?.[".write"];
        const permissions: RulePermission[] = [];

        if (typeof readExpr === "string" && readExpr.trim() !== "false") {
            permissions.push("read");
        }
        const createAllowed = (typeof createExpr === "string" && createExpr.trim() !== "false")
            || (typeof writeExpr === "string" && writeExpr.trim() !== "false");
        const updateAllowed = (typeof updateExpr === "string" && updateExpr.trim() !== "false")
            || (typeof writeExpr === "string" && writeExpr.trim() !== "false");
        const deleteAllowed = (typeof deleteExpr === "string" && deleteExpr.trim() !== "false")
            || (typeof writeExpr === "string" && writeExpr.trim() !== "false");

        if (createAllowed) {
            permissions.push("create");
        }
        if (updateAllowed) {
            permissions.push("update");
        }
        if (deleteAllowed) {
            permissions.push("delete");
        }

        const baseExpr = readExpr || createExpr || updateExpr || deleteExpr || writeExpr;
        const parsed = splitAuthAndCondition(baseExpr);

        return {
            id: `${collection}-${index}`,
            name: collection === "*" ? "All Collections" : collection,
            auth: parsed.auth,
            collection: collection === "*" ? "any" : collection,
            condition: parsed.condition,
            permissions,
        };
    });
};

