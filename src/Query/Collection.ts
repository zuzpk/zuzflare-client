import { uuid2 } from "@zuzjs/core";
import FlareClient from "../Client";
import {
    AggregateSpec, AndFilter, AnyFilter,
    BulkWriteOperation,
    BulkWriteOptions,
    BulkWriteProgress,
    BulkWriteResult,
    ChangeEvent,
    CollectionExternalStore,
    CollectionStream,
    CollectionStreamListener,
    CollectionStreamMeta,
    CollectionStreamOptions,
    DocAddedCallback,
    DocChangedCallback, DocDeletedCallback, DocUpdatedCallback,
    HavingClause, JoinClause,
    NestedJoinClause,
    OrFilter,
    QueryConfig,
    QueryPresetMap,
    QueryPresetParams,
    QueryPresetRow,
    StructuredJoinClause,
    StructuredQuery, SubscriptionCallback, SubscriptionHandle,
    UpdateManyItem,
    VectorSearchClause, WhereCondition
} from "../types";
import { FlareAction } from "../types/message";
import { DocumentQueryBuilder, parseWhereCondition } from "./Builder";
import DocumentReference from "./Document";

export type CollectionPresetMethods<TPresetMap extends QueryPresetMap> = {
    [K in keyof TPresetMap & string]: (
        params: QueryPresetParams<TPresetMap[K]>,
    ) => CollectionQuery<QueryPresetRow<TPresetMap[K]>, TPresetMap>;
};

export type CollectionQuery<T = any, TPresetMap extends QueryPresetMap = {}> =
    CollectionReference<T, TPresetMap> & CollectionPresetMethods<TPresetMap>;

class CollectionReference<T = any, TPresetMap extends QueryPresetMap = {}> implements PromiseLike<T[]> {

    private sq: StructuredQuery = {};
    private promise?: Promise<T[]>;

    constructor(
        private client: FlareClient<TPresetMap>,
        public readonly collection: string,
    ) {
        return new Proxy(this, {
            get: (target, prop, receiver) => {
                if (typeof prop === "string" && !(prop in target) && this.client.hasQueryPreset(prop)) {
                    return (params: Record<string, unknown> = {}) => target.with(prop, params);
                }

                const value = Reflect.get(target, prop, receiver);
                if (typeof value === "function") return value.bind(target);
                return value;
            },
        }) as this;
    }

    // Document ref
    doc(id: string): DocumentReference<T> {
        return new DocumentReference<T>(this.client, this.collection, id);
    }

    // Clone helper
    private clone(patch: Partial<StructuredQuery>): CollectionQuery<T, TPresetMap> {
        const ref = new CollectionReference<T, TPresetMap>(this.client, this.collection);
        ref.sq = { ...this.sq, ...patch };
        return ref as CollectionQuery<T, TPresetMap>;
    }

    private normalizeFilterValue(op: QueryConfig['op'], value: unknown): unknown {
        if (op === 'in' || op === 'not-in' || op === 'array-contains-any') {
            return Array.isArray(value) ? value : [value];
        }
        return value;
    }

    private normalizeFilter(filter: QueryConfig): QueryConfig {
        return {
            ...filter,
            value: this.normalizeFilterValue(filter.op, filter.value),
        };
    }

    private toQueryFilters(condition: WhereCondition): QueryConfig[] {
        return (parseWhereCondition(condition) as QueryConfig[]).map((f) => this.normalizeFilter(f));
    }

    private appendOperatorFilter(field: string, op: QueryConfig['op'], value: unknown, logic: 'and' | 'or'): CollectionQuery<T, TPresetMap> {
        return this.appendFilters([this.normalizeFilter({ field, op, value })], logic);
    }

    private appendAndFilters(filters: QueryConfig[]): CollectionQuery<T, TPresetMap> {
        return this.clone({ where: [...(this.sq.where ?? []), ...filters] });
    }

    private toOrNode(filters: QueryConfig[]): OrFilter {
        return { or: filters };
    }

    private toAndNode(filters: QueryConfig[]): AndFilter {
        return { and: filters };
    }

    private isLeafFilter(node: AnyFilter): node is QueryConfig {
        return !('or' in node) && !('and' in node);
    }

    private isIdentityGuard(node: AnyFilter): node is QueryConfig {
        if (!this.isLeafFilter(node)) return false;
        return (node.field === 'id' || node.field === '_id') && node.op === '==';
    }

    private splitIdentityGuards(filters: AnyFilter[]): { guards: QueryConfig[]; rest: AnyFilter[] } {
        const guards: QueryConfig[] = [];
        const rest: AnyFilter[] = [];

        for (const filter of filters) {
            if (this.isIdentityGuard(filter)) {
                guards.push(filter);
                continue;
            }
            rest.push(filter);
        }

        return { guards, rest };
    }

