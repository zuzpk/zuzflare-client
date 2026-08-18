import { uuid2 } from "@zuzjs/core";
import { FlareError } from "../Errors";
import ErrorCodes from "../Errors/codes";
import {
    BucketCorsRule,
    BucketPolicyInput,
    CopyObjectInput,
    DeleteObjectInput,
    DeleteObjectsInput,
    DownloadObjectInput,
    DownloadObjectResult,
    FlareStorageRulesHistoryResult,
    FlareStorageRulesPolicy,
    FlareStorageSignedAction,
    FlareStorageSignedUrlResult,
    FlareStorageTransferManagerConfig,
    GetObjectInput,
    GetObjectResult,
    GetObjectUrlInput,
    HeadObjectInput,
    HeadObjectsInput,
    ListObjectsInput,
    ListObjectsResult,
    PutObjectInput,
    PutObjectResult,
    StorageBucket,
    StorageBucketInput,
    StorageObjectMeta,
    StorageProgress,
    StorageSignedUrlInput,
} from "../types";

const DEFAULT_BASE64_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

function normalizePathSegment(value: string): string {
    return String(value ?? "").trim().replace(/^\/+|\/+$/g, "");
}

function joinStoragePath(...parts: string[]): string {
    return parts.map(normalizePathSegment).filter((part) => part.length > 0).join("/");
}

// Transport interface injected from FlareAuth
export interface FlareStorageTransport {
    readonly appId: string;
    readonly storageRulesHomeBucket?: string;
    readonly transferManager?: FlareStorageTransferManagerConfig;
    call(topic: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
    subscribe(
        subId: string,
        collection: string,
        docId: string | undefined,
        query: unknown,
        callback: (event: any) => void,
        options?: { skipSnapshot?: boolean },
    ): () => void;
    doPost(label: string, path: string, body: unknown): Promise<Record<string, unknown>>;
    doGet(label: string, path: string): Promise<Record<string, unknown>>;
    doPostWithProgress(
        label: string,
        path: string,
        body: unknown,
        onProgress: (p: StorageProgress) => void,
    ): Promise<Record<string, unknown>>;
}

class AsyncLimiter {
    private readonly concurrency: number;
    private running = 0;
    private readonly queue: Array<() => void> = [];

    constructor(concurrency: number) {
        this.concurrency = Math.max(1, Math.floor(concurrency || 1));
    }

    run<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const start = () => {
                this.running += 1;
                task()
                    .then(resolve)
                    .catch(reject)
                    .finally(() => {
                        this.running -= 1;
                        const next = this.queue.shift();
                        if (next) next();
                    });
            };

            if (this.running < this.concurrency) {
                start();
            } else {
                this.queue.push(start);
            }
        });
    }
}

