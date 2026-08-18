import { uuid2 } from "@zuzjs/core";
import FlareClient from "../Client";
import { DocChangedCallback, DocDeletedCallback, DocUpdatedCallback, SubscriptionCallback } from "../types";
import { FlareAction } from "../types/message";
import { DocumentQueryBuilder } from "./Builder";

/** Document reference */
class DocumentReference<T = any> {
    
    constructor(
        private client: FlareClient<any>,
        public readonly collection: string,
        public readonly id: string
    ) {}

    async get(): Promise<T | null> {
        const builder = new DocumentQueryBuilder<T>(this.client, this.collection, this.id);
        return builder.get();
    }

    async set(data: Partial<T>): Promise<void> {
        await this.client.send(FlareAction.WRITE, {
            collection: this.collection,
            docId: this.id,
            data,
            merge: false
        });
    }

    async update(data: Partial<T>): Promise<void> {
        await this.client.send(FlareAction.WRITE, {
            collection: this.collection,
            docId: this.id,
            data,
            merge: true
        });
    }

    /**
     * Updates the document and fetches it again, useful when server mutates
     * values (for example ServerTimeStamp sentinels).
     */
    async updateAndGet(data: Partial<T>): Promise<T | null> {
        await this.update(data);
        return this.get();
    }

    /**
     * Replaces the document and fetches it again.
     */
    async setAndGet(data: Partial<T>): Promise<T | null> {
        await this.set(data);
        return this.get();
    }

    async delete(): Promise<void> {
        await this.client.send(FlareAction.DELETE, {
            collection: this.collection,
            docId: this.id
        });
    }

    onSnapshot(callback: SubscriptionCallback<T>): () => void {
        const subId = uuid2(18);
        let unsubscribe = () => {};
        unsubscribe = this.client.subscribe(subId, this.collection, this.id, undefined, (event) => {
            if (event.type === 'snapshot') {
                callback(event as any);
                unsubscribe();
            }
        });
        return unsubscribe;
    }

    /**
     * Fires when this document is updated / replaced.
     */
    onDocUpdated(callback: DocUpdatedCallback<T>): () => void {
        const subId = uuid2(18);
        return this.client.subscribe(subId, this.collection, this.id, undefined, (event) => {
            if (event.type === 'change' && (event.operation === 'update' || event.operation === 'replace') && event.data) {
                callback(event.data as T, event.docId);
            }
        }, { skipSnapshot: true });
    }

    /**
     * Fires when this document is deleted.
     */
    onDocDeleted(callback: DocDeletedCallback<T>): () => void {
        const subId = uuid2(18);
        return this.client.subscribe(subId, this.collection, this.id, undefined, (event) => {
            if (event.type === 'change' && event.operation === 'delete') {
                callback(event.docId);
            }
        }, { skipSnapshot: true });
    }

    /**
     * Fires on any change to this document (update / delete).
     * `data` is null on deletes.
     */
    onDocChanged(callback: DocChangedCallback<T>): () => void {
        const subId = uuid2(18);
        return this.client.subscribe(subId, this.collection, this.id, undefined, (event) => {
            if (event.type === 'change') {
                callback(event.data as T ?? null, event.docId, event.operation);
            }
        }, { skipSnapshot: true });
    }
}

export default DocumentReference;