    private appendOrFilters(filters: QueryConfig[]): CollectionQuery<T, TPresetMap> {
        const existing = [...(this.sq.where ?? [])] as AnyFilter[];

        if (existing.length === 0) {
            return this.clone({ where: [this.toOrNode(filters)] });
        }

        const first = existing[0] as AnyFilter;
        const hasSingleOrRoot = existing.length === 1 && typeof first === 'object' && first != null && 'or' in first;
        if (hasSingleOrRoot) {
            const rootOr = first as OrFilter;
            return this.clone({ where: [{ or: [...rootOr.or, ...filters] }] });
        }

        // Keep strict identity guards outside the OR:
        // where(id == X).where(uid == U).orSome(team, { uid: U })
        // => and(id == X, or(uid == U, elem-match(team, ...)))
        const { guards, rest } = this.splitIdentityGuards(existing);
        if (guards.length > 0) {
            const left = rest.length === 0 ? undefined : (rest.length === 1 ? rest[0] : ({ and: rest } as AndFilter));
            const orBranch = left ? [{ or: [left, ...filters] } as OrFilter] : [{ or: [...filters] } as OrFilter];
            return this.clone({ where: [...guards, ...orBranch] });
        }

        // Promote current root AND sequence into an explicit OR tree:
        // where(A).and(B).or(C) => or(and(A,B), C)
        const left = existing.length === 1 ? existing[0] : ({ and: existing } as AndFilter);
        return this.clone({ where: [{ or: [left, ...filters] }] });
    }

    private appendFilters(filters: QueryConfig[], logic: 'and' | 'or'): CollectionQuery<T, TPresetMap> {
        return logic === 'or' ? this.appendOrFilters(filters) : this.appendAndFilters(filters);
    }

    // Filtering
    with<Name extends keyof TPresetMap & string>(
        name: Name,
        params: QueryPresetParams<TPresetMap[Name]>,
    ): CollectionQuery<QueryPresetRow<TPresetMap[Name]>, TPresetMap>;
    with(name: string, params?: Record<string, unknown>): CollectionQuery<T, TPresetMap>;
    with(name: string, params: Record<string, unknown> = {}): CollectionQuery<any, TPresetMap> {
        return this.client.applyQueryPreset(this as any, name as any, params as any) as any;
    }

    /** ORM shorthand: .where({ age: ">= 25", role: "admin" }) */
    where(condition: WhereCondition): CollectionQuery<T, TPresetMap> {
        return this.appendFilters(this.toQueryFilters(condition), 'and');
    }

    and(condition: WhereCondition): CollectionQuery<T, TPresetMap> {
        return this.appendFilters(this.toQueryFilters(condition), 'and');
    }

    or(condition: WhereCondition): CollectionQuery<T, TPresetMap> {
        return this.appendFilters(this.toQueryFilters(condition), 'or');
    }