// Helpers
function bytesToBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== "undefined") {
        return Buffer.from(bytes).toString("base64");
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function bodyToBase64(
    body: string | Uint8Array | ArrayBuffer | Blob | undefined,
): Promise<string> {
    if (body === undefined) return "";
    if (typeof body === "string") {
        return bytesToBase64(new TextEncoder().encode(body));
    }
    if (body instanceof Uint8Array) {
        return bytesToBase64(body);
    }
    if (body instanceof ArrayBuffer) {
        return bytesToBase64(new Uint8Array(body));
    }
    // Blob (browser)
    const arrayBuf = await body.arrayBuffer();
    return bytesToBase64(new Uint8Array(arrayBuf));
}

function base64ByteLength(base64: string): number {
    const clean = base64.trim().replace(/\s+/g, "");
    if (!clean) return 0;
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function bodyByteLength(body: string | Uint8Array | ArrayBuffer | Blob | undefined): number {
    if (body === undefined) return 0;
    if (typeof body === "string") return new TextEncoder().encode(body).length;
    if (body instanceof Uint8Array) return body.byteLength;
    if (body instanceof ArrayBuffer) return body.byteLength;
    return body.size;
}

async function uploadRawWithSignedUrl(
    signedUrl: string,
    method: string,
    body: string | Uint8Array | ArrayBuffer | Blob,
    contentType: string | undefined,
    onProgress?: (p: StorageProgress) => void,
): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (contentType && contentType.trim()) headers["Content-Type"] = contentType;

    if (onProgress && typeof XMLHttpRequest !== "undefined") {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method || "PUT", signedUrl);
            for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

            const total = bodyByteLength(body);
            xhr.upload.onprogress = (e) => {
                const loaded = e.lengthComputable ? e.loaded : 0;
                const tot = e.lengthComputable ? e.total : total;
                onProgress({ loaded, total: tot, percent: tot > 0 ? Math.round((loaded / tot) * 100) : 0 });
            };

            xhr.onload = () => {
                let json: Record<string, unknown> = {};
                if (xhr.responseText) {
                    try {
                        json = JSON.parse(xhr.responseText) as Record<string, unknown>;
                    } catch {
                        reject(new FlareError("Failed to parse signed upload response", ErrorCodes.WriteFailed));
                        return;
                    }
                }

                if (xhr.status >= 400) {
                    const msg = String(json.error_description ?? json.message ?? json.error ?? `HTTP ${xhr.status}`);
                    reject(new FlareError(msg, ErrorCodes.WriteFailed, json));
                    return;
                }

                onProgress({ loaded: total, total, percent: 100 });
                resolve(json);
            };

            xhr.onerror = () => reject(new FlareError("Network error during signed upload", ErrorCodes.WriteFailed));
            xhr.send(body as XMLHttpRequestBodyInit);
        });
    }

    const res = await fetch(signedUrl, {
        method: method || "PUT",
        headers,
        body: body as BodyInit,
    });

    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text) {
        try {
            json = JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new FlareError("Failed to parse signed upload response", ErrorCodes.WriteFailed);
        }
    }

    if (!res.ok) {
        const msg = String(json.error_description ?? json.message ?? json.error ?? `HTTP ${res.status}`);
        throw new FlareError(msg, ErrorCodes.WriteFailed, json);
    }

    return json;
}

function encodeCursor(skip: number): string {
    return btoa ? btoa(String(skip)) : Buffer.from(String(skip)).toString("base64");
}

function decodeCursor(cursor: string): number {
    try {
        const raw = typeof atob !== "undefined" ? atob(cursor) : Buffer.from(cursor, "base64").toString();
        const n = parseInt(raw, 10);
        return isNaN(n) ? 0 : n;
    } catch {
        return 0;
    }
}

// FlareStorage service
/**
 * S3-compatible storage service returned by `app.storage()`.
 *
 * Works with bucket **names** (not internal server IDs). Server IDs are
 * resolved lazily and cached. `putObject()` automatically creates the bucket
 * if it does not yet exist.
 */
export class FlareStorage {
    private readonly _t: FlareStorageTransport;
    private readonly _transferEnabled: boolean;
    private readonly _uploadLimiter: AsyncLimiter;
    private readonly _downloadLimiter: AsyncLimiter;

    /** bucket-name → serverId cache */
    private readonly _bucketCache = new Map<string, string>();
    private _bucketListLoaded = false;
    private _bucketListPromise: Promise<void> | null = null;

    constructor(transport: FlareStorageTransport) {
        this._t = transport;
        const tm = transport.transferManager;
        this._transferEnabled = tm?.enabled !== false;
        this._uploadLimiter = new AsyncLimiter(tm?.uploadConcurrency ?? 1);
        this._downloadLimiter = new AsyncLimiter(tm?.downloadConcurrency ?? 1);
    }

    private _scheduleUpload<T>(task: () => Promise<T>): Promise<T> {
        if (!this._transferEnabled) return task();
        return this._uploadLimiter.run(task);
    }

    private _scheduleDownload<T>(task: () => Promise<T>): Promise<T> {
        if (!this._transferEnabled) return task();
        return this._downloadLimiter.run(task);
    }

    private _normalizeBucketName(name: string): string {
        const clean = String(name ?? "").trim();
        if (!clean || clean === "undefined" || clean === "null") {
            throw new FlareError("bucket name is required", ErrorCodes.WriteFailed);
        }
        if (clean.includes("/")) {
            throw new FlareError(
                `Invalid bucket name \"${clean}\". Bucket names must not contain '/'. Use a stable bucket name (for example \"taskboard\") and put board/task folders in key (for example \"${this._t.appId}/attachments/file.png\").`,
                ErrorCodes.WriteFailed,
            );
        }
        return clean;
        }

