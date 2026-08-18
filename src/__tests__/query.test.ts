import { describe, expect, it, vi } from "vitest";
import { FlareError } from "../Errors";
import { CollectionReference, DocumentQueryBuilder, DocumentReference, parseValue, parseWhereCondition } from "../Query";
import { FlareAction } from "../types/message";

type SubscribeCb = (event: any) => void;

function createClient() {
  const send = vi.fn(async () => ({ data: [{ id: "row-1" }] }));
  const subscribeCalls: Array<{
    subId: string;
    collection: string;
    docId?: string;
    query?: unknown;
    callback: SubscribeCb;
    options?: unknown;
  }> = [];

  const subscribe = vi.fn((
    subId: string,
    collection: string,
    docId: string | undefined,
    query: unknown,
    callback: SubscribeCb,
    options?: unknown,
  ) => {
    subscribeCalls.push({ subId, collection, docId, query, callback, options });
    return vi.fn();
  });

  const presets = new Map<string, (ref: any, params: Record<string, unknown>) => any>();
  const registerQueryPreset = vi.fn((name: string, handler: (ref: any, params: Record<string, unknown>) => any) => {
    presets.set(name, handler);
    return client;
  });
  const applyQueryPreset = vi.fn((ref: any, name: string, params: Record<string, unknown> = {}) => {
    const preset = presets.get(name);
    if (!preset) throw new Error(`Unknown query preset \"${name}\"`);
    return preset(ref, params);
  });
  const hasQueryPreset = vi.fn((name: string) => presets.has(name));

  const client = { send, subscribe, subscribeCalls, registerQueryPreset, applyQueryPreset, hasQueryPreset } as any;

  return client;
}

describe("Query helpers", () => {
  it("parseValue parses number, booleans, null and undefined", () => {
    expect(parseValue("42")).toBe(42);
    expect(parseValue("true")).toBe(true);
    expect(parseValue("false")).toBe(false);
    expect(parseValue("null")).toBeNull();
    expect(parseValue("undefined")).toBeUndefined();
    expect(parseValue("hello")).toBe("hello");
  });

  it("parseWhereCondition supports operator strings, direct values and arrays", () => {
    const result = parseWhereCondition({
      age: ">= 25",
      role: "admin",
      active: true,
      tags: ["a", "b"],
    });

    expect(result).toEqual([
      { field: "age", op: ">=", value: 25 },
      { field: "role", op: "==", value: "admin" },
      { field: "active", op: "==", value: true },
      { field: "tags", op: "in", value: ["a", "b"] },
    ]);
  });
});