    in(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'in', values, 'and');
    }

    andIn(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'in', values, 'and');
    }

    orIn(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'in', values, 'or');
    }

    notIn(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-in', values, 'and');
    }

    andNotIn(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-in', values, 'and');
    }

    orNotIn(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-in', values, 'or');
    }

    arrayContains(field: string, value: unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'array-contains', value, 'and');
    }

    andArrayContains(field: string, value: unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'array-contains', value, 'and');
    }

    orArrayContains(field: string, value: unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'array-contains', value, 'or');
    }

    arrayContainsAny(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'array-contains-any', values, 'and');
    }

    andArrayContainsAny(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'array-contains-any', values, 'and');
    }

    orArrayContainsAny(field: string, values: unknown[] | unknown): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'array-contains-any', values, 'or');
    }

    some(field: string, condition: Record<string, unknown>): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'elem-match', condition, 'and');
    }

    andSome(field: string, condition: Record<string, unknown>): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'elem-match', condition, 'and');
    }

    orSome(field: string, condition: Record<string, unknown>): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'elem-match', condition, 'or');
    }

    like(field: string, value: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'like', value, 'and');
    }

    andLike(field: string, value: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'like', value, 'and');
    }

    orLike(field: string, value: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'like', value, 'or');
    }

    notLike(field: string, value: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-like', value, 'and');
    }

    andNotLike(field: string, value: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-like', value, 'and');
    }

    orNotLike(field: string, value: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-like', value, 'or');
    }

    exists(field: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'exists', true, 'and');
    }

    andExists(field: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'exists', true, 'and');
    }

    orExists(field: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'exists', true, 'or');
    }

    notExists(field: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-exists', true, 'and');
    }

    andNotExists(field: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-exists', true, 'and');
    }

    orNotExists(field: string): CollectionQuery<T, TPresetMap> {
        return this.appendOperatorFilter(field, 'not-exists', true, 'or');
    }

    // Sorting
    /** Get items starting from the most recently created (descending sequence) */
    latest() : CollectionQuery<T, TPresetMap> {
        return this.clone({ orderBy: [...(this.sq.orderBy ?? []), { field: `_seq`, dir: "desc" }] });
    }
    
    /** Get items starting from the most recently created (descending sequence) */
    newest() : CollectionQuery<T, TPresetMap> {
        return this.clone({ orderBy: [...(this.sq.orderBy ?? []), { field: `_seq`, dir: "desc" }] });
    }
    /** Get items starting from the first ever created (ascending sequence) */
    oldest() : CollectionQuery<T, TPresetMap> {
        return this.clone({ orderBy: [...(this.sq.orderBy ?? []), { field: `_seq`, dir: "asc" }] });
    }

    orderBy(field: string, dir: "asc" | "desc" = "asc"): CollectionQuery<T, TPresetMap> {
        return this.clone({ orderBy: [...(this.sq.orderBy ?? []), { field, dir }] });
    }

    // Pagination
    limit(n: number):  CollectionQuery<T, TPresetMap> { return this.clone({ limit: n }); }
    offset(n: number): CollectionQuery<T, TPresetMap> { return this.clone({ offset: n }); }

    startAt(...values: unknown[]):    CollectionQuery<T, TPresetMap> { return this.clone({ startAt:    { values } }); }
    startAfter(...values: unknown[]): CollectionQuery<T, TPresetMap> { return this.clone({ startAfter: { values } }); }
    endAt(...values: unknown[]):      CollectionQuery<T, TPresetMap> { return this.clone({ endAt:      { values } }); }
    endBefore(...values: unknown[]):  CollectionQuery<T, TPresetMap> { return this.clone({ endBefore:  { values } }); }

    // Aggregation
    aggregate(...specs: AggregateSpec[]): CollectionQuery<T, TPresetMap> {
        return this.clone({ aggregate: [...(this.sq.aggregate ?? []), ...specs] });
    }

    count(alias = "count"):               CollectionQuery<T, TPresetMap> { return this.aggregate({ fn: "count", alias }); }
    sum(field: string, alias?: string):   CollectionQuery<T, TPresetMap> { return this.aggregate({ fn: "sum",  field, alias: alias ?? `sum_${field}` }); }
    avg(field: string, alias?: string):   CollectionQuery<T, TPresetMap> { return this.aggregate({ fn: "avg",  field, alias: alias ?? `avg_${field}` }); }
    min(field: string, alias?: string):   CollectionQuery<T, TPresetMap> { return this.aggregate({ fn: "min",  field, alias: alias ?? `min_${field}` }); }
    max(field: string, alias?: string):   CollectionQuery<T, TPresetMap> { return this.aggregate({ fn: "max",  field, alias: alias ?? `max_${field}` }); }
    distinct(field: string, alias?: string): CollectionQuery<T, TPresetMap> {
        return this.aggregate({ fn: "distinct", field, alias: alias ?? `distinct_${field}` });
    }

    groupBy(...fields: string[]): CollectionQuery<T, TPresetMap> {
        return this.clone({ groupBy: { fields } });
    }

    having(field: string, op: HavingClause['op'], value: number): CollectionQuery<T, TPresetMap> {
        return this.clone({ having: [...(this.sq.having ?? []), { field, op, value }] });
    }

    // Joins
    private buildStructuredJoin(collectionName: string, clause: JoinClause | NestedJoinClause): StructuredJoinClause {
        const from = String(collectionName ?? "");
        const source = String(clause?.source ?? "id").trim() || "id";
        const out: StructuredJoinClause = {
            from,
            localField: source,
            foreignField: String(clause?.target ?? ""),
            as: String(clause?.as ?? ""),
            single: clause?.single,
        };

        if (Array.isArray(clause?.where)) out.where = clause.where;
        if (Array.isArray(clause?.orderBy)) out.orderBy = clause.orderBy;
        if (typeof clause?.limit === "number") out.limit = clause.limit;
        if (typeof clause?.offset === "number") out.offset = clause.offset;
        if (clause?.startAt) out.startAt = clause.startAt;
        if (clause?.startAfter) out.startAfter = clause.startAfter;
        if (clause?.endAt) out.endAt = clause.endAt;
        if (clause?.endBefore) out.endBefore = clause.endBefore;
        if (Array.isArray(clause?.aggregate)) out.aggregate = clause.aggregate;
        if (clause?.groupBy) out.groupBy = clause.groupBy;
        if (Array.isArray(clause?.having)) out.having = clause.having;
        if (clause?.vectorSearch) out.vectorSearch = clause.vectorSearch;
        if (Array.isArray(clause?.select)) out.select = clause.select;
        if (typeof clause?.distinctField === "string") out.distinctField = clause.distinctField;
        if (Array.isArray(clause?.joins)) {
            out.joins = clause.joins.map((child) => this.buildStructuredJoin(String(child?.collection ?? ""), child));
        }

        return out;
    }

    private cloneStructuredJoin(join: StructuredJoinClause): StructuredJoinClause {
        const next: StructuredJoinClause = { ...join };
        if (Array.isArray(join.where)) next.where = join.where.map((f) => ({ ...(f as any) })) as any;
        if (Array.isArray(join.orderBy)) next.orderBy = join.orderBy.map((o) => ({ ...o }));
        if (Array.isArray(join.aggregate)) next.aggregate = join.aggregate.map((a) => ({ ...a }));
        if (Array.isArray(join.having)) next.having = join.having.map((h) => ({ ...h }));
        if (Array.isArray(join.select)) next.select = [...join.select];
        if (join.groupBy?.fields) next.groupBy = { fields: [...join.groupBy.fields] };
        if (join.startAt?.values) next.startAt = { values: [...join.startAt.values] };
        if (join.startAfter?.values) next.startAfter = { values: [...join.startAfter.values] };
        if (join.endAt?.values) next.endAt = { values: [...join.endAt.values] };
        if (join.endBefore?.values) next.endBefore = { values: [...join.endBefore.values] };
        if (Array.isArray(join.joins)) next.joins = join.joins.map((child) => this.cloneStructuredJoin(child));
        return next;
    }

    private appendNestedJoinByAlias(joins: StructuredJoinClause[], parentAlias: string, nested: StructuredJoinClause): boolean {
        for (const join of joins) {
            if (join.as === parentAlias) {
                join.joins = [...(join.joins ?? []), nested];
                return true;
            }
            if (Array.isArray(join.joins) && this.appendNestedJoinByAlias(join.joins, parentAlias, nested)) {
                return true;
            }
        }
        return false;
    }

    private parseRelationRef(relation: string): {
        source: string;
        collection: string;
        target: string;
        alias?: string;
    } {
        const trimmed = String(relation ?? "").trim();
        const match = trimmed.match(/^([A-Za-z0-9_.]+)\s*->\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/i);
        if (!match) {
            throw new Error(`Invalid relation format: "${relation}". Expected "source.path->collection.target"`);
        }

        return {
            source: match[1],
            collection: match[2],
            target: match[3],
            alias: match[4],
        };
    }

    /**
     * Join another collection into this query.
     *
     * @param collectionName Joined collection name.
     * @param j Join mapping clause.
     * @example
     *   flare.collection("boards")
     *     .join("tasks", { source: "id", target: "boardId", as: "tasks" })
     *     .get();
     */
    join(collectionName: string, j: JoinClause): CollectionQuery<T, TPresetMap> {
        const join = this.buildStructuredJoin(collectionName, j);
        return this.clone({ joins: [...(this.sq.joins ?? []), join] });
    }

    /**
     * Append a nested join under an existing join alias.
     * Example:
     *   .join("lists", { source: "id", target: "boardId", as: "lists" })
     *   .joinNested("lists", "cards", { source: "id", target: "listId", as: "cards" })
     */
    joinNested(parentAlias: string, collectionName: string, j: JoinClause): CollectionQuery<T, TPresetMap> {
        const alias = String(parentAlias ?? '').trim();
        if (!alias) throw new Error('joinNested requires parentAlias');

        const joins = (this.sq.joins ?? []).map((item) => this.cloneStructuredJoin(item));
        if (joins.length === 0) {
            throw new Error(`joinNested parent alias "${alias}" not found`);
        }

        const nestedJoin = this.buildStructuredJoin(collectionName, j);
        if (!this.appendNestedJoinByAlias(joins, alias, nestedJoin)) {
            throw new Error(`joinNested parent alias "${alias}" not found`);
        }

        return this.clone({ joins });
    }

    // Backward-compatible alias.
    Join(collectionName: string, j: JoinClause): CollectionQuery<T, TPresetMap> {
        return this.join(collectionName, j);
    }

    // Backward-compatible alias.
    JoinNested(parentAlias: string, collectionName: string, j: JoinClause): CollectionQuery<T, TPresetMap> {
        return this.joinNested(parentAlias, collectionName, j);
    }

    /**
     * SQL-like relation shorthand.
     * Example: .withRelation("team.uid->users.id", { as: "teamMembers" })
     */
    withRelation(
        relation: string,
        options: (Omit<JoinClause, 'source' | 'target' | 'as'> & { as?: string }) = {},
    ): CollectionQuery<T, TPresetMap> {
        const parsed = this.parseRelationRef(relation);
        return this.join(parsed.collection, {
            ...options,
            source: parsed.source,
            target: parsed.target,
            as: options.as ?? parsed.alias ?? parsed.collection,
        });
    }

    // Projection
    select(...fields: string[]): CollectionQuery<T, TPresetMap> {
        return this.clone({ select: fields });
    }

    /** Returns unique values for a single field */
    distinctField(field: string): CollectionQuery<T, TPresetMap> {
        return this.clone({ distinctField: field });
    }

    // Vector / KNN
    /**
     * KNN nearest-neighbour search (requires Atlas vector index).
     * @example
     *   col.vectorSearch({ field: "embedding", vector: [...1536 numbers...], k: 10 })
     */
    vectorSearch(opts: VectorSearchClause): CollectionQuery<T, TPresetMap> {
        return this.clone({ vectorSearch: opts });
    }

    // Execution
    getRawQuery(): { collection: string; query: StructuredQuery } {
        const query: StructuredQuery = { ...this.sq };
        if (Array.isArray(this.sq.where)) query.where = this.sq.where.map((f) => ({ ...(f as any) })) as any;
        if (Array.isArray(this.sq.orderBy)) query.orderBy = this.sq.orderBy.map((o) => ({ ...o }));
        if (Array.isArray(this.sq.aggregate)) query.aggregate = this.sq.aggregate.map((a) => ({ ...a }));
        if (Array.isArray(this.sq.having)) query.having = this.sq.having.map((h) => ({ ...h }));
        if (Array.isArray(this.sq.select)) query.select = [...this.sq.select];
        if (Array.isArray(this.sq.joins)) query.joins = this.sq.joins.map((j) => this.cloneStructuredJoin(j));
        if (this.sq.groupBy?.fields) query.groupBy = { fields: [...this.sq.groupBy.fields] };
        if (this.sq.startAt?.values) query.startAt = { values: [...this.sq.startAt.values] };
        if (this.sq.startAfter?.values) query.startAfter = { values: [...this.sq.startAfter.values] };
        if (this.sq.endAt?.values) query.endAt = { values: [...this.sq.endAt.values] };
        if (this.sq.endBefore?.values) query.endBefore = { values: [...this.sq.endBefore.values] };
        return { collection: this.collection, query };
    }

    async get(): Promise<T[]> { return this._execute(); }

    async first(): Promise<T | null> {
        const rows = await this._execute();
        return rows.length > 0 ? (rows[0] as T) : null;
    }

    async last(): Promise<T | null> {
        const rows = await this._execute();
        return rows.length > 0 ? (rows[rows.length - 1] as T) : null;
    }

    private _isStructured(): boolean {
        return !!(
            this.sq.orderBy?.length || this.sq.aggregate?.length ||
            this.sq.groupBy        || this.sq.having?.length     ||
            this.sq.joins?.length  || this.sq.vectorSearch       ||
            this.sq.distinctField  || this.sq.offset             ||
            this.sq.startAt  || this.sq.startAfter               ||
            this.sq.endAt    || this.sq.endBefore                ||
            this.sq.select?.length
        );
    }

    private async _execute(): Promise<T[]> {
        if (this._isStructured()) return this._executeQuery();
        return this._executeSubscribe();
    }

    private async _executeQuery(): Promise<T[]> {
        return this.client.query<T>(this.collection, this.sq);
    }

    private async _executeSubscribe(): Promise<T[]> {
        const subId = uuid2(18);
        return new Promise((resolve, reject) => {
            const sq = Object.keys(this.sq).length > 0 ? this.sq : undefined;
            const unsubscribe = this.client.subscribe(
                subId, this.collection, undefined, sq as any,
                (data) => {
                    if (data.type === 'snapshot') {
                        unsubscribe();
                        resolve(data.data as T[]);  // SnapshotEvent.data is always T[]
                    }
                },
            );
            setTimeout(() => { unsubscribe(); reject(new Error('Collection fetch timeout')); }, 10000);
        });
    }

    then<TResult1 = T[], TResult2 = never>(
        onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?:  ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
        if (!this.promise) this.promise = this._execute();
        return this.promise.then(onfulfilled, onrejected);
    }

    // Real-time
    /**
     * Subscribe to real-time updates.
     * The full StructuredQuery (including orderBy, where, limit, offset) is sent
     * to the server so the initial snapshot respects all constraints.
     * Individual change events are then sorted / filtered client-side to keep
     * the live result consistent.
     */
    onSnapshot(callback: SubscriptionCallback<T[]>): SubscriptionHandle {
        const subId = uuid2(18);
        const sq    = Object.keys(this.sq).length > 0 ? this.sq : undefined;
        let unsubscribe = (() => {}) as SubscriptionHandle;
        unsubscribe = this.client.subscribe(subId, this.collection, undefined, sq as any, (event) => {
            if (event.type === 'snapshot') {
                callback(event as any);
                unsubscribe();
            }
        });
        return unsubscribe;
    }

    /**
     * High-throughput stream wrapper for bursty collections (chat, feeds, logs).
     * It keeps local state and flushes change bursts in batches to reduce UI churn.
     */
    stream(options: CollectionStreamOptions<T> = {}): CollectionStream<T> {
        const subId = uuid2(18);
        const sq = Object.keys(this.sq).length > 0 ? this.sq : undefined;
        const listeners = new Set<CollectionStreamListener<T>>();
        const queuedChanges: Array<ChangeEvent<T>> = [];
        const byId = new Map<string, number>();

        const flushMs = Math.max(0, Number(options.flushMs ?? 24));
        const maxBatchSize = Math.max(1, Number(options.maxBatchSize ?? 200));
        const insertAt = options.insertAt ?? 'end';
        const maxDocs = typeof options.maxDocs === 'number' && options.maxDocs > 0
            ? Math.floor(options.maxDocs)
            : undefined;
        const idField = String(options.idField ?? 'id');

        let rows: T[] = [];
        let closed = false;
        let ready = false;
        let version = 0;
        let flushTimer: ReturnType<typeof setTimeout> | undefined;

        const rebuildIndex = () => {
            byId.clear();
            for (let i = 0; i < rows.length; i += 1) {
                const id = resolveDocId(rows[i]);
                if (id) byId.set(id, i);
            }
        };

        const resolveDocId = (doc: T | null | undefined, fallback?: string): string | undefined => {
            if (fallback) return fallback;
            if (doc == null) return undefined;
            if (typeof options.getId === 'function') {
                const custom = options.getId(doc);
                if (typeof custom === 'string' && custom.length > 0) return custom;
            }

            const candidate = (doc as any)?.[idField] ?? (doc as any)?._id ?? (doc as any)?.docId;
            if (typeof candidate === 'string' && candidate.length > 0) return candidate;
            return undefined;
        };

        const trimRowsIfNeeded = () => {
            if (maxDocs == null || rows.length <= maxDocs) return;
            rows = rows.slice(0, maxDocs);
        };

        const applySortIfNeeded = () => {
            if (typeof options.sort === 'function') {
                rows = rows.slice().sort(options.sort);
            }
        };

        const notify = (reason: CollectionStreamMeta['reason'], batchSize: number) => {
            version += 1;
            const snapshot = rows.slice();
            const meta: CollectionStreamMeta = { reason, batchSize, version, ready };
            for (const listener of Array.from(listeners)) {
                try {
                    listener(snapshot, meta);
                } catch {
                    // Listener exceptions should not break stream fan-out.
                }
            }
        };

        const clearFlushTimer = () => {
            if (flushTimer != null) {
                clearTimeout(flushTimer);
                flushTimer = undefined;
            }
        };

        const applyChange = (event: ChangeEvent<T>) => {
            if (event.operation === 'delete') {
                const existingIndex = byId.get(event.docId);
                if (existingIndex == null) return;
                rows.splice(existingIndex, 1);
                rebuildIndex();
                return;
            }

            const nextDoc = event.data;
            if (nextDoc == null) return;

            const docId = resolveDocId(nextDoc, event.docId);
            if (!docId) return;

            const existingIndex = byId.get(docId);
            if (typeof existingIndex === 'number') {
                // Realtime update events may contain only changed fields. Keep
                // the existing snapshot fields so a partial change does not
                // make live-query consumers appear stale or lose data.
                const currentDoc = rows[existingIndex] as any;
                rows[existingIndex] = (
                    currentDoc && typeof currentDoc === 'object' && typeof nextDoc === 'object'
                        ? { ...currentDoc, ...nextDoc }
                        : nextDoc
                ) as T;
                return;
            }

            if (insertAt === 'start') rows.unshift(nextDoc);
            else rows.push(nextDoc);
            trimRowsIfNeeded();
            rebuildIndex();
        };

        const flushQueue = () => {
            if (closed) return;
            if (queuedChanges.length === 0) return;

            clearFlushTimer();
            const batch = queuedChanges.splice(0, queuedChanges.length);
            for (const change of batch) {
                applyChange(change);
            }
            applySortIfNeeded();
            rebuildIndex();
            notify('change-batch', batch.length);
        };

        const scheduleFlush = () => {
            if (closed || flushTimer != null) return;
            flushTimer = setTimeout(flushQueue, flushMs);
        };

        const subscription = this.client.subscribe(subId, this.collection, undefined, sq as any, (event) => {
            if (closed) return;

            if (event.type === 'snapshot') {
                rows = Array.isArray(event.data) ? [...event.data] : [];
                ready = true;
                clearFlushTimer();
                queuedChanges.length = 0;
                applySortIfNeeded();
                trimRowsIfNeeded();
                rebuildIndex();
                notify('snapshot', 0);
                return;
            }

            queuedChanges.push(event as ChangeEvent<T>);
            if (queuedChanges.length >= maxBatchSize) {
                flushQueue();
                return;
            }
            scheduleFlush();
        });

        const close = () => {
            if (closed) return;
            closed = true;
            clearFlushTimer();
            queuedChanges.length = 0;
            listeners.clear();
            subscription();
        };

        const streamApi: CollectionStream<T> = {
            subscribe(listener: CollectionStreamListener<T>, emitCurrent = true): () => void {
                listeners.add(listener);
                if (emitCurrent) {
                    const meta: CollectionStreamMeta = { reason: ready ? 'change-batch' : 'snapshot', batchSize: 0, version, ready };
                    try {
                        listener(rows.slice(), meta);
                    } catch {
                        // Ignore listener exception to preserve stream lifecycle.
                    }
                }
                return () => { listeners.delete(listener); };
            },
            getSnapshot(): readonly T[] {
                return rows.slice();
            },
            isReady(): boolean {
                return ready;
            },
            getVersion(): number {
                return version;
            },
            close,
            onError(callback) {
                subscription.onError(callback);
                return streamApi;
            },
            onPermissionDenied(callback) {
                subscription.onPermissionDenied(callback);
                return streamApi;
            },
        };

        return streamApi;
    }

    /**
     * Framework-agnostic external-store bridge.
     * Compatible with UI hooks expecting subscribe/getSnapshot signatures.
     */
    asStore(options: CollectionStreamOptions<T> = {}): CollectionExternalStore<T> {
        const stream = this.stream(options);
        return {
            subscribe: (onStoreChange: () => void): (() => void) => {
                return stream.subscribe(() => {
                    onStoreChange();
                }, false);
            },
            getSnapshot: () => stream.getSnapshot(),
            getServerSnapshot: () => [],
            stream,
            destroy: () => {
                stream.close();
            },
        };
    }

    onDocAdded(callback: DocAddedCallback<T>): () => void {
        const subId = uuid2(18);
        const sq    = Object.keys(this.sq).length > 0 ? this.sq : undefined;
        return this.client.subscribe(subId, this.collection, undefined, sq as any, (event) => {
            if (event.type === 'change' && event.operation === 'insert' && event.data != null) {
                callback(event.data as T, event.docId);
            }
        }, { skipSnapshot: true });
    }

    onDocUpdated(callback: DocUpdatedCallback<T>): () => void {
        const subId = uuid2(18);
        const sq    = Object.keys(this.sq).length > 0 ? this.sq : undefined;
        return this.client.subscribe(subId, this.collection, undefined, sq as any, (event) => {
            if (event.type === 'change' && (event.operation === 'update' || event.operation === 'replace') && event.data != null) {
                callback(event.data as T, event.docId);
            }
        }, { skipSnapshot: true });
    }

    onDocDeleted(callback: DocDeletedCallback<T>): () => void {
        const subId = uuid2(18);
        const sq    = Object.keys(this.sq).length > 0 ? this.sq : undefined;
        return this.client.subscribe(subId, this.collection, undefined, sq as any, (event) => {
            if (event.type === 'change' && event.operation === 'delete') {
                callback(event.docId);
            }
        }, { skipSnapshot: true });
    }

    onDocChanged(callback: DocChangedCallback<T>): () => void {
        const subId = uuid2(18);
        const sq    = Object.keys(this.sq).length > 0 ? this.sq : undefined;
        return this.client.subscribe(subId, this.collection, undefined, sq as any, (event) => {
            if (event.type === 'change') {
                callback(event.data as T ?? null, event.docId, event.operation);
            }
        }, { skipSnapshot: true });
    }

    // Writes
    private ensureBulkOptions(options: BulkWriteOptions | undefined): Required<Pick<BulkWriteOptions, 'batchSize' | 'concurrency' | 'continueOnError'>> & Omit<BulkWriteOptions, 'batchSize' | 'concurrency' | 'continueOnError'> {
        const batchSize = Number(options?.batchSize ?? 250);
        const concurrency = Number(options?.concurrency ?? 1);
        return {
            ...options,
            batchSize: Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 250,
            concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1,
            continueOnError: options?.continueOnError === true,
        };
    }

    private toPercent(processed: number, total?: number): number | undefined {
        if (typeof total !== 'number' || total <= 0) return undefined;
        return Math.round((processed / total) * 100);
    }

    private emitBulkProgress(
        operation: BulkWriteOperation,
        state: Omit<BulkWriteProgress, 'operation' | 'percent'>,
        onProgress?: (progress: BulkWriteProgress) => void,
    ): void {
        if (!onProgress) return;
        onProgress({
            operation,
            ...state,
            percent: this.toPercent(state.processed, state.total),
        });
    }

    private async *chunkIterable<TItem>(
        items: Iterable<TItem> | AsyncIterable<TItem>,
        chunkSize: number,
    ): AsyncGenerator<TItem[]> {
        let chunk: TItem[] = [];
        for await (const item of items as AsyncIterable<TItem>) {
            chunk.push(item);
            if (chunk.length >= chunkSize) {
                yield chunk;
                chunk = [];
            }
        }
        if (chunk.length > 0) {
            yield chunk;
        }
    }

    private assertBulkSignal(signal?: AbortSignal): void {
        if (signal?.aborted) {
            throw new Error('Bulk write aborted');
        }
    }

    private async runChunkWorkers<TItem>(
        operation: BulkWriteOperation,
        chunk: TItem[],
        concurrency: number,
        runItem: (item: TItem) => Promise<{ docId?: string }>,
        state: {
            processed: number;
            succeeded: number;
            failed: number;
            total?: number;
        },
        onProgress?: (progress: BulkWriteProgress) => void,
        continueOnError = false,
        signal?: AbortSignal,
    ): Promise<void> {
        let cursor = 0;
        let firstError: unknown;

        const worker = async () => {
            while (cursor < chunk.length) {
                this.assertBulkSignal(signal);
                const index = cursor;
                cursor += 1;
                const current = chunk[index] as TItem;
                try {
                    const result = await runItem(current);
                    state.succeeded += 1;
                    state.processed += 1;
                    this.emitBulkProgress(operation, {
                        processed: state.processed,
                        succeeded: state.succeeded,
                        failed: state.failed,
                        total: state.total,
                        lastDocId: result.docId,
                    }, onProgress);
                } catch (error) {
                    state.failed += 1;
                    state.processed += 1;
                    this.emitBulkProgress(operation, {
                        processed: state.processed,
                        succeeded: state.succeeded,
                        failed: state.failed,
                        total: state.total,
                        lastError: error,
                    }, onProgress);

                    if (!continueOnError) {
                        throw error;
                    }
                    if (firstError == null) {
                        firstError = error;
                    }
                }
            }
        };

        const workerCount = Math.max(1, Math.min(concurrency, chunk.length));
        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        if (!continueOnError && firstError != null) {
            throw firstError;
        }
    }

    private async runBulkWrite<TItem>(
        operation: BulkWriteOperation,
        items: Iterable<TItem> | AsyncIterable<TItem>,
        runItem: (item: TItem) => Promise<{ docId?: string }>,
        options?: BulkWriteOptions,
    ): Promise<BulkWriteResult> {
        const opts = this.ensureBulkOptions(options);
        this.assertBulkSignal(opts.signal);

        const state: {
            processed: number;
            succeeded: number;
            failed: number;
            total?: number;
        } = {
            processed: 0,
            succeeded: 0,
            failed: 0,
            total: Array.isArray(items) ? items.length : undefined,
        };

        this.emitBulkProgress(operation, {
            processed: state.processed,
            succeeded: state.succeeded,
            failed: state.failed,
            total: state.total,
        }, opts.onProgress);

        for await (const chunk of this.chunkIterable(items, opts.batchSize)) {
            this.assertBulkSignal(opts.signal);
            await this.runChunkWorkers(
                operation,
                chunk,
                opts.concurrency,
                runItem,
                state,
                opts.onProgress,
                opts.continueOnError,
                opts.signal,
            );
        }

        const result: BulkWriteResult = {
            operation,
            processed: state.processed,
            succeeded: state.succeeded,
            failed: state.failed,
            total: state.total,
        };
        return result;
    }

    async add(data: Partial<T>): Promise<DocumentReference<T>> {
        const docId = uuid2(18);
        const docRef = this.doc(docId);
        await docRef.set(data);
        return docRef;
    }

    /**
     * Create many documents with bounded memory and optional progress reporting.
     */
    async addMany(
        items: Iterable<Partial<T>> | AsyncIterable<Partial<T>>,
        options?: BulkWriteOptions,
    ): Promise<BulkWriteResult> {
        return this.runBulkWrite(
            'addMany',
            items,
            async (item) => {
                const docId = uuid2(18);
                await this.client.send(FlareAction.WRITE, {
                    collection: this.collection,
                    docId,
                    data: item,
                    merge: false,
                });
                return { docId };
            },
            options,
        );
    }

    /**
     * Update many documents by id with bounded memory and optional progress reporting.
     */
    async updateMany(
        items: Iterable<UpdateManyItem<T>> | AsyncIterable<UpdateManyItem<T>>,
        options?: BulkWriteOptions,
    ): Promise<BulkWriteResult> {
        return this.runBulkWrite(
            'updateMany',
            items,
            async (item) => {
                await this.client.send(FlareAction.WRITE, {
                    collection: this.collection,
                    docId: item.id,
                    data: item.data,
                    merge: true,
                });
                return { docId: item.id };
            },
            options,
        );
    }

    /**
     * Delete many documents by id with bounded memory and optional progress reporting.
     */
    async deleteMany(
        docIds: Iterable<string> | AsyncIterable<string>,
        options?: BulkWriteOptions,
    ): Promise<BulkWriteResult> {
        return this.runBulkWrite(
            'deleteMany',
            docIds,
            async (docId) => {
                await this.client.send(FlareAction.DELETE, {
                    collection: this.collection,
                    docId,
                });
                return { docId };
            },
            options,
        );
    }

    update(data: Partial<T>): DocumentQueryBuilder<T> {
        return new DocumentQueryBuilder<T>(this.client, this.collection).update(data);
    }

    delete(): DocumentQueryBuilder<T> {
        return new DocumentQueryBuilder<T>(this.client, this.collection).delete();
    }
}

export default CollectionReference;