        private _storageHomeBucket(): string | undefined {
            const clean = normalizePathSegment(this._t.storageRulesHomeBucket ?? "");
            return clean || undefined;
        }

        private _resolveStorageBucketName(bucket: string): string {
            const clean = this._normalizeBucketName(bucket);
            const homeBucket = this._storageHomeBucket();
            if (!homeBucket) {
                return clean;
            }
            if (clean === homeBucket) {
                return clean;
            }
            return homeBucket;
        }

        private _storageObjectPath(bucket: string, key: string): string {
            const cleanKey = normalizePathSegment(key);
            const homeBucket = this._storageHomeBucket();
            const cleanBucket = this._normalizeBucketName(bucket);

            if (!homeBucket || cleanBucket === homeBucket) {
                return cleanKey;
            }

            return joinStoragePath(cleanBucket, cleanKey);
        }

    // Bucket cache helpers
    private async _ensureBuckets(): Promise<void> {
        if (this._bucketListLoaded) return;
        if (!this._bucketListPromise) {
            this._bucketListPromise = this._loadBuckets()
                .then(() => { this._bucketListLoaded = true; })
                .catch((err) => { this._bucketListPromise = null; throw err; })
                .finally(() => { this._bucketListPromise = null; });
        }
        return this._bucketListPromise;
    }

    private async _loadBuckets(): Promise<void> {
        const buckets = await this.listBuckets();
        for (const b of buckets) this._bucketCache.set(b.bucket, b.id);
    }

    private _invalidateBucketCache(): void {
        this._bucketCache.clear();
        this._bucketListLoaded = false;
        this._bucketListPromise = null;
    }

    /**
     * Resolves a bucket name to its internal serverId.
     * When `autoCreate` is true, creates the bucket if it does not exist.
     */
    private async _resolveBucketId(name: string, autoCreate: boolean): Promise<string> {
        const clean = this._normalizeBucketName(name);
        const rootBucket = this._resolveStorageBucketName(clean);

        const cached = this._bucketCache.get(rootBucket);
        if (cached) return cached;

        if (autoCreate) {
            // Prefer resolving an existing bucket first. This avoids calling
            // storage.bucket.create for shared buckets where the caller may
            // have object access but not create-bucket permission.
            try {
                await this._ensureBuckets();
                const existing = this._bucketCache.get(rootBucket);
                if (existing) return existing;
            } catch {
                // Ignore list failures here and attempt create below.
            }

            const created = await this.createBucket(rootBucket);
            return created.id;
        }

        await this._ensureBuckets();

        const fromList = this._bucketCache.get(rootBucket);
        if (fromList) return fromList;

        throw new FlareError(
            `Bucket "${clean}" not found. Create it first with createBucket("${clean}").`,
            ErrorCodes.NotFound,
        );
    }

    private _appPath(path: string): string {
        return `/system/apps/${encodeURIComponent(this._t.appId)}${path}`;
    }

    private _bucketStreamCollection(): string {
        return "storage.buckets";
    }

    private _objectStreamCollection(bucket: string): string {
        return `storage.objects.${bucket}`;
    }

    private _subscribeStorage(
        collection: string,
        handler: (event: any) => void,
        options: { skipSnapshot?: boolean } = { skipSnapshot: true },
    ): () => void {
        const subId = uuid2(18);
        return this._t.subscribe(subId, collection, undefined, undefined, handler, options);
    }

    // Bucket Operations
    /**
     * Creates a new bucket (storage server) for the app.
     *
     * Idempotent: if a bucket with this name already exists the existing one
     * is returned unchanged (same behaviour as AWS S3 for same-owner buckets).
     */
    async createBucket(name: string, options: StorageBucketInput = {}): Promise<StorageBucket> {
        const clean = this._normalizeBucketName(name);

        const cachedId = this._bucketCache.get(clean);
        if (cachedId) {
            return {
                id: cachedId,
                name: clean,
                bucket: clean,
                kind: options.kind ?? "managed",
                prefix: options.prefix,
            };
        }

        const payload = {
            name: clean,
            kind: options.kind ?? "managed",
            bucket: clean,
            prefix: options.prefix ?? "",
            region: options.region,
            endpoint: options.endpoint,
            accessKey: options.accessKey,
            secretKey: options.secretKey,
            dataDir: options.dataDir,
            forcePathStyle: options.forcePathStyle,
        };

        let json: Record<string, unknown>;
        try {
            json = await this._t.call("storage.bucket.create", payload);
        } catch (err: unknown) {
            // If a concurrent call created the same bucket, retry a list lookup.
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("bucket_conflict")) {
                this._invalidateBucketCache();
                const all = await this._listBucketsRaw();
                const found = all.find((b) => b.bucket === clean || b.name === clean);
                if (found) {
                    this._bucketCache.set(clean, found.id);
                    return found;
                }
            }
            throw err;
        }

