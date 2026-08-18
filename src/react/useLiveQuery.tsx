import { useCallback, useEffect, useRef } from "react"
import { CollectionQuery } from "../Query/Collection"
import { CollectionStream } from "../types"

const useLiveQuery = (data: {
    query?: CollectionQuery<any, {}>,
    onData: (rows: readonly any[], meta: { ready: boolean }) => void,
    options?: { 
        flushMs: number, maxBatchSize: number, insertAt: 'end' | 'start', maxDocs: number 
    },
    forceReadyOnFirstEmission?: boolean,
    /**
     * Retry the stream when the very first emission is ready=true with zero rows.
     * Helps recover from transient first-load races on higher-latency networks.
     * Default 1.
     */
    firstReadyEmptyRetryCount?: number,
    /**
     * Delay in ms before retrying a first ready+empty emission.
     * Default 120.
     */
    firstReadyEmptyRetryDelayMs?: number,
    /**
     * Retry count when the first emission is ready=false with zero rows and
     * no follow-up emissions arrive within stalledFirstEmissionTimeoutMs.
     * Default 2.
     */
    stalledFirstEmissionRetryCount?: number,
    /**
     * Timeout in ms to consider the stream stalled after first ready=false empty emission.
     * Default 500.
     */
    stalledFirstEmissionTimeoutMs?: number,
    /**
     * Enable detailed stream trace logs for debugging race conditions.
     */
    debugTrace?: boolean,
    /**
     * Prefix used in debug logs to identify the caller.
     */
    debugLabel?: string,
    /** 
     * When the stream emits ready=true with zero rows, wait this many ms before 
     * forwarding the empty result. If a non-empty emission arrives within the window
     * the grace timer is cancelled and data is forwarded immediately.
     * Default 0 (no grace period — backwards-compatible).
     */
    emptyReadyGraceMs?: number,
}) => {

    const { 
        query, 
        options,
        onData,
        forceReadyOnFirstEmission = true,
        firstReadyEmptyRetryCount = 1,
        firstReadyEmptyRetryDelayMs = 120,
        stalledFirstEmissionRetryCount = 2,
        stalledFirstEmissionTimeoutMs = 500,
        debugTrace = false,
        debugLabel = `useLiveQuery`,
        emptyReadyGraceMs = 0,
    } = data

    const queryStream = useRef<CollectionStream<any> | null>(null)
    const streamStop = useRef<(() => void) | null>(null)
    const lastStreamSignature = useRef<string>(``)
    const streamGeneration = useRef<number>(0)
    const hasStreamEmitted = useRef<boolean>(false)
    const hasStreamDeliveredNonEmpty = useRef<boolean>(false)
    const onDataRef = useRef(onData)
    const queryRef = useRef<CollectionQuery<any, {}> | null>(query ?? null)
    const optionsRef = useRef(options)
    const forceReadyOnFirstEmissionRef = useRef(forceReadyOnFirstEmission)
    const firstReadyEmptyRetryCountRef = useRef(firstReadyEmptyRetryCount)
    const firstReadyEmptyRetryDelayMsRef = useRef(firstReadyEmptyRetryDelayMs)
    const firstReadyEmptyRetryRemainingRef = useRef(firstReadyEmptyRetryCount)
    const stalledFirstEmissionRetryCountRef = useRef(stalledFirstEmissionRetryCount)
    const stalledFirstEmissionTimeoutMsRef = useRef(stalledFirstEmissionTimeoutMs)
    const stalledFirstEmissionRetryRemainingRef = useRef(stalledFirstEmissionRetryCount)
    const stalledFirstEmissionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const debugTraceRef = useRef(debugTrace)
    const debugLabelRef = useRef(debugLabel)
    const emptyReadyGraceMsRef = useRef(emptyReadyGraceMs)
    const emptyReadyGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingEmptyReadyRef = useRef<{ rows: readonly any[] } | null>(null)
    const emissionCountRef = useRef<number>(0)

    const shouldTraceFromGlobal = () => {
        const g = globalThis as any
        const enabled = g?.__ZUZ_LIVE_QUERY_TRACE

        let persistedEnabled = false
        let persistedFilter: string | null = null

        try {
            if ( typeof window !== `undefined` && window.localStorage ) {
                persistedEnabled = window.localStorage.getItem(`__ZUZ_LIVE_QUERY_TRACE`) === `1`
                persistedFilter = window.localStorage.getItem(`__ZUZ_LIVE_QUERY_TRACE_FILTER`)
            }
        }
        catch {
            // Ignore storage access failures (private mode / blocked storage).
        }

        if ( !enabled && !persistedEnabled ) return false

        const filter = g?.__ZUZ_LIVE_QUERY_TRACE_FILTER ?? persistedFilter
        if ( !filter ) return true

        return String(debugLabelRef.current).toLowerCase().includes(String(filter).toLowerCase())
    }

    const logDebug = (...args: any[]) => {
        if ( debugTraceRef.current || shouldTraceFromGlobal() ) {
            console.log(`[${debugLabelRef.current}]`, ...args)
        }
    }

    useEffect(() => {
        onDataRef.current = onData
    }, [onData])

    useEffect(() => {
        queryRef.current = query ?? null
    }, [query])

    useEffect(() => {
        optionsRef.current = options
    }, [options])

    useEffect(() => {
        forceReadyOnFirstEmissionRef.current = forceReadyOnFirstEmission
    }, [forceReadyOnFirstEmission])

    useEffect(() => {
        firstReadyEmptyRetryCountRef.current = firstReadyEmptyRetryCount
        firstReadyEmptyRetryRemainingRef.current = firstReadyEmptyRetryCount
    }, [firstReadyEmptyRetryCount])

    useEffect(() => {
        firstReadyEmptyRetryDelayMsRef.current = firstReadyEmptyRetryDelayMs
    }, [firstReadyEmptyRetryDelayMs])

    useEffect(() => {
        stalledFirstEmissionRetryCountRef.current = stalledFirstEmissionRetryCount
        stalledFirstEmissionRetryRemainingRef.current = stalledFirstEmissionRetryCount
    }, [stalledFirstEmissionRetryCount])

    useEffect(() => {
        stalledFirstEmissionTimeoutMsRef.current = stalledFirstEmissionTimeoutMs
    }, [stalledFirstEmissionTimeoutMs])

    useEffect(() => {
        debugTraceRef.current = debugTrace
    }, [debugTrace])

    useEffect(() => {
        debugLabelRef.current = debugLabel
    }, [debugLabel])

    useEffect(() => {
        emptyReadyGraceMsRef.current = emptyReadyGraceMs
    }, [emptyReadyGraceMs])

    const cancelGraceTimer = useCallback(() => {
        if ( emptyReadyGraceTimerRef.current !== null ) {
            clearTimeout(emptyReadyGraceTimerRef.current)
            emptyReadyGraceTimerRef.current = null
        }
        pendingEmptyReadyRef.current = null
    }, [])

    const cancelStalledFirstEmissionTimer = useCallback(() => {
        if ( stalledFirstEmissionTimerRef.current !== null ) {
            clearTimeout(stalledFirstEmissionTimerRef.current)
            stalledFirstEmissionTimerRef.current = null
        }
    }, [])

    const closeStream = useCallback(() => {
        cancelGraceTimer()
        cancelStalledFirstEmissionTimer()
        streamStop.current?.()
        queryStream.current?.close()
        streamStop.current = null
        hasStreamEmitted.current = false
        hasStreamDeliveredNonEmpty.current = false
        emissionCountRef.current = 0
        lastStreamSignature.current = ``
    }, [cancelGraceTimer, cancelStalledFirstEmissionTimer])

    const buildStream = useCallback((queryOverride?: CollectionQuery<any, {}>, isInternalRetry = false) => {

        closeStream()
        streamGeneration.current += 1

        if ( !isInternalRetry ) {
            firstReadyEmptyRetryRemainingRef.current = firstReadyEmptyRetryCountRef.current
            stalledFirstEmissionRetryRemainingRef.current = stalledFirstEmissionRetryCountRef.current
        }

        if ( queryOverride ) queryRef.current = queryOverride
        if ( !queryRef.current ) return

        queryStream.current = queryRef.current
            .stream({ 
                flushMs: optionsRef.current?.flushMs ?? 20, 
                maxBatchSize: optionsRef.current?.maxBatchSize ?? 20, 
                insertAt: optionsRef.current?.insertAt ?? 'end', 
                maxDocs: optionsRef.current?.maxDocs ?? 50 
            })

        streamStop.current = queryStream.current.subscribe((nextRows, meta) => {

            if ( stalledFirstEmissionTimerRef.current !== null ) {
                cancelStalledFirstEmissionTimer()
            }

            const idsSignature = nextRows
                .map((row: any) => `${row?.id ?? ``}:${row?.updatedAt ?? row?.updated_at ?? row?.mtime ?? ``}`)
                .join(`,`)
            const signature = `${streamGeneration.current}:${meta?.ready ? 1 : 0}:${idsSignature}`
            emissionCountRef.current += 1
            const emissionNo = emissionCountRef.current
            logDebug(`emission`, {
                emissionNo,
                generation: streamGeneration.current,
                ready: !!meta?.ready,
                size: nextRows.length,
                firstRetryRemaining: firstReadyEmptyRetryRemainingRef.current,
                hasNonEmpty: hasStreamDeliveredNonEmpty.current,
            })

            if ( signature === lastStreamSignature.current ){
                logDebug(`skip duplicate`, { emissionNo, size: nextRows.length, metaReady: !!meta?.ready })
                return
            }
            lastStreamSignature.current = signature

            const isFirstEmission = !hasStreamEmitted.current
            const canForceReadyOnFirstEmission = isFirstEmission
                && forceReadyOnFirstEmissionRef.current
                && nextRows.length > 0

            const isReady = isFirstEmission
                ? (canForceReadyOnFirstEmission ? true : !!meta?.ready)
                : !!meta?.ready
            const metaReady = !!meta?.ready

            if (
                isFirstEmission
                && !metaReady
                && nextRows.length === 0
                && stalledFirstEmissionRetryRemainingRef.current > 0
            ) {
                const stallTimeout = Math.max(0, stalledFirstEmissionTimeoutMsRef.current)
                const retriesLeftAfterSchedule = stalledFirstEmissionRetryRemainingRef.current - 1
                stalledFirstEmissionTimerRef.current = setTimeout(() => {
                    stalledFirstEmissionTimerRef.current = null
                    stalledFirstEmissionRetryRemainingRef.current = Math.max(0, stalledFirstEmissionRetryRemainingRef.current - 1)
                    logDebug(`stalled first emission timeout hit — rebuilding stream`, {
                        stallTimeout,
                        retriesLeft: stalledFirstEmissionRetryRemainingRef.current,
                    })
                    buildStream(undefined, true)
                }, stallTimeout)
                logDebug(`schedule stalled-first-emission retry`, {
                    emissionNo,
                    stallTimeout,
                    retriesLeft: retriesLeftAfterSchedule,
                })

                // Suppress placeholder initial payload (ready=false, empty) and wait
                // for either the next real emission or the stalled retry rebuild.
                return
            }

            if ( metaReady && nextRows.length === 0 && !hasStreamDeliveredNonEmpty.current && firstReadyEmptyRetryRemainingRef.current > 0 ) {
                firstReadyEmptyRetryRemainingRef.current -= 1
                const retryDelay = Math.max(0, firstReadyEmptyRetryDelayMsRef.current)
                logDebug(`schedule first-ready-empty retry`, {
                    emissionNo,
                    retryDelay,
                    retriesLeft: firstReadyEmptyRetryRemainingRef.current,
                })
                setTimeout(() => {
                    buildStream(undefined, true)
                }, retryDelay)
                return
            }

            // If there's a pending grace timer and real data just arrived, cancel the
            // timer and emit the data immediately.
            if ( emptyReadyGraceTimerRef.current !== null && nextRows.length > 0 ) {
                cancelGraceTimer()
                hasStreamEmitted.current = true
                hasStreamDeliveredNonEmpty.current = true
                logDebug(`emit non-empty after grace wait`, { emissionNo, ready: isReady, size: nextRows.length })
                onDataRef.current(nextRows, { ready: isReady })
                return
            }

            // If data is ready but empty, and a grace period is configured, defer the
            // empty result so a follow-up emission with real data can arrive first.
            if ( metaReady && nextRows.length === 0 && emptyReadyGraceMsRef.current > 0 && emptyReadyGraceTimerRef.current === null ) {
                pendingEmptyReadyRef.current = { rows: nextRows }
                hasStreamEmitted.current = true
                emptyReadyGraceTimerRef.current = setTimeout(() => {
                    emptyReadyGraceTimerRef.current = null
                    const pending = pendingEmptyReadyRef.current
                    pendingEmptyReadyRef.current = null
                    if ( pending ) {
                        logDebug(`emit deferred empty after grace timeout`, { size: pending.rows.length })
                        onDataRef.current(pending.rows, { ready: true })
                    }
                }, emptyReadyGraceMsRef.current)
                logDebug(`start empty-ready grace timer`, { emissionNo, graceMs: emptyReadyGraceMsRef.current })
                return
            }

            if ( !hasStreamEmitted.current ){
                hasStreamEmitted.current = true
                if ( nextRows.length > 0 ) {
                    hasStreamDeliveredNonEmpty.current = true
                }
                logDebug(`emit first payload`, { emissionNo, ready: isReady, size: nextRows.length })
                onDataRef.current(nextRows, { ready: isReady })
                return
            }

            logDebug(`emit update`, { emissionNo, size: nextRows.length, metaReady: !!meta?.ready })
            if ( nextRows.length > 0 ) {
                hasStreamDeliveredNonEmpty.current = true
            }
            onDataRef.current(nextRows, { ready: !!meta?.ready })

        })

    }, [closeStream])

    useEffect(() => {
        return () => {
            // logDebug(`[Sidebar] Cleaning up boards stream`)
            closeStream()
        }
    }, [closeStream])

    return {
        buildStream,
        closeStream,
        cancelGraceTimer,
    }

}

export default useLiveQuery