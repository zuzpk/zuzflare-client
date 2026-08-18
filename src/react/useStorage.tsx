import { useCallback, useRef, useState } from "react"
import type { DeleteObjectInput, PutObjectInput, PutObjectResult, StorageProgress } from "../types"

export enum Status {
    Error = -1,
    Idle = 0,
    FetchingServer = 1,
    Uploading = 2,
    Saving = 3,
    Saved = 4,
} 

export interface QueItem {
    id: string,
    file: File,
    bucket: string,
    objectKey: string,
    contentType?: string,
    access?: "public" | "private",
    encrypt?: boolean,
    base64?: boolean,
    base64MaxBytes?: number,
    progress: number,
    speed: number,
    eta: number,
    bytes: number,
    uploadedBytes: number,
    error?: string,
    result?: PutObjectResult,
    status: Status
}

export type Uploadify = {
    que: QueItem[],
    index: number,
    speed: number,
    stamp: number | null,
    token: string | null,
    status: Status
}

export type UseStorageInput = {
    id?: string,
    file: File,
    bucket: string,
    key?: string,
    contentType?: string,
    access?: "public" | "private",
    encrypt?: boolean,
    base64?: boolean,
    base64MaxBytes?: number,
}

export type UseStorageOptions = {
    keyResolver?: (input: UseStorageInput, index: number) => string,
    autoStartOnAdd?: boolean,
    onItemComplete?: (item: QueItem, result: PutObjectResult) => void,
    onItemError?: (item: QueItem, error: Error) => void,
    onQueueComplete?: (items: QueItem[]) => void,
}

export interface UseStorageDriver {
    putObject(input: PutObjectInput): Promise<PutObjectResult>
    deleteObject?(input: DeleteObjectInput): Promise<{ ok: boolean }>
}

export type UseStorageHook = Uploadify & {
    isPaused: boolean,
    running: boolean,
    hasPending: boolean,
    current: QueItem | null,
    addToQueue: (input: UseStorageInput | UseStorageInput[]) => string[],
    remove: (id: string) => void,
    clear: () => void,
    clearDone: () => void,
    retry: (id: string) => void,
    retryAllFailed: () => void,
    start: () => Promise<void>,
    pause: () => void,
    reset: () => void,
}

function now(): number {
    return Date.now()
}

function generateQueueItemId(): string {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === "function") {
        return randomUUID.call(globalThis.crypto).replace(/-/g, "").substring(0, 20)
    }

    return `${now()}-${Math.random().toString(36).slice(2, 10)}`
}

function buildDefaultKey(input: UseStorageInput): string {
    const cleanName = String(input.file?.name ?? "file").trim() || "file"
    return cleanName.replace(/^\/+|\/+$/g, "")
}

function makeQueueItem(
    input: UseStorageInput,
    queueIndex: number,
    keyResolver?: (input: UseStorageInput, index: number) => string,
): QueItem {
    const itemKey = (keyResolver?.(input, queueIndex) ?? input.key ?? buildDefaultKey(input)).trim()

    return {
        id: input.id ?? generateQueueItemId(),
        file: input.file,
        bucket: String(input.bucket ?? "").trim(),
        objectKey: itemKey,
        contentType: input.contentType,
        access: input.access,
        encrypt: input.encrypt,
        base64: input.base64,
        base64MaxBytes: input.base64MaxBytes,
        progress: 0,
        speed: 0,
        eta: 0,
        bytes: Math.max(0, Number(input.file?.size ?? 0)),
        uploadedBytes: 0,
        status: Status.Idle,
    }
}

function toProgressSnapshot(progress: StorageProgress, fallbackTotal: number): StorageProgress {
    const total = progress.total > 0 ? progress.total : fallbackTotal
    const loaded = Math.max(0, Math.min(progress.loaded, total || progress.loaded))
    const percent = total > 0 ? Math.round((loaded / total) * 100) : Math.max(0, Math.min(100, progress.percent || 0))

    return {
        loaded,
        total,
        percent,
    }
}