describe("DocumentQueryBuilder", () => {
  it("where/update/set/delete are chainable", () => {
    const client = createClient();
    const builder = new DocumentQueryBuilder<any>(client as any, "users");

    expect(builder.where({ id: "u1" })).toBe(builder);
    expect(builder.update({ name: "A" })).toBe(builder);
    expect(builder.set({ name: "B" })).toBe(builder);
    expect(builder.delete()).toBe(builder);
  });

  it("throws when document id is missing", async () => {
    const client = createClient();
    const builder = new DocumentQueryBuilder<any>(client as any, "users");

    await expect(builder.get()).rejects.toBeInstanceOf(FlareError);
  });

  it("execute writes update with merge true", async () => {
    const client = createClient();
    const builder = new DocumentQueryBuilder<any>(client as any, "users", "u1").update({ name: "N" });

    await builder.execute();

    expect(client.send).toHaveBeenCalledWith(FlareAction.WRITE, {
      collection: "users",
      docId: "u1",
      data: { name: "N" },
      merge: true,
    });
  });

  it("execute writes set with merge false", async () => {
    const client = createClient();
    const builder = new DocumentQueryBuilder<any>(client as any, "users", "u1").set({ name: "N" });

    await builder.execute();

    expect(client.send).toHaveBeenCalledWith(FlareAction.WRITE, {
      collection: "users",
      docId: "u1",
      data: { name: "N" },
      merge: false,
    });
  });

  it("execute sends delete request", async () => {
    const client = createClient();
    const builder = new DocumentQueryBuilder<any>(client as any, "users", "u1").delete();

    await builder.execute();

    expect(client.send).toHaveBeenCalledWith(FlareAction.DELETE, {
      collection: "users",
      docId: "u1",
    });
  });

  it("get resolves first snapshot and unsubscribes", async () => {
    const client = createClient();
    const unsubscribe = vi.fn();
    client.subscribe.mockImplementation((subId: string, collection: string, docId: string | undefined, query: unknown, callback: SubscribeCb) => {
      queueMicrotask(() => callback({ type: "snapshot", data: { id: "u1" } }));
      return unsubscribe;
    });

    const builder = new DocumentQueryBuilder<any>(client as any, "users", "u1");
    const value = await builder.get();

    expect(value).toEqual({ id: "u1" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is thenable and reuses execution promise", async () => {
    const client = createClient();
    const builder = new DocumentQueryBuilder<any>(client as any, "users", "u1").update({ x: 1 });

    await Promise.all([builder.then(() => undefined), builder.then(() => undefined)]);

    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("onSnapshot subscribes with computed id", () => {
    const client = createClient();
    const unsubscribe = vi.fn();
    client.subscribe.mockReturnValue(unsubscribe);

    const builder = new DocumentQueryBuilder<any>(client as any, "users", "u1");
    const stop = builder.onSnapshot(() => undefined);

    expect(client.subscribe).toHaveBeenCalledTimes(1);
    expect(typeof stop).toBe("function");
  });
});

describe("DocumentReference", () => {
  it("get delegates through DocumentQueryBuilder", async () => {
    const client = createClient();
    client.subscribe.mockImplementation((subId: string, collection: string, docId: string | undefined, query: unknown, callback: SubscribeCb) => {
      queueMicrotask(() => callback({ type: "snapshot", data: { id: "u1" } }));
      return vi.fn();
    });

    const doc = new DocumentReference<any>(client as any, "users", "u1");
    await expect(doc.get()).resolves.toEqual({ id: "u1" });
  });

  it("set/update/delete send expected actions", async () => {
    const client = createClient();
    const doc = new DocumentReference<any>(client as any, "users", "u1");

    await doc.set({ a: 1 });
    await doc.update({ b: 2 });
    await doc.delete();

    expect(client.send).toHaveBeenNthCalledWith(1, FlareAction.WRITE, {
      collection: "users",
      docId: "u1",
      data: { a: 1 },
      merge: false,
    });
    expect(client.send).toHaveBeenNthCalledWith(2, FlareAction.WRITE, {
      collection: "users",
      docId: "u1",
      data: { b: 2 },
      merge: true,
    });
    expect(client.send).toHaveBeenNthCalledWith(3, FlareAction.DELETE, {
      collection: "users",
      docId: "u1",
    });
  });

  it("onSnapshot forwards snapshot and unsubscribes", async () => {
    const client = createClient();
    const unsubscribe = vi.fn();
    client.subscribe.mockImplementation((subId: string, collection: string, docId: string | undefined, query: unknown, callback: SubscribeCb) => {
      queueMicrotask(() => callback({ type: "snapshot", data: [{ id: "u1" }] }));
      return unsubscribe;
    });

    const doc = new DocumentReference<any>(client as any, "users", "u1");
    await new Promise<void>((resolve) => {
      doc.onSnapshot((evt: any) => {
        expect(evt.type).toBe("snapshot");
        resolve();
      });
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("onDocUpdated subscribes for updates", () => {
    const client = createClient();
    const doc = new DocumentReference<any>(client as any, "users", "u1");

    doc.onDocUpdated(() => undefined);

    expect(client.subscribe).toHaveBeenCalledTimes(1);
  });

  it("onDocDeleted and onDocChanged subscribe", () => {
    const client = createClient();
    const doc = new DocumentReference<any>(client as any, "users", "u1");

    doc.onDocDeleted(() => undefined);
    doc.onDocChanged(() => undefined);

    expect(client.subscribe).toHaveBeenCalledTimes(2);
  });
});

describe("CollectionReference", () => {
  it("query builder methods build structured query and call QUERY", async () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "users")
      .where({ age: ">= 18" })
      .where({ status: "active" })
      .or({ tier: "pro" })
      .orderBy("age", "desc")
      .limit(10)
      .offset(2)
      .startAt(10)
      .startAfter(11)
      .endAt(20)
      .endBefore(21)
      .aggregate({ fn: "count", alias: "c" })
      .count()
      .sum("price")
      .avg("rating")
      .min("age")
      .max("age")
      .distinct("country")
      .groupBy("country")
      .having("count", ">", 1)
      .Join("profiles", { source: "id", target: "uid", as: "profile" })
      .select("id", "age")
      .distinctField("email")
      .vectorSearch({ field: "embedding", vector: [0.1, 0.2], k: 2 });

    const rows = await col.get();

    expect(rows).toEqual([{ id: "row-1" }]);
    expect(client.send).toHaveBeenCalledWith(FlareAction.QUERY, expect.objectContaining({ collection: "users" }));
  });

  it("getRawQuery returns generated structured query without execution", () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "boards")
      .where({ uid: "u1" })
      .orSome("team", { uid: "u1" })
      .orderBy("_seq", "desc")
      .limit(25)
      .offset(5);

    const raw = col.getRawQuery();

    expect(raw.collection).toBe("boards");
    expect(raw.query.limit).toBe(25);
    expect(raw.query.offset).toBe(5);
    expect(raw.query.orderBy).toEqual([{ field: "_seq", dir: "desc" }]);
    expect(raw.query.where).toBeDefined();
    expect(client.send).not.toHaveBeenCalled();
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it("keeps id guard outside OR when chaining where(...).orSome(...)", () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "boards")
      .where({ id: "b1", uid: "u1" })
      .orSome("team", { uid: "u1" });

    const raw = col.getRawQuery();
    expect(raw.query.where).toEqual([
      { field: "id", op: "==", value: "b1" },
      {
        or: [
          { field: "uid", op: "==", value: "u1" },
          { field: "team", op: "elem-match", value: { uid: "u1" } },
        ],
      },
    ]);
  });

  it("get falls back to subscribe path for simple query", async () => {
    const client = createClient();
    const unsubscribe = vi.fn();
    client.subscribe.mockImplementation((subId: string, collection: string, docId: string | undefined, query: unknown, callback: SubscribeCb) => {
      queueMicrotask(() => callback({ type: "snapshot", data: [{ id: "u1" }] }));
      return unsubscribe;
    });

    const col = new CollectionReference<any>(client as any, "users").where({ status: "active" });
    const rows = await col.get();

    expect(rows).toEqual([{ id: "u1" }]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("then makes collection awaitable", async () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "users").orderBy("id");

    const rows = await col;

    expect(rows).toEqual([{ id: "row-1" }]);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("onSnapshot, onDocAdded, onDocUpdated, onDocDeleted, onDocChanged subscribe", () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "users");

    col.onSnapshot(() => undefined);
    col.onDocAdded(() => undefined);
    col.onDocUpdated(() => undefined);
    col.onDocDeleted(() => undefined);
    col.onDocChanged(() => undefined);

    expect(client.subscribe).toHaveBeenCalledTimes(5);
  });

  it("doc returns DocumentReference, add writes a new document, update/delete return DocumentQueryBuilder", async () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "users");

    const doc = col.doc("u1");
    expect(doc).toBeInstanceOf(DocumentReference);

    const newDoc = await col.add({ name: "New" });
    expect(newDoc).toBeInstanceOf(DocumentReference);
    expect(client.send).toHaveBeenCalledWith(FlareAction.WRITE, expect.objectContaining({
      collection: "users",
      data: { name: "New" },
      merge: false,
    }));

    expect(col.update({ x: 1 })).toBeInstanceOf(DocumentQueryBuilder);
    expect(col.delete()).toBeInstanceOf(DocumentQueryBuilder);
  });

  it("addMany processes large input in chunks with progress", async () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "users");
    const payload = Array.from({ length: 1050 }, (_, i) => ({ index: i }));
    const progressEvents: any[] = [];

    const result = await col.addMany(payload, {
      batchSize: 200,
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    expect(result).toEqual({
      operation: "addMany",
      processed: 1050,
      succeeded: 1050,
      failed: 0,
      total: 1050,
    });
    expect(client.send).toHaveBeenCalledTimes(1050);
    expect(client.send).toHaveBeenNthCalledWith(
      1,
      FlareAction.WRITE,
      expect.objectContaining({ collection: "users", merge: false, data: { index: 0 } }),
    );
    expect(progressEvents[0]).toMatchObject({
      operation: "addMany",
      processed: 0,
      succeeded: 0,
      failed: 0,
      total: 1050,
      percent: 0,
    });
    expect(progressEvents.at(-1)).toMatchObject({
      operation: "addMany",
      processed: 1050,
      succeeded: 1050,
      failed: 0,
      total: 1050,
      percent: 100,
    });
  });

  it("updateMany supports continueOnError and reports failures", async () => {
    const client = createClient();
    client.send.mockImplementation(async (_type: FlareAction, payload: any) => {
      if (payload?.docId === "u2") {
        throw new Error("boom");
      }
      return { ok: true };
    });

    const col = new CollectionReference<any>(client as any, "users");
    const progressEvents: any[] = [];

    const result = await col.updateMany([
      { id: "u1", data: { score: 1 } },
      { id: "u2", data: { score: 2 } },
      { id: "u3", data: { score: 3 } },
    ], {
      continueOnError: true,
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
    });

    expect(result).toEqual({
      operation: "updateMany",
      processed: 3,
      succeeded: 2,
      failed: 1,
      total: 3,
    });
    expect(client.send).toHaveBeenCalledTimes(3);
    expect(client.send).toHaveBeenNthCalledWith(1, FlareAction.WRITE, {
      collection: "users",
      docId: "u1",
      data: { score: 1 },
      merge: true,
    });
    expect(client.send).toHaveBeenNthCalledWith(2, FlareAction.WRITE, {
      collection: "users",
      docId: "u2",
      data: { score: 2 },
      merge: true,
    });
    expect(client.send).toHaveBeenNthCalledWith(3, FlareAction.WRITE, {
      collection: "users",
      docId: "u3",
      data: { score: 3 },
      merge: true,
    });
    expect(progressEvents.some((entry) => entry.operation === "updateMany" && entry.failed === 1 && entry.lastError instanceof Error)).toBe(true);
    expect(progressEvents.at(-1)).toMatchObject({
      operation: "updateMany",
      processed: 3,
      succeeded: 2,
      failed: 1,
      total: 3,
      percent: 100,
    });
  });

  it("deleteMany rejects by default when an item fails", async () => {
    const client = createClient();
    client.send.mockImplementation(async (_type: FlareAction, payload: any) => {
      if (payload?.docId === "u2") {
        throw new Error("cannot delete");
      }
      return { ok: true };
    });
    const col = new CollectionReference<any>(client as any, "users");

    await expect(col.deleteMany(["u1", "u2", "u3"]))
      .rejects
      .toThrow("cannot delete");
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("with(name, params) applies a registered preset", async () => {
    const client = createClient();
    client.registerQueryPreset("withTasks", (ref: CollectionReference<any>, params: Record<string, unknown>) => {
      return ref
        .where({ id: String(params.boardId ?? "") })
        .Join("tasks", { source: "id", target: "boardId", as: "tasks" })
        .limit(Number(params.limit ?? 10));
    });

    const rows = await new CollectionReference<any>(client as any, "boards")
      .with("withTasks", { boardId: "b1", limit: 5 })
      .get();

    expect(rows).toEqual([{ id: "row-1" }]);
    expect(client.applyQueryPreset).toHaveBeenCalledWith(expect.any(CollectionReference), "withTasks", { boardId: "b1", limit: 5 });
    expect(client.send).toHaveBeenCalledWith(FlareAction.QUERY, expect.objectContaining({ collection: "boards" }));
  });

  it("supports nested joins with per-join query options", async () => {
    const client = createClient();

    await new CollectionReference<any>(client as any, "boards")
      .Join("tasks", {
        source: "id",
        target: "boardId",
        as: "tasks",
        orderBy: [{ field: "priority", dir: "desc" }],
        limit: 5,
        offset: 1,
        joins: [
          {
            collection: "comments",
            source: "id",
            target: "taskId",
            as: "comments",
            where: [{ field: "status", op: "==", value: "open" }],
            orderBy: [{ field: "createdAt", dir: "desc" }],
            limit: 3,
          },
        ],
      })
      .get();

    expect(client.send).toHaveBeenCalledWith(
      FlareAction.QUERY,
      expect.objectContaining({
        collection: "boards",
        query: expect.objectContaining({
          joins: [
            expect.objectContaining({
              from: "tasks",
              localField: "id",
              foreignField: "boardId",
              as: "tasks",
              orderBy: [{ field: "priority", dir: "desc" }],
              limit: 5,
              offset: 1,
              joins: [
                expect.objectContaining({
                  from: "comments",
                  localField: "id",
                  foreignField: "taskId",
                  as: "comments",
                  where: [{ field: "status", op: "==", value: "open" }],
                  limit: 3,
                }),
              ],
            }),
          ],
        }),
      }),
    );
  });

  it("supports multiple joins in a single chain", async () => {
    const client = createClient();

    await new CollectionReference<any>(client as any, "boards")
      .join("lists", { source: "id", target: "boardId", as: "lists" })
      .join("users", { source: "team.uid", target: "id", as: "teamMembers" })
      .get();

    expect(client.send).toHaveBeenCalledWith(
      FlareAction.QUERY,
      expect.objectContaining({
        query: expect.objectContaining({
          joins: [
            expect.objectContaining({ from: "lists", localField: "id", foreignField: "boardId", as: "lists" }),
            expect.objectContaining({ from: "users", localField: "team.uid", foreignField: "id", as: "teamMembers" }),
          ],
        }),
      }),
    );
  });

  it("supports nested joins via joinNested chain helper", () => {
    const client = createClient();

    const raw = new CollectionReference<any>(client as any, "boards")
      .join("lists", { source: "id", target: "boardId", as: "lists" })
      .joinNested("lists", "cards", { source: "id", target: "listId", as: "cards" })
      .joinNested("cards", "comments", { source: "id", target: "cardId", as: "comments" })
      .getRawQuery();

    expect(raw.query.joins).toEqual([
      {
        from: "lists",
        localField: "id",
        foreignField: "boardId",
        as: "lists",
        single: undefined,
        joins: [
          {
            from: "cards",
            localField: "id",
            foreignField: "listId",
            as: "cards",
            single: undefined,
            joins: [
              {
                from: "comments",
                localField: "id",
                foreignField: "cardId",
                as: "comments",
                single: undefined,
              },
            ],
          },
        ],
      },
    ]);
  });

  it("supports relation shorthand withRelation(source->collection.target)", async () => {
    const client = createClient();

    await new CollectionReference<any>(client as any, "boards")
      .where({ id: "b1", uid: "u1" })
      .withRelation("team.uid->users.id", { as: "teamMembers", limit: 10 })
      .get();

    expect(client.send).toHaveBeenCalledWith(
      FlareAction.QUERY,
      expect.objectContaining({
        collection: "boards",
        query: expect.objectContaining({
          joins: [
            expect.objectContaining({
              from: "users",
              localField: "team.uid",
              foreignField: "id",
              as: "teamMembers",
              limit: 10,
            }),
          ],
        }),
      }),
    );
  });

  it("supports relation shorthand alias inline with 'as'", () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "boards")
      .withRelation("team.uid->users.id as teamMembers");

    const raw = col.getRawQuery();
    expect(raw.query.joins).toEqual([
      {
        from: "users",
        localField: "team.uid",
        foreignField: "id",
        as: "teamMembers",
        single: undefined,
      },
    ]);
  });

  it("supports direct preset method call collection().withTasks(...) when preset is registered", async () => {
    const client = createClient();
    client.registerQueryPreset("withTasks", (ref: CollectionReference<any>, params: Record<string, unknown>) => {
      return ref
        .where({ id: String(params.boardId ?? "") })
        .Join("tasks", { source: "id", target: "boardId", as: "tasks" })
        .limit(Number(params.limit ?? 10));
    });

    const col = new CollectionReference<any>(client as any, "boards") as any;
    const rows = await col.withTasks({ boardId: "b2", limit: 3 }).get();

    expect(rows).toEqual([{ id: "row-1" }]);
    expect(client.hasQueryPreset).toHaveBeenCalledWith("withTasks");
    expect(client.applyQueryPreset).toHaveBeenCalledWith(expect.any(CollectionReference), "withTasks", { boardId: "b2", limit: 3 });
  });

  it("stream emits initial snapshot and batches burst changes", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const col = new CollectionReference<any>(client as any, "messages");
      const stream = col.stream({ flushMs: 20, maxBatchSize: 10 });
      const renders: Array<{ ids: string[]; reason: string; batchSize: number; ready: boolean }> = [];

      stream.subscribe((rows, meta) => {
        renders.push({
          ids: rows.map((row) => row.id),
          reason: meta.reason,
          batchSize: meta.batchSize,
          ready: meta.ready,
        });
      });

      const callback = client.subscribeCalls[0]?.callback;
      expect(typeof callback).toBe("function");

      callback({
        type: "snapshot",
        data: [{ id: "m1", text: "a" }],
      });

      expect(renders.at(-1)).toEqual({ ids: ["m1"], reason: "snapshot", batchSize: 0, ready: true });
      expect(stream.getSnapshot().map((row) => row.id)).toEqual(["m1"]);

      callback({
        type: "change",
        operation: "insert",
        docId: "m2",
        data: { id: "m2", text: "b" },
      });
      callback({
        type: "change",
        operation: "update",
        docId: "m1",
        data: { id: "m1", text: "a2" },
      });

      expect(renders.at(-1)).toEqual({ ids: ["m1"], reason: "snapshot", batchSize: 0, ready: true });

      await vi.advanceTimersByTimeAsync(21);

      expect(renders.at(-1)).toEqual({ ids: ["m1", "m2"], reason: "change-batch", batchSize: 2, ready: true });
      expect(stream.getSnapshot()).toEqual([
        { id: "m1", text: "a2" },
        { id: "m2", text: "b" },
      ]);

      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stream flushes immediately when maxBatchSize is reached", () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "messages");
    const stream = col.stream({ flushMs: 1000, maxBatchSize: 2 });
    const renderCounts: number[] = [];

    stream.subscribe((rows, meta) => {
      if (meta.ready) {
        renderCounts.push(rows.length);
      }
    }, false);

    const callback = client.subscribeCalls[0]?.callback;
    callback({ type: "snapshot", data: [] });
    callback({ type: "change", operation: "insert", docId: "m1", data: { id: "m1" } });

    expect(renderCounts).toEqual([0]);

    callback({ type: "change", operation: "insert", docId: "m2", data: { id: "m2" } });

    expect(renderCounts).toEqual([0, 2]);
    expect(stream.getSnapshot().map((row) => row.id)).toEqual(["m1", "m2"]);

    stream.close();
  });

  it("asStore exposes external-store compatible subscribe/getSnapshot", () => {
    const client = createClient();
    const col = new CollectionReference<any>(client as any, "messages");
    const store = col.asStore({ flushMs: 1000, maxBatchSize: 2 });
    const changes = vi.fn();

    const unsubscribe = store.subscribe(changes);
    const callback = client.subscribeCalls[0]?.callback;

    callback({ type: "snapshot", data: [{ id: "m1" }] });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().map((row) => row.id)).toEqual(["m1"]);

    callback({ type: "change", operation: "insert", docId: "m2", data: { id: "m2" } });
    callback({ type: "change", operation: "insert", docId: "m3", data: { id: "m3" } });

    expect(changes).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
    expect(store.getServerSnapshot()).toEqual([]);

    unsubscribe();
    store.destroy();
  });
});
