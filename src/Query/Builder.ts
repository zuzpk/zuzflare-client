import { uuid2 } from "@zuzjs/core";
import FlareClient from "../Client";
import { FlareError } from "../Errors";
import ErrorCodes from "../Errors/codes";
import { QueryConfig, SubscriptionCallback, WhereCondition } from "../types";
import { FlareAction } from "../types/message";


/**
 * Parse ORM-style where condition: { age: ">= 25", role: "admin" }
 * Returns array of QueryConfig objects
 */
export function parseWhereCondition(condition: WhereCondition): QueryConfig[] {
    const queries: QueryConfig[] = [];
    
    for (const [field, value] of Object.entries(condition)) {
        if (typeof value === 'string') {
            // Check for operator prefix
            const match = value.match(/^(>=|<=|!=|>|<|==)\s*(.+)$/);
            if (match) {
                const [, op, val] = match;
                queries.push({
                    field,
                    op: op as any,
                    value: parseValue(val.trim())
                });
            } else {
                // No operator, assume equality
                queries.push({
                    field,
                    op: '==',
                    value
                });
            }
        } else if (Array.isArray(value)) {
            // Array implies 'in' operator
            queries.push({
                field,
                op: 'in',
                value
            });
        } else {
            // Direct value implies equality
            queries.push({
                field,
                op: '==',
                value
            });
        }
    }
    
    return queries;
}

/**
 * Parse string value to appropriate type
 */
export function parseValue(val: string): any {
    // Try to parse as number
    if (!isNaN(Number(val))) {
        return Number(val);
    }
    
    // Check for boolean
    if (val === 'true') return true;
    if (val === 'false') return false;
    
    // Check for null/undefined
    if (val === 'null') return null;
    if (val === 'undefined') return undefined;
    
    // Return as string
    return val;
}


/**
 * Query builder for document operations (ORM-style)
 * Supports: doc('users').update({...}).where({ id: 'alice' })
 * 
 * This class is thenable - you can await it directly without .execute() or .get()
 * @example
 * await doc('users').where({ id: 'alice' })
 * await doc('users').update({ name: 'Alice' }).where({ id: 'alice' })
 */
export class DocumentQueryBuilder<T = any> implements PromiseLike<T | null | void> {
    
    private whereCondition?: WhereCondition;
    private updateData?: Partial<T>;
    private setData?: Partial<T>;
    private deleteOp: boolean = false;
    private promise?: Promise<T | null | void>;
    
    constructor(
        private client: FlareClient<any>,
        private collection: string,
        private docIdFromRef?: string,
    ) {}

    /**
     * Set where condition
     */
    where(condition: WhereCondition): this {
        this.whereCondition = condition;
        return this;
    }

    /**
     * Set update data (for update operations)
     */
    update(data: Partial<T>): this {
        this.updateData = data;
        return this;
    }

    /**
     * Set data (for set operations)
     */
    set(data: Partial<T>): this {
        this.setData = data;
        return this;
    }

    /**
     * Mark for deletion
     */
    delete(): this {
        this.deleteOp = true;
        return this;
    }

    /**
     * Get the document ID from doc() reference or where condition.
     */
    private getDocId(): string {
        if (this.docIdFromRef) {
            return this.docIdFromRef;
        }
        
        if (this.whereCondition && (this.whereCondition.id || (this.whereCondition as any)._id)) {
            const idValue = this.whereCondition.id ?? (this.whereCondition as any)._id;
            if (typeof idValue === 'string') {
                return idValue;
            }
        }
        
        throw new FlareError('Document ID not specified. Use .where({ id: "..." }) or doc(collection, id)', ErrorCodes.QueryFailed);
    }

    /**
     * Execute the query
     * @deprecated Use await directly instead of .execute()
     */
    async execute(): Promise<T | null | void> {
        return this._execute();
    }

    /**
     * Internal execute method
     */
    private async _execute(): Promise<T | null | void> {
        const docId = this.getDocId();
        
        if (this.deleteOp) {
            await this.client.send(FlareAction.DELETE, {
                collection: this.collection,
                docId
            });
            return;
        }
        
        if (this.updateData) {
            await this.client.send(FlareAction.WRITE, {
                collection: this.collection,
                docId,
                data: this.updateData,
                merge: true
            });
            return;
        }
        
        if (this.setData) {
            await this.client.send(FlareAction.WRITE, {
                collection: this.collection,
                docId,
                data: this.setData,
                merge: false
            });
            return;
        }
        
        // Get operation
        return this.get();
    }

    /**
     * Make this class thenable so it can be awaited directly
     */
    then<TResult1 = T | null | void, TResult2 = never>(
        onfulfilled?: ((value: T | null | void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
        if (!this.promise) {
            this.promise = this._execute();
        }
        return this.promise.then(onfulfilled, onrejected);
    }

    /**
     * Get the document data once
     */
    async get(): Promise<T | null> {
        const docId = this.getDocId();
        const subId = uuid2(18);
        
        return new Promise((resolve, reject) => {
            const unsubscribe = this.client.subscribe(
                subId,
                this.collection,
                docId,
                undefined,
                (data) => {
                    if (data.type === 'snapshot') {
                        unsubscribe();
                        resolve(data.data as T);
                    }
                }
            );

            setTimeout(() => {
                unsubscribe();
                reject(new Error('Document fetch timeout'));
            }, 10000);
        });
    }

    /**
     * Subscribe to real-time updates
     */
    onSnapshot(callback: SubscriptionCallback<T>): () => void {
        const docId = this.getDocId();
        const subId = uuid2(18);
        return this.client.subscribe(subId, this.collection, docId, undefined, callback);
    }
}