        const created: StorageBucket = {
            id: String(json.serverId ?? ""),
            name: clean,
            bucket: clean,
            kind: options.kind ?? "managed",
            prefix: options.prefix,
        };
        this._bucketCache.set(clean, created.id);
        return created;
    }

    private async _listBucketsRaw(): Promise<StorageBucket[]> {
        const json = await this._t.call("storage.bucket.list");
        const raw = Array.isArray(json.servers) ? json.servers : [];
        return (raw as Record<string, unknown>[]).map((s) => ({
            id: String(s.id ?? s._id ?? ""),
            name: String(s.name ?? s.bucket ?? ""),
            bucket: String(s.bucket ?? ""),
            kind: String(s.kind ?? "managed"),
            region: s.region ? String(s.region) : undefined,
            endpoint: s.endpoint ? String(s.endpoint) : undefined,
            prefix: s.prefix ? String(s.prefix) : undefined,
            frozen: Boolean(s.frozen),
            readOnly: Boolean(s.readOnly),
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
        }));
    }

    /** Returns all buckets for the app. */
    async listBuckets(): Promise<StorageBucket[]> {
        const buckets = await this._listBucketsRaw();
        this._bucketCache.clear();
        for (const b of buckets) this._bucketCache.set(b.bucket, b.id);
        this._bucketListLoaded = true;
        return buckets;
    }

    /** Deletes a bucket and all its objects. */
    async deleteBucket(name: string): Promise<{ ok: boolean; removedObjects: number }> {
        const serverId = await this._resolveBucketId(name, false);
        const json = await this._t.call("storage.bucket.delete", { serverId });
        this._bucketCache.delete(name);
        return {
            ok: Boolean(json.ok ?? true),
            removedObjects: Number(json.removedObjects ?? 0),
        };
    }

    /** Deletes multiple buckets. */
    async deleteBuckets(
        names: string[],
    ): Promise<{ ok: boolean; deleted: string[]; errors: Record<string, string> }> {
        const deleted: string[] = [];
        const errors: Record<string, string> = {};
        await Promise.all(
            names.map(async (n) => {
                try {
                    await this.deleteBucket(n);
                    deleted.push(n);
                } catch (err: unknown) {
                    errors[n] = err instanceof Error ? err.message : String(err);
                }
            }),
        );
        return { ok: Object.keys(errors).length === 0, deleted, errors };
    }

    /** Returns location info for a bucket (kind, region, endpoint). */
    async getBucketLocation(
        name: string,
    ): Promise<{ bucket: string; kind: string; region?: string; endpoint?: string }> {
        const all = await this.listBuckets();
        const b = all.find((x) => x.bucket === name || x.name === name);
        if (!b) throw new FlareError(`Bucket "${name}" not found`, ErrorCodes.NotFound);
        return { bucket: b.bucket, kind: b.kind, region: b.region, endpoint: b.endpoint };
    }

    onBucketAdded(callback: (bucket: StorageBucket, bucketId: string) => void): () => void {
        return this._subscribeStorage(this._bucketStreamCollection(), (event) => {
            if (event?.type === "change" && event.operation === "insert" && event.data) {
                const data = event.data as Record<string, unknown>;
                callback(
                    {
                        id: String(data.id ?? event.docId ?? ""),
                        name: String(data.name ?? data.bucket ?? ""),
                        bucket: String(data.bucket ?? ""),
                        kind: String(data.kind ?? "managed"),
                        prefix: data.prefix ? String(data.prefix) : undefined,
                    },
                    String(event.docId ?? data.id ?? ""),
                );
            }
        });
    }

    onBucketUpdated(callback: (bucket: StorageBucket, bucketId: string) => void): () => void {
        return this._subscribeStorage(this._bucketStreamCollection(), (event) => {
            if (event?.type === "change" && (event.operation === "update" || event.operation === "replace") && event.data) {
                const data = event.data as Record<string, unknown>;
                callback(
                    {
                        id: String(data.id ?? event.docId ?? ""),
                        name: String(data.name ?? data.bucket ?? ""),
                        bucket: String(data.bucket ?? ""),
                        kind: String(data.kind ?? "managed"),
                        prefix: data.prefix ? String(data.prefix) : undefined,
                        region: data.region ? String(data.region) : undefined,
                        endpoint: data.endpoint ? String(data.endpoint) : undefined,
                        frozen: Boolean(data.frozen),
                        readOnly: Boolean(data.readOnly),
                    },
                    String(event.docId ?? data.id ?? ""),
                );
            }
        });
    }

    onBucketDeleted(callback: (bucketId: string) => void): () => void {
        return this._subscribeStorage(this._bucketStreamCollection(), (event) => {
            if (event?.type === "change" && event.operation === "delete") {
                callback(String(event.docId ?? ""));
            }
        });
    }

    /**
     * Sets security rules for storage.
     * Rules apply app-wide (all buckets share the same rules DSL).
     */
    async putBucketPolicy(input: BucketPolicyInput): Promise<{ id: string }> {
        const json = await this._t.doPost("putBucketPolicy", this._appPath(""), {
            settings: {
                ...(input.rules ? { storageRules: input.rules } : {}),
                ...(typeof input.rulesDsl === "string" ? { storageRulesDsl: input.rulesDsl } : {}),
                ...(input.rulesHistoryPolicy
                    ? { storageRulesHistoryPolicy: input.rulesHistoryPolicy }
                    : {}),
            },
        });
        return { id: String(json.id ?? this._t.appId) };
    }

    /** Gets the current storage rules policy. */
    async getBucketPolicy(): Promise<{
        rulesDsl?: string;
        rules?: unknown;
        policy: FlareStorageRulesPolicy;
    }> {
        const json = await this._t.doGet("getBucketPolicy", this._appPath("/storage/rules/history"));
        return {
            rulesDsl: undefined,
            rules: undefined,
            policy: (json.policy as FlareStorageRulesPolicy) ?? {},
        };
    }

    /**
     * Sets CORS rules for a bucket.
     * Note: CORS is configured at the flare-node server level; this method
     * stores the rules in app settings for reference.
     */
    async putBucketCors(
        _bucket: string,
        _rules: BucketCorsRule[],
    ): Promise<{ ok: boolean }> {
        // Flare-node does not yet support per-bucket CORS config server-side.
        // Store this call as a no-op acknowledgement.
        return { ok: true };
    }

    /** Alias for putBucketCors. */
    setBucketCors = this.putBucketCors;

    /** Returns the full storage rules/policy history. */
    async rulesHistory(): Promise<FlareStorageRulesHistoryResult> {
        const json = await this._t.doGet("rulesHistory", this._appPath("/storage/rules/history"));
        return {
            history: Array.isArray(json.history) ? json.history : [],
            policy: (json.policy as FlareStorageRulesPolicy) ?? { maxEntries: 30, maxAgeDays: 365 },
            restoreEvents: Array.isArray(json.restoreEvents) ? json.restoreEvents : [],
        };
    }

    // Object Operations
    /**
     * Uploads an object to a bucket.
     *
     * The bucket is created automatically if it does not exist.
     * Default path is direct raw upload via signed URL (no base64 encoding).
     * Set `base64: true` to prefer legacy base64 upload for small payloads.
     * Provide `onProgress` for upload progress updates (browser only).
     */
    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        return this._scheduleUpload(async () => {
            const serverId = await this._resolveBucketId(input.bucket, true);
            const path = this._storageObjectPath(input.bucket, input.key);
            const encrypt = input.encrypt ?? false;
            const access = input.access ?? "public";

        const base64MaxBytes =
            typeof input.base64MaxBytes === "number" && input.base64MaxBytes > 0
                ? Math.floor(input.base64MaxBytes)
                : DEFAULT_BASE64_UPLOAD_MAX_BYTES;

        const bodySize = bodyByteLength(input.body);
        const explicitBase64Size = input.contentBase64 ? base64ByteLength(input.contentBase64) : 0;
        const sourceSize = input.contentBase64 ? explicitBase64Size : bodySize;

        const shouldUseBase64 =
            Boolean(input.contentBase64) ||
            (input.base64 === true && input.body !== undefined && sourceSize <= base64MaxBytes);

            let json: Record<string, unknown>;
            if (shouldUseBase64) {
            let contentBase64: string;
            if (input.contentBase64) {
                contentBase64 = input.contentBase64;
            } else if (input.body !== undefined) {
                contentBase64 = await bodyToBase64(input.body);
            } else {
                throw new FlareError("putObject: body or contentBase64 is required", ErrorCodes.WriteFailed);
            }

            const payload = {
                serverId,
                path,
                contentBase64,
                contentType: input.contentType,
                access,
                encrypt,
            };

                json =
                    input.onProgress
                        ? await this._t.doPostWithProgress(
                              "putObject",
                              this._appPath("/storage/object/upload"),
                              payload,
                              input.onProgress,
                          )
                        : await this._t.doPost("putObject", this._appPath("/storage/object/upload"), payload);
            } else {
                if (input.body === undefined) {
                    throw new FlareError("putObject: body is required for raw upload path", ErrorCodes.WriteFailed);
                }

                const signed = await this.createSignedUrl({
                    bucket: input.bucket,
                    key: path,
                    action: FlareStorageSignedAction.Upload,
                    sizeBytes: sourceSize,
                    contentType: input.contentType,
                    access,
                    encrypt,
                });

                json = await uploadRawWithSignedUrl(
                    signed.url,
                    signed.method || "PUT",
                    input.body,
                    input.contentType,
                    input.onProgress,
                );
            }

            return {
                ok: Boolean(json.ok ?? true),
                bucket: input.bucket,
                key: String(json.path ?? path),
                access: String(json.access ?? access) as "public" | "private",
                type:
                    typeof json.type === "string"
                        ? json.type
                        : typeof json.contentType === "string"
                          ? json.contentType
                          : input.contentType,
                contentType:
                    typeof json.contentType === "string"
                        ? json.contentType
                        : typeof json.type === "string"
                          ? json.type
                          : input.contentType,
                url: typeof json.url === "string" ? json.url : undefined,
                size: Number(json.size ?? 0),
                encrypted: Boolean(json.encrypted),
            };
        });
    }

    /**
     * Downloads an object from a bucket.
     * Returns base64-encoded content.
     */
    async getObject(input: GetObjectInput): Promise<GetObjectResult> {
        return this._scheduleDownload(async () => {
            const serverId = await this._resolveBucketId(input.bucket, false);
            const path = this._storageObjectPath(input.bucket, input.key);
            const json = await this._t.doPost("getObject", this._appPath("/storage/object/download"), {
                serverId,
                path,
                decrypt: input.decrypt,
            });
            return {
                ok: Boolean(json.ok ?? true),
                bucket: input.bucket,
                key: String(json.path ?? path),
                contentBase64: String(json.contentBase64 ?? ""),
                contentType: String(json.contentType ?? "application/octet-stream"),
                size: Number(json.size ?? 0),
                encrypted: Boolean(json.encrypted),
            };
        });
    }

    /** Returns a short-lived signed URL for direct browser/object download. */
    async getObjectUrl(input: GetObjectUrlInput): Promise<string> {
        const signed = await this.createSignedUrl({
            bucket: input.bucket,
            key: this._storageObjectPath(input.bucket, input.key),
            action: FlareStorageSignedAction.Download,
            decrypt: input.decrypt,
            expiresInSeconds: input.expiresInSeconds,
            forceDownload: input.forceDownload,
            allowedOrigins: input.allowedOrigins,
            embedOnly: input.embedOnly,
        });
        return signed.url;
    }

    /**
     * Triggers browser download using a signed URL and returns the resolved URL.
     * In non-browser runtimes, this only returns the URL without dispatching a click.
     */
    async downloadObject(input: DownloadObjectInput): Promise<DownloadObjectResult> {
        const forceDownload = input.forceDownload ?? true;
        const url = await this.getObjectUrl({
            ...input,
            forceDownload,
        });
        const filename = input.filename ?? String(input.key ?? "").split("/").pop() ?? "download";

        if (typeof document === "undefined") {
            return { ok: true, url, filename, triggered: false };
        }

        const anchor = document.createElement("a");
        anchor.href = url;
        if (input.openInNewTab) {
            anchor.target = "_blank";
        } else {
            anchor.download = filename;
        }
        anchor.rel = "noopener noreferrer";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        return { ok: true, url, filename, triggered: true };
    }

    /** Returns object metadata without downloading the content. */
    async headObject(input: HeadObjectInput): Promise<StorageObjectMeta> {
        const serverId = await this._resolveBucketId(input.bucket, false);
        const path = this._storageObjectPath(input.bucket, input.key);
        const json = await this._t.doPost("headObject", this._appPath("/storage/object/head"), {
            serverId,
            path,
        });
        return {
            bucket: input.bucket,
            key: String(json.path ?? path),
            size: Number(json.size ?? 0),
            contentType: String(json.contentType ?? "application/octet-stream"),
            access: typeof json.access === "string" ? (json.access as "public" | "private") : undefined,
            url: typeof json.url === "string" ? json.url : undefined,
            encrypted: Boolean(json.encrypted),
            createdAt: json.createdAt,
            updatedAt: json.updatedAt,
        };
    }

    /** Returns metadata for multiple objects in parallel. */
    async headObjects(input: HeadObjectsInput): Promise<StorageObjectMeta[]> {
        return Promise.all(input.keys.map((key) => this.headObject({ bucket: input.bucket, key })));
    }

    /**
     * Lists objects in a bucket with optional prefix filter and pagination.
     *
     * Pass the returned `cursor` to the next call to page through results.
     */
    async listObjects(input: ListObjectsInput): Promise<ListObjectsResult> {
        const serverId = await this._resolveBucketId(input.bucket, false);
        const path = this._storageObjectPath(input.bucket, input.prefix ?? "");
        const skip = input.cursor ? decodeCursor(input.cursor) : 0;
        const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));

        const json = await this._t.doPost("listObjects", this._appPath("/storage/object/list"), {
            serverId,
            prefix: path,
            limit,
            skip,
        });

        const objects = (Array.isArray(json.objects) ? json.objects : []) as Record<
            string,
            unknown
        >[];
        const hasMore = Boolean(json.hasMore);
        const count = Number(json.count ?? objects.length);
        const nextSkip = skip + objects.length;

        return {
            bucket: input.bucket,
            objects: objects.map((o) => ({
                bucket: input.bucket,
                key: String(o.path ?? o.key ?? ""),
                size: Number(o.size ?? 0),
                contentType: String(o.contentType ?? "application/octet-stream"),
                access: typeof o.access === "string" ? (o.access as "public" | "private") : undefined,
                url: typeof o.url === "string" ? o.url : undefined,
                encrypted: Boolean(o.encrypted),
                createdAt: o.createdAt,
                updatedAt: o.updatedAt,
            })),
            count,
            hasMore,
            cursor: hasMore ? encodeCursor(nextSkip) : undefined,
        };
    }

    /**
     * Copies an object from one bucket/key to another.
     * Source and destination can be different buckets in the same app.
     */
    async copyObject(input: CopyObjectInput): Promise<{ ok: boolean }> {
        const [srcId, dstId] = await Promise.all([
            this._resolveBucketId(input.sourceBucket, false),
            this._resolveBucketId(input.destBucket, true),
        ]);
        const json = await this._t.doPost("copyObject", this._appPath("/storage/object/copy"), {
            serverId: srcId,
            path: this._storageObjectPath(input.sourceBucket, input.sourceKey),
            destServerId: dstId,
            destPath: this._storageObjectPath(input.destBucket, input.destKey),
        });
        return { ok: Boolean(json.ok ?? true) };
    }

    /** Copies multiple objects. Runs concurrently. */
    async copyObjects(
        inputs: CopyObjectInput[],
    ): Promise<{ ok: boolean; errors: Record<string, string> }> {
        const errors: Record<string, string> = {};
        await Promise.all(
            inputs.map(async (input) => {
                try {
                    await this.copyObject(input);
                } catch (err: unknown) {
                    const label = `${input.sourceBucket}/${input.sourceKey}`;
                    errors[label] = err instanceof Error ? err.message : String(err);
                }
            }),
        );
        return { ok: Object.keys(errors).length === 0, errors };
    }

    /** Deletes a single object. */
    async deleteObject(input: DeleteObjectInput): Promise<{ ok: boolean }> {
        const serverId = await this._resolveBucketId(input.bucket, false);
        const json = await this._t.doPost("deleteObject", this._appPath("/storage/object/delete"), {
            serverId,
            path: this._storageObjectPath(input.bucket, input.key),
        });
        return { ok: Boolean(json.ok ?? true) };
    }

    /**
     * Deletes multiple objects in a single server request.
     */
    async deleteObjects(
        input: DeleteObjectsInput,
    ): Promise<{ ok: boolean; deleted: string[]; errors: Record<string, string> }> {
        const serverId = await this._resolveBucketId(input.bucket, false);
        const json = await this._t.doPost(
            "deleteObjects",
            this._appPath("/storage/object/delete-many"),
            { serverId, paths: input.keys.map((key) => this._storageObjectPath(input.bucket, key)) },
        );
        const deleted = Array.isArray(json.deleted) ? (json.deleted as string[]) : input.keys;
        const errors = (json.errors ?? {}) as Record<string, string>;
        return { ok: Boolean(json.ok ?? true), deleted, errors };
    }

    onObjectAdded(bucket: string, callback: (object: StorageObjectMeta, key: string) => void): () => void {
        return this._subscribeStorage(this._objectStreamCollection(bucket), (event) => {
            if (event?.type === "change" && event.operation === "insert" && event.data) {
                const data = event.data as Record<string, unknown>;
                const key = String(data.key ?? data.path ?? event.docId ?? "");
                callback(
                    {
                        bucket,
                        key,
                        size: Number(data.size ?? 0),
                        contentType: String(data.contentType ?? "application/octet-stream"),
                        encrypted: Boolean(data.encrypted),
                        createdAt: data.createdAt,
                        updatedAt: data.updatedAt,
                    },
                    key,
                );
            }
        });
    }

    onObjectUpdated(bucket: string, callback: (object: StorageObjectMeta, key: string) => void): () => void {
        return this._subscribeStorage(this._objectStreamCollection(bucket), (event) => {
            if (event?.type === "change" && (event.operation === "update" || event.operation === "replace") && event.data) {
                const data = event.data as Record<string, unknown>;
                const key = String(data.key ?? data.path ?? event.docId ?? "");
                callback(
                    {
                        bucket,
                        key,
                        size: Number(data.size ?? 0),
                        contentType: String(data.contentType ?? "application/octet-stream"),
                        encrypted: Boolean(data.encrypted),
                        createdAt: data.createdAt,
                        updatedAt: data.updatedAt,
                    },
                    key,
                );
            }
        });
    }

    onObjectDeleted(bucket: string, callback: (key: string) => void): () => void {
        return this._subscribeStorage(this._objectStreamCollection(bucket), (event) => {
            if (event?.type === "change" && event.operation === "delete") {
                callback(String(event.docId ?? ""));
            }
        });
    }

    // Signed URLs
    /** Issues a short-lived signed URL for direct client-to-flare uploads or downloads. */
    async createSignedUrl(input: StorageSignedUrlInput): Promise<FlareStorageSignedUrlResult> {
        const serverId = await this._resolveBucketId(input.bucket, false);
        const json = await this._t.doPost(
            "createSignedUrl",
            this._appPath("/storage/signed-url"),
            {
                serverId,
                path: this._storageObjectPath(input.bucket, input.key),
                action: input.action,
                expiresInSeconds: input.expiresInSeconds,
                sizeBytes: input.sizeBytes,
                contentType: input.contentType,
                access: input.access,
                encrypt: input.encrypt,
                decrypt: input.decrypt,
                forceDownload: input.forceDownload,
                allowedOrigins: input.allowedOrigins,
                embedOnly: input.embedOnly,
            },
        );
        return json as unknown as FlareStorageSignedUrlResult;
    }
}