const useStorage = (storage: UseStorageDriver, options: UseStorageOptions = {}): UseStorageHook => {
    const [, setTick] = useState(0)

    const self = useRef<Uploadify>({
        que: [],
        index: -1,
        speed: 0,
        stamp: null,
        token: null,
        status: Status.Idle
    })

    const pausedRef = useRef(false)
    const runningRef = useRef(false)
    const processPromiseRef = useRef<Promise<void> | null>(null)

    const update = useCallback(() => {
        setTick((value) => value + 1)
    }, [])

    const setItem = useCallback((id: string, updater: (item: QueItem) => QueItem) => {
        const index = self.current.que.findIndex((item) => item.id === id)
        if (index < 0) return
        self.current.que[index] = updater(self.current.que[index])
    }, [])

    const hasPending = useCallback(
        () => self.current.que.some((item) => item.status === Status.Idle || item.status === Status.Error),
        [],
    )

    const refreshGlobalStatus = useCallback(() => {
        const current = self.current
        const item = current.que[current.index]

        if (runningRef.current && item && item.status === Status.Uploading) {
            current.status = Status.Uploading
            current.speed = item.speed
            return
        }

        if (pausedRef.current && current.que.some((q) => q.status === Status.Idle || q.status === Status.Error)) {
            current.status = Status.Idle
            current.speed = 0
            return
        }

        if (current.que.length > 0 && current.que.every((q) => q.status === Status.Saved)) {
            current.status = Status.Saved
            current.speed = 0
            return
        }

        if (current.que.some((q) => q.status === Status.Error)) {
            current.status = Status.Error
            current.speed = 0
            return
        }

        current.status = Status.Idle
        current.speed = 0
    }, [])

    const processQueue = useCallback(async (): Promise<void> => {
        if (runningRef.current) {
            return processPromiseRef.current ?? Promise.resolve()
        }

        runningRef.current = true

        const run = (async () => {
            while (!pausedRef.current) {
                const nextIndex = self.current.que.findIndex((item) => item.status === Status.Idle || item.status === Status.Error)
                if (nextIndex < 0) break

                self.current.index = nextIndex
                const item = self.current.que[nextIndex]
                const startedAt = now()
                let lastLoaded = 0
                let lastTs = startedAt

                setItem(item.id, (current) => ({
                    ...current,
                    status: Status.Uploading,
                    progress: 0,
                    speed: 0,
                    eta: current.bytes > 0 ? Number.POSITIVE_INFINITY : 0,
                    uploadedBytes: 0,
                    error: undefined,
                }))
                self.current.stamp = startedAt
                refreshGlobalStatus()
                update()

                try {
                    const result = await storage.putObject({
                        bucket: item.bucket,
                        key: item.objectKey,
                        body: item.file,
                        contentType: item.contentType ?? item.file.type,
                        access: item.access,
                        encrypt: item.encrypt,
                        base64: item.base64,
                        base64MaxBytes: item.base64MaxBytes,
                        onProgress: (nextProgress) => {
                            const ts = now()
                            const safeProgress = toProgressSnapshot(nextProgress, item.bytes)
                            const elapsedMs = Math.max(1, ts - lastTs)
                            const deltaLoaded = Math.max(0, safeProgress.loaded - lastLoaded)
                            const bytesPerSecond = Math.round((deltaLoaded * 1000) / elapsedMs)
                            const remaining = Math.max(0, safeProgress.total - safeProgress.loaded)
                            const eta = bytesPerSecond > 0 ? Math.ceil(remaining / bytesPerSecond) : 0

                            lastLoaded = safeProgress.loaded
                            lastTs = ts

                            setItem(item.id, (current) => ({
                                ...current,
                                progress: safeProgress.percent,
                                speed: bytesPerSecond,
                                eta,
                                uploadedBytes: safeProgress.loaded,
                                bytes: safeProgress.total,
                                status: Status.Uploading,
                            }))

                            self.current.speed = bytesPerSecond
                            self.current.stamp = ts
                            update()
                        },
                    })

                    setItem(item.id, (current) => ({
                        ...current,
                        status: Status.Saved,
                        progress: 100,
                        speed: 0,
                        eta: 0,
                        uploadedBytes: current.bytes,
                        result,
                    }))

                    const completedItem = self.current.que.find((q) => q.id === item.id)
                    if (completedItem) {
                        options.onItemComplete?.(completedItem, result)
                    }
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err)
                    const errorObject = err instanceof Error ? err : new Error(message)

                    setItem(item.id, (current) => ({
                        ...current,
                        status: Status.Error,
                        speed: 0,
                        eta: 0,
                        error: message,
                    }))

                    const failedItem = self.current.que.find((q) => q.id === item.id)
                    if (failedItem) {
                        options.onItemError?.(failedItem, errorObject)
                    }
                }

                self.current.speed = 0
                refreshGlobalStatus()
                update()
            }

            runningRef.current = false
            self.current.index = -1
            self.current.speed = 0
            refreshGlobalStatus()

            const hasMore = hasPending()
            if (!hasMore) {
                options.onQueueComplete?.(self.current.que)
            }

            update()
        })()

        processPromiseRef.current = run.finally(() => {
            processPromiseRef.current = null
        })

        return processPromiseRef.current
    }, [hasPending, options, refreshGlobalStatus, setItem, storage, update])

    const addToQueue = useCallback((input: UseStorageInput | UseStorageInput[]): string[] => {
        const items = Array.isArray(input) ? input : [input]
        const ids: string[] = []

        for (const next of items) {
            const newItem = makeQueueItem(next, self.current.que.length, options.keyResolver)
            self.current.que.push(newItem)
            ids.push(newItem.id)
        }

        refreshGlobalStatus()
        update()

        if (options.autoStartOnAdd !== false && !pausedRef.current) {
            void processQueue()
        }

        return ids
    }, [options.autoStartOnAdd, options.keyResolver, processQueue, refreshGlobalStatus, update])

    const remove = useCallback((id: string) => {
        const currentIndex = self.current.que.findIndex((item) => item.id === id)
        if (currentIndex < 0) return
        const runningId = self.current.que[self.current.index]?.id
        if (runningId === id) return

        const item = self.current.que[currentIndex]
        if (item.status === Status.Saved) {
            if (typeof storage.deleteObject !== "function") {
                const removeErr = new Error("Storage driver does not implement deleteObject for completed uploads")
                setItem(id, (current) => ({
                    ...current,
                    status: Status.Error,
                    speed: 0,
                    eta: 0,
                    error: removeErr.message,
                }))
                const failedItem = self.current.que.find((q) => q.id === id)
                if (failedItem) {
                    options.onItemError?.(failedItem, removeErr)
                }
                refreshGlobalStatus()
                update()
                return
            }

            setItem(id, (current) => ({
                ...current,
                status: Status.Saving,
                speed: 0,
                eta: 0,
                error: undefined,
            }))
            refreshGlobalStatus()
            update()

            void (async () => {
                try {
                    await storage.deleteObject?.({ bucket: item.bucket, key: item.objectKey })

                    const idx = self.current.que.findIndex((q) => q.id === id)
                    if (idx < 0) return

                    const activeId = self.current.que[self.current.index]?.id
                    if (activeId === id) return

                    self.current.que.splice(idx, 1)
                    if (self.current.index > idx) {
                        self.current.index -= 1
                    }
                    refreshGlobalStatus()
                    update()
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err)
                    const errorObject = err instanceof Error ? err : new Error(message)

                    setItem(id, (current) => ({
                        ...current,
                        status: Status.Error,
                        speed: 0,
                        eta: 0,
                        error: message,
                    }))

                    const failedItem = self.current.que.find((q) => q.id === id)
                    if (failedItem) {
                        options.onItemError?.(failedItem, errorObject)
                    }
                    refreshGlobalStatus()
                    update()
                }
            })()
            return
        }

        self.current.que.splice(currentIndex, 1)
        if (self.current.index > currentIndex) {
            self.current.index -= 1
        }
        refreshGlobalStatus()
        update()
    }, [options, refreshGlobalStatus, setItem, storage, update])

    const clear = useCallback(() => {
        if (runningRef.current) return
        self.current.que = []
        self.current.index = -1
        self.current.speed = 0
        self.current.stamp = null
        self.current.token = null
        self.current.status = Status.Idle
        pausedRef.current = true
        update()
    }, [update])

    const clearDone = useCallback(() => {
        const runningId = self.current.que[self.current.index]?.id
        self.current.que = self.current.que.filter((item) => {
            if (item.id === runningId) return true
            return item.status !== Status.Saved
        })
        self.current.index = self.current.que.findIndex((item) => item.id === runningId)
        refreshGlobalStatus()
        update()
    }, [refreshGlobalStatus, update])

    const retry = useCallback((id: string) => {
        setItem(id, (item) => {
            if (item.status !== Status.Error) return item
            return {
                ...item,
                status: Status.Idle,
                progress: 0,
                speed: 0,
                eta: 0,
                uploadedBytes: 0,
                error: undefined,
                result: undefined,
            }
        })
        refreshGlobalStatus()
        update()
    }, [refreshGlobalStatus, setItem, update])

    const retryAllFailed = useCallback(() => {
        self.current.que = self.current.que.map((item) => {
            if (item.status !== Status.Error) return item
            return {
                ...item,
                status: Status.Idle,
                progress: 0,
                speed: 0,
                eta: 0,
                uploadedBytes: 0,
                error: undefined,
                result: undefined,
            }
        })
        refreshGlobalStatus()
        update()
    }, [refreshGlobalStatus, update])

    const pause = useCallback(() => {
        pausedRef.current = true
        refreshGlobalStatus()
        update()
    }, [refreshGlobalStatus, update])

    const start = useCallback(async () => {
        pausedRef.current = false
        refreshGlobalStatus()
        update()
        await processQueue()
    }, [processQueue, refreshGlobalStatus, update])

    const reset = useCallback(() => {
        if (runningRef.current) return
        pausedRef.current = true
        self.current.que = self.current.que.map((item) => ({
            ...item,
            progress: 0,
            speed: 0,
            eta: 0,
            uploadedBytes: 0,
            error: undefined,
            result: undefined,
            status: Status.Idle,
        }))
        self.current.index = -1
        self.current.speed = 0
        self.current.stamp = null
        self.current.token = null
        self.current.status = Status.Idle
        update()
    }, [update])

    const current = self.current.que[self.current.index] ?? null

    return {
        ...self.current,
        que: [...self.current.que],
        running: runningRef.current,
        isPaused: pausedRef.current,
        hasPending: hasPending(),
        current,
        addToQueue,
        remove,
        clear,
        clearDone,
        retry,
        retryAllFailed,
        start,
        pause,
        reset,
    }
    

}

export default useStorage