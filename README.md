# ZuzFlare Client

Official JavaScript/TypeScript client for ZuzFlare Server.

[![npm version](https://badge.fury.io/js/%40zuzjs%2Fflare.svg)](https://www.npmjs.com/package/@zuzjs/flare)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

```bash
npm install @zuzjs/flare
```

## Maintainer Rule

When adding or changing any public SDK API, update this README in the same commit and add a usage example for that API.

## Quick Start

```ts
import { connectApp } from '@zuzjs/flare';

const app = connectApp({
  endpoint: 'https://flare.zuzcdn.net',
  appId: 'my-app',
  apiKey: 'app-api-key',
});

await app.collection('users').doc('alice').set({
  name: 'Alice',
  email: 'alice@example.com',
});

app.collection('users').onSnapshot((snapshot) => {
  console.log('snapshot', snapshot);
});
```

## Public API Usage Examples

### Core Instance

```ts
import { connectApp, getFlare, disconnectFlare } from '@zuzjs/flare';

const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });
const same = getFlare();
disconnectFlare();
```

### Bulk Writes (Memory Efficient)

`addMany`, `updateMany`, and `deleteMany` process data in bounded chunks so very large input streams can run without loading everything into memory at once.

```ts
const users = app.collection<{ name: string; plan?: string }>('users');

// Add many from an array
const addResult = await users.addMany(
  [{ name: 'Alice' }, { name: 'Bob' }],
  {
    batchSize: 500,
    concurrency: 8,
    onProgress: (p) => {
      console.log('addMany', p.processed, p.total, p.percent);
    },
  },
);

// Update many by id
const updateResult = await users.updateMany(
  [
    { id: 'user_1', data: { plan: 'pro' } },
    { id: 'user_2', data: { plan: 'team' } },
  ],
  { continueOnError: true },
);

// Delete many by id
const deleteResult = await users.deleteMany(['user_3', 'user_4']);

console.log({ addResult, updateResult, deleteResult });
```

```ts
// Stream input from an async source (best for huge datasets)
async function* rows() {
  for (let i = 0; i < 1_000_000; i += 1) {
    yield { name: `user-${i}` };
  }
}

await app.collection('users').addMany(rows(), { batchSize: 1000, concurrency: 4 });
```

### Auth Config And State

```ts
const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

await app.ensureCsrfProtection();
const config = await app.loadAuthConfig();

const offConfig = app.onAuthConfigLoaded((next) => {
  console.log('auth config loaded', next.providers);
});

const offState = app.onAuthStateChanged((session) => {
  console.log('auth state', session?.uid);
});

const legacyOffState = app.onAuthStateChange((session) => {
  console.log('legacy listener', session?.uid);
});

console.log('csrf cookie name', app.getCsrfCookieName());
console.log('csrf token', app.getCsrfToken());
console.log('current user', app.getCurrentUser());

offConfig();
offState();
legacyOffState();
```

### Email Password Auth

```ts
const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

await app.createUserWithEmail('alice@example.com', 'StrongPassword123!');
await app.createUserWithEmailAndPassword('bob@example.com', 'StrongPassword123!');

await app.signInWithEmail('alice@example.com', 'StrongPassword123!');
await app.signInWithEmailAndPassword('bob@example.com', 'StrongPassword123!');

await app.signInOrCreateWithEmail('carol@example.com', 'StrongPassword123!');
await app.signInOrCreateWithEmailAndPassword('dave@example.com', 'StrongPassword123!');

await app.auth('<access-token>');
await app.refreshAuthSession();
await app.signOut();
```

### Email Verification And Recovery

```ts
const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

const verifySent = await app.sendEmailVerification('alice@example.com');
await app.verifyEmailWithCode('alice@example.com', '123456');
await app.confirmEmailLink('<link-token>', 'alice@example.com');

const recoverySent = await app.sendAccountRecovery('alice@example.com');
await app.recoverAccountWithCode('alice@example.com', '123456', 'NextStrongPassword123!');
await app.recoverAccountWithToken('<recovery-token>', 'NextStrongPassword123!');

console.log(verifySent, recoverySent);
```

### OAuth Helpers

```ts
const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

await app.signIn('google');
await app.signInWithGoogle();
await app.signInWithGitHub();
await app.signInWithFacebook();
await app.signInWithDropbox();

const redirectResult = await app.handleSignInRedirect();
console.log('oauth redirect result', redirectResult);
```

### SSR Token

```ts
const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

const ssr = await app.issueSsrToken(120);
console.log(ssr.token, ssr.expires_in);
```

### Push APIs

```ts
const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

await app.setupPushServiceWorker();
await app.requestPushPermission();

const { token } = await app.acquireBrowserPushToken();
await app.registerPushToken({ token, platform: 'web', topics: ['news'] });

await app.enableBrowserPush({ topics: ['marketing'] });

await app.sendPushNotification({
  title: 'Hello',
  body: 'Welcome back',
  topic: 'news',
});

await app.unregisterPushToken(token);
```

### Burst Stream API (Chat, Group Chat, Activity Feeds)

Use `stream()` to keep a live in-memory list with batched updates.
This avoids one render per incoming change during message bursts.

```ts
const messageStream = app
  .collection('messages')
  .where({ roomId: 'room-1' })
  .latest()
  .limit(200)
  .stream({
    flushMs: 24,        // collapse burst updates into short windows
    maxBatchSize: 200,  // force flush when queue gets large
    insertAt: 'start',  // keep latest-first lists stable for chat UIs
    maxDocs: 200,
  });

const stop = messageStream.subscribe((rows, meta) => {
  console.log('rows', rows.length, 'ready', meta.ready, 'reason', meta.reason);
});

// Read current snapshot any time (works well with external-store patterns)
const currentRows = messageStream.getSnapshot();

// Optional subscription-level error hooks
messageStream
  .onError((err) => console.error('stream error', err))
  .onPermissionDenied((err) => console.error('permission denied', err));

// Cleanup
stop();
messageStream.close();
```

### Pagination Patterns (Stream vs Manual)

Use one of these based on UX needs:

- Stream page window: realtime for the current page; rebuild stream when page changes.
- Manual cursor paging: deterministic `load more` and stable history.
- Hybrid: stream first page (latest data) and fetch older pages manually.

#### 1) Stream Page Window (offset-based)

```tsx
import { useEffect, useMemo, useState } from 'react';
import { collection, Collections, useLiveQuery } from '@zuzjs/flare';

const PAGE_SIZE = 25;

export function ContactsPagedStream() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  const contacts = useLiveQuery({
    onData: (data, meta) => {
      setLoading(!meta.ready);
      setRows(data as any[]);
    },
  });

  const query = useMemo(() => {
    return collection(Collections.Contacts)
      .where({ sheet: '!= null' })
      .orderBy('_seq', 'desc')
      .limit(PAGE_SIZE)
      .offset(page * PAGE_SIZE);
  }, [page]);

  useEffect(() => {
    contacts.buildStream(query);
    return () => contacts.closeStream();
  }, [contacts, query]);

  return (
    <div>
      <div>{loading ? 'Loading...' : `Rows: ${rows.length}`}</div>
      <button onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</button>
      <button onClick={() => setPage((p) => p + 1)}>Next</button>
    </div>
  );
}
```

Notes:

- This keeps only one live page at a time.
- Realtime inserts can shift offset pages; this is expected for live data.

#### 2) Manual Cursor Pagination (recommended for stable "load more")

```tsx
import { useEffect, useState } from 'react';
import { collection, Collections } from '@zuzjs/flare';

const PAGE_SIZE = 25;

export function ContactsManualPagination() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const loadInitial = async () => {
    setLoading(true);
    const page = await collection(Collections.Contacts)
      .where({ sheet: '!= null' })
      .orderBy('_seq', 'desc')
      .limit(PAGE_SIZE)
      .get();

    setRows(page as any[]);
    const last = (page as any[])[(page as any[]).length - 1];
    setCursor(last?._seq ?? null);
    setHasMore((page as any[]).length === PAGE_SIZE);
    setLoading(false);
  };

  const loadMore = async () => {
    if (!hasMore || cursor == null) return;
    setLoading(true);

    const page = await collection(Collections.Contacts)
      .where({ sheet: '!= null' })
      .orderBy('_seq', 'desc')
      .startAfter(cursor)
      .limit(PAGE_SIZE)
      .get();

    const next = page as any[];
    setRows((prev) => [...prev, ...next]);
    const last = next[next.length - 1];
    setCursor(last?._seq ?? null);
    setHasMore(next.length === PAGE_SIZE);
    setLoading(false);
  };

  useEffect(() => {
    void loadInitial();
  }, []);

  return (
    <div>
      <div>{loading ? 'Loading...' : `Rows: ${rows.length}`}</div>
      <button onClick={loadMore} disabled={!hasMore || loading}>
        {hasMore ? 'Load more' : 'No more'}
      </button>
    </div>
  );
}
```

#### 3) Hybrid (stream latest page + manual history)

```tsx
import { useEffect, useMemo, useState } from 'react';
import { collection, Collections, useLiveQuery } from '@zuzjs/flare';

const PAGE_SIZE = 25;

export function ContactsHybridPagination() {
  const [liveRows, setLiveRows] = useState<any[]>([]);
  const [historyRows, setHistoryRows] = useState<any[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  const live = useLiveQuery({
    onData: (data, meta) => {
      setReady(meta.ready);
      setLiveRows(data as any[]);
    },
  });

  const liveQuery = useMemo(() => {
    return collection(Collections.Contacts)
      .where({ sheet: '!= null' })
      .orderBy('_seq', 'desc')
      .limit(PAGE_SIZE);
  }, []);

  useEffect(() => {
    live.buildStream(liveQuery);
    return () => live.closeStream();
  }, [live, liveQuery]);

  const loadOlder = async () => {
    const anchor = historyCursor ?? liveRows[liveRows.length - 1]?._seq;
    if (anchor == null) return;

    const page = await collection(Collections.Contacts)
      .where({ sheet: '!= null' })
      .orderBy('_seq', 'desc')
      .startAfter(anchor)
      .limit(PAGE_SIZE)
      .get();

    const next = page as any[];
    setHistoryRows((prev) => [...prev, ...next]);
    setHistoryCursor(next[next.length - 1]?._seq ?? anchor);
  };

  const allRows = [...liveRows, ...historyRows];

  return (
    <div>
      <div>{ready ? `Rows: ${allRows.length}` : 'Loading live page...'}</div>
      <button onClick={loadOlder}>Load older</button>
    </div>
  );
}
```

Tip:

- For feeds/chat, hybrid mode usually gives the best UX: live top of list + stable older history.

#### React.js Example

```tsx
import { useEffect, useMemo, useState } from 'react';
import { connectApp } from '@zuzjs/flare';

type Message = {
  id: string;
  roomId: string;
  text: string;
  createdAt: number;
};

const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

export function RoomMessages({ roomId }: { roomId: string }) {
  const [rows, setRows] = useState<readonly Message[]>([]);
  const [ready, setReady] = useState(false);

  const stream = useMemo(() => {
    return app
      .collection<Message>('messages')
      .where({ roomId })
      .latest()
      .limit(200)
      .stream({ flushMs: 20, maxBatchSize: 250, insertAt: 'start', maxDocs: 200 });
  }, [roomId]);

  useEffect(() => {
    const stop = stream.subscribe((nextRows, meta) => {
      setRows(nextRows);
      setReady(meta.ready);
    });

    return () => {
      stop();
      stream.close();
    };
  }, [stream]);

  if (!ready) return <p>Loading messages...</p>;

  return (
    <ul>
      {rows.map((m) => (
        <li key={m.id}>{m.text}</li>
      ))}
    </ul>
  );
}
```

#### React Storage Queue Hook (Start/Pause)

```tsx
import { useMemo } from 'react';
import { connectApp } from '@zuzjs/flare';
import { useStorage, Status } from '@zuzjs/flare/react';

const app = connectApp({
  endpoint: 'http://localhost:8080',
  appId: 'my-app',
});

export function StorageUploader() {
  const storage = useMemo(() => app.storage(), []);

  const upload = useStorage(storage, {
    onItemComplete: (item, result) => {
      console.log('uploaded', item.objectKey, result.url);
    },
    onItemError: (item, err) => {
      console.error('upload failed', item.objectKey, err.message);
    },
  });

  const onSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    upload.addToQueue(
      files.map((file) => ({
        file,
        bucket: 'attachments',
        key: `uploads/${Date.now()}-${file.name}`,
        contentType: file.type || 'application/octet-stream',
        access: 'public',
      })),
    );
  };

  return (
    <div>
      <input type='file' multiple onChange={onSelect} />

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={() => void upload.start()} disabled={!upload.hasPending || upload.running}>
          Start
        </button>
        <button onClick={upload.pause} disabled={!upload.running}>
          Pause
        </button>
      </div>

      <ul>
        {upload.que.map((item) => (
          <li key={item.id}>
            {item.objectKey} - {item.progress}% - {Status[item.status]}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`addToQueue(...)` auto-starts uploads by default.

Manual mode example (only upload when `start()` is clicked):

```tsx
const upload = useStorage(storage, {
  autoStartOnAdd: false,
});

upload.addToQueue([
  {
    file,
    bucket: 'attachments',
    key: `uploads/${Date.now()}-${file.name}`,
  },
]);

await upload.start();
```

Notes:

- Queue items expose `item.objectKey` (not `item.key`) to avoid React prop-name conflicts.
- `addToQueue(...)` input still uses `key` because it maps directly to `putObject({ key })`.
- `addToQueue(...)` starts processing immediately unless `autoStartOnAdd: false` or the queue is paused.
- `pause()` stops scheduling new uploads; it does not cancel an already in-flight request.
- Call `start()` again to continue with remaining queued items.

#### Next.js Example (Client Component)

```tsx
'use client';

import { useSyncExternalStore } from 'react';
import { connectApp } from '@zuzjs/flare';

type Message = { id: string; roomId: string; text: string; createdAt: number };

const app = connectApp({
  endpoint: process.env.NEXT_PUBLIC_FLARE_ENDPOINT!,
  appId: process.env.NEXT_PUBLIC_FLARE_APP_ID!,
  apiKey: process.env.NEXT_PUBLIC_FLARE_API_KEY,
});

export default function RoomStream({ roomId }: { roomId: string }) {
  const store = app
    .collection<Message>('messages')
    .where({ roomId })
    .latest()
    .limit(200)
    .asStore({ flushMs: 20, maxBatchSize: 250, insertAt: 'start', maxDocs: 200 });

  const rows = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  return (
    <section>
      {rows.map((m) => (
        <p key={m.id}>{m.text}</p>
      ))}
    </section>
  );
}
```

#### Redux Example

```ts
import { createSlice, PayloadAction, configureStore } from '@reduxjs/toolkit';
import { connectApp } from '@zuzjs/flare';

type Message = { id: string; roomId: string; text: string; createdAt: number };

const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

const messagesSlice = createSlice({
  name: 'messages',
  initialState: [] as Message[],
  reducers: {
    replaceMessages: (_state, action: PayloadAction<readonly Message[]>) => [...action.payload],
  },
});

export const { replaceMessages } = messagesSlice.actions;
export const store = configureStore({ reducer: { messages: messagesSlice.reducer } });

export function startRoomMessageStream(roomId: string): () => void {
  const stream = app
    .collection<Message>('messages')
    .where({ roomId })
    .latest()
    .limit(200)
    .stream({ flushMs: 20, maxBatchSize: 250, insertAt: 'start', maxDocs: 200 });

  const stop = stream.subscribe((rows) => {
    store.dispatch(replaceMessages(rows));
  });

  return () => {
    stop();
    stream.close();
  };
}
```

### External Store Bridge (No Framework Dependency)

The client also exposes `asStore()` so app code can plug into external-store hooks
while keeping this package free of framework dependencies.

```ts
const messageStore = app
  .collection('messages')
  .where({ roomId: 'room-1' })
  .latest()
  .limit(200)
  .asStore({ flushMs: 24, maxBatchSize: 200, insertAt: 'start' });

// In app code, pass these to your UI store hook:
messageStore.subscribe;      // (onStoreChange) => unsubscribe
messageStore.getSnapshot;    // () => readonly rows
messageStore.getServerSnapshot; // () => []

// Optional advanced access
messageStore.stream.onError((err) => console.error(err));

// Cleanup
messageStore.destroy();
```

### Direct Query Helpers (Knex-Style)

`collection()` query chaining uses object-based logical steps and dedicated operator families:

- Logic: `where({...})`, `and({...})`, `or({...})`
- `in` family: `in`, `andIn`, `orIn`
- `notIn` family: `notIn`, `andNotIn`, `orNotIn`
- `arrayContains` family: `arrayContains`, `andArrayContains`, `orArrayContains`
- `arrayContainsAny` family: `arrayContainsAny`, `andArrayContainsAny`, `orArrayContainsAny`
- `some` family (array of objects): `some`, `andSome`, `orSome`
- `like` family: `like`, `andLike`, `orLike`
- `notLike` family: `notLike`, `andNotLike`, `orNotLike`
- `exists` family: `exists`, `andExists`, `orExists`
- `notExists` family: `notExists`, `andNotExists`, `orNotExists`

```ts
const uid = 'bDEgnSqsEDT5qdDdtOX1';

const boards = await app
  .collection('boards')
  .where({ uid })
  .orArrayContains('team', uid)
  .orderBy('createdAt', 'desc')
  .limit(20)
  .get();

const sameBoards = await app
  .collection('boards')
  .where({ uid })
  .orArrayContains('team', uid)
  .get();

const active = await app
  .collection('tasks')
  .in('status', ['todo', 'doing'])
  .andArrayContainsAny('labels', ['urgent', 'backend'])
  .andLike('title', '%bug%')
  .get();

const boardAccess = await app
  .collection('boards')
  .some('team', { uid: 'xyz', role: 1 })
  .get();
```

### Advanced Joins And Relations

Use `join()` when you want direct field mapping, including array/object-path sources.

```ts
const boardWithLists = await app
  .collection('boards')
  .where({ id: boardId, uid: me.uid })
  .join('lists', {
    source: 'id',
    target: 'boardId',
    as: 'lists',
  })
  .limit(1)
  .get();

const boardWithTeamMembers = await app
  .collection('boards')
  .where({ id: boardId, uid: me.uid })
  .join('users', {
    source: 'team.uid', // team: [{ uid, role }]
    target: 'id',
    as: 'teamMembers',
  })
  .limit(1)
  .get();
```

Use `withRelation()` for SQL-style shorthand.

```ts
const boardWithTeamMembers = await app
  .collection('boards')
  .where({ id: boardId, uid: me.uid })
  .withRelation('team.uid->users.id', { as: 'teamMembers' })
  .limit(1)
  .get();

const boardWithInlineAlias = await app
  .collection('boards')
  .where({ id: boardId, uid: me.uid })
  .withRelation('team.uid->users.id as teamMembers')
  .limit(1)
  .get();

const boardWithMultipleJoins = await app
  .collection('boards')
  .where({ id: boardId, uid: me.uid })
  .join('lists', { source: 'id', target: 'boardId', as: 'lists' })
  .join('users', { source: 'team.uid', target: 'id', as: 'teamMembers' })
  .limit(1)
  .get();

const boardWithNestedJoinChain = await app
  .collection('boards')
  .join('lists', { source: 'id', target: 'boardId', as: 'lists' })
  .joinNested('lists', 'cards', { source: 'id', target: 'listId', as: 'cards' })
  .joinNested('cards', 'comments', { source: 'id', target: 'cardId', as: 'comments' })
  .get();
```

Nested join options are supported per relation (`where`, `orderBy`, `limit`, `offset`, `select`, and nested `joins`).

Join alias note:
- `.join('users', ...)` and `.join('_users', ...)` both resolve to the app auth-users collection (`_flare_auth_users`) on server.
- Use `_users` when you want an explicit auth-collection relation in query code.

### Data Mapper (Collection + Join Alias)

You can provide `dataMapper` in `connectApp(...)` to shape inbound rows on the client side.

Mapping rules:
- Base collection rows use the mapper key matching the collection name.
- Joined rows use the mapper key matching join `as`.

```ts
import { connectApp } from '@zuzjs/flare';

const app = connectApp({
  endpoint: 'https://flare.zuzcdn.net',
  appId: 'my-app',
  apiKey: 'FA_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  dataMapper: {
    boards: (row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: new Date(row.createdAt ?? row.created_at),
    }),
    team: (row) => ({
      id: row.id,
      name: row.authMeta?.additionalParams?.name || 'Unknown',
      email: row.email,
      createdAt: new Date(row.createdAt ?? row.created_at),
    }),
  },
});

const boards = await app
  .collection('boards')
  .where({ boardId: '123' })
  .join('users', {
    source: 'team.uid',
    target: 'uid',
    as: 'team',
  })
  .get();

// boards[*] is mapped by dataMapper.boards
// boards[*].team[*] is mapped by dataMapper.team (join alias)
```

Tip: If your join alias is `team`, define `dataMapper.team` (not `dataMapper.users`) for that join payload.

### Storage API (S3-like)

```ts
import { connectApp, FlareStorageSignedAction } from '@zuzjs/flare';

const app = connectApp({
  endpoint: 'https://flare.zuzcdn.net',
  appId: 'my-app',
  apiKey: 'ak',
  storage: {
    /**
     * Built-in transfer manager — serialises uploads/downloads so calling
     * putObject / getObject without `await` is always safe.
     */
    transferManager: {
      enabled: true,
      uploadConcurrency: 1,   // one upload at a time (default)
      downloadConcurrency: 2, // allow two parallel downloads
    },
  },
});

const storage = app.storage();

await storage.createBucket('avatars');

// ── Raw binary upload (default) ──────────────────────────────────────────────
// By default putObject uploads files via a signed URL as raw binary.
// This is efficient for any file size and provides upload progress in browsers.
const uploaded = await storage.putObject({
  bucket: 'avatars',
  key: 'users/alice.png',
  body: fileOrBlobOrBytes,
  contentType: 'image/png',
  onProgress: (p) => {
    console.log(`uploaded ${p.loaded}/${p.total} (${p.percent}%)`);
  },
});

console.log(uploaded.key);    // users/alice.png
console.log(uploaded.access); // public (default)
console.log(uploaded.url);    // https://.../storage/public/<appId>/avatars/users%2Falice.png

// ── Base64 upload (opt-in, small files only) ─────────────────────────────────
// Pass `base64: true` to use the legacy base64-over-JSON path.
// If the payload exceeds `base64MaxBytes` (default 4 MiB), the SDK
// automatically falls back to raw signed-URL upload.
const uploaded2 = await storage.putObject({
  bucket: 'avatars',
  key: 'users/thumb.png',
  body: smallFileBytes,
  contentType: 'image/png',
  access: 'private',   // override the default public access
  base64: true,         // prefer base64 path
  base64MaxBytes: 2 * 1024 * 1024, // cap at 2 MiB; larger → raw upload
});

// ── Pre-encoded base64 (always uses base64 path) ─────────────────────────────
const uploaded3 = await storage.putObject({
  bucket: 'avatars',
  key: 'users/icon.png',
  contentBase64: alreadyEncodedString,
  contentType: 'image/png',
  // encrypt defaults to false when omitted
});

const head = await storage.headObject({ bucket: 'avatars', key: uploaded.key });
console.log(head.access, head.url);

const file = await storage.getObject({ bucket: 'avatars', key: uploaded.key });

const page1 = await storage.listObjects({ bucket: 'avatars', prefix: 'users/', limit: 100 });
console.log(page1.objects[0]?.access, page1.objects[0]?.url);

const page2 = page1.cursor
  ? await storage.listObjects({ bucket: 'avatars', prefix: 'users/', limit: 100, cursor: page1.cursor })
  : { objects: [] };

await storage.copyObject({
  sourceBucket: 'avatars',
  sourceKey: 'users/alice.png',
  destBucket: 'avatars-backup',
  destKey: 'users/alice.png',
});

await storage.deleteObjects({
  bucket: 'avatars',
  keys: ['users/alice.png', 'users/bob.png'],
});

const signedUpload = await storage.createSignedUrl({
  bucket: 'media',
  key: 'uploads/clip.mp4',
  action: FlareStorageSignedAction.Upload,
  expiresInSeconds: 300,
  contentType: 'video/mp4',
  access: 'private',
  encrypt: true,
});

await fetch(signedUpload.url, {
  method: signedUpload.method,
  headers: { 'Content-Type': 'video/mp4' },
  body: videoBlob,
});
```

Direct helpers are also available on the app instance:

```ts
await app.createBucket('files');
await app.putObject({ bucket: 'files', key: 'docs/readme.txt', body: 'hello' });
const doc = await app.getObject({ bucket: 'files', key: 'docs/readme.txt' });
await app.deleteObject({ bucket: 'files', key: 'docs/readme.txt' });

const signedDownload = await app.createSignedUrl({
  bucket: 'files',
  key: 'docs/readme.txt',
  action: FlareStorageSignedAction.Download,
  expiresInSeconds: 120,
});

console.log('signed url expires at unix seconds', signedDownload.expiresAt);
console.log('signed url ttl seconds', signedDownload.expiresInSeconds);
```

### Signed URL Download Policies

`token` (for example `st_...`) is only a ticket identifier. Expiry is enforced server-side and returned via `expiresAt` / `expiresInSeconds`.

```ts
import { connectApp, FlareStorageSignedAction } from '@zuzjs/flare';

const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });
const storage = app.storage();

const signed = await storage.createSignedUrl({
  bucket: 'media',
  key: 'videos/intro.mp4',
  action: FlareStorageSignedAction.Download,
  expiresInSeconds: 180,
  forceDownload: true,
  allowedOrigins: ['https://app.example.com'],
  embedOnly: false,
});

console.log(signed.url, signed.expiresAt, signed.expiresInSeconds);
```

Helper APIs:

```ts
// 1) Get a direct signed download URL.
const url = await storage.getObjectUrl({
  bucket: 'media',
  key: 'images/hero.png',
  expiresInSeconds: 90,
  allowedOrigins: ['*'],
});

// 2) Trigger browser download (defaults to forceDownload: true).
await storage.downloadObject({
  bucket: 'media',
  key: 'images/hero.png',
  filename: 'hero.png',
  expiresInSeconds: 90,
  allowedOrigins: ['https://app.example.com'],
  forceDownload: true,
});

// 3) Embed-only URL for media tags (<img>, <video>, <audio>).
const embedUrl = await storage.getObjectUrl({
  bucket: 'media',
  key: 'videos/trailer.mp4',
  embedOnly: true,
  allowedOrigins: ['https://app.example.com'],
});
```

Notes:
- `putObject()` defaults to `encrypt: false` and `access: 'public'`.
- `uploaded.url` is the stable public object URL shape. Anonymous reads still depend on stored `access` and any storage rules configured on the app.
- `headObject()` and `listObjects()` also return `access` and `url` metadata.
- `forceDownload` and `embedOnly` are mutually exclusive.
- `allowedOrigins` defaults to `['*']` when omitted.
- `embedOnly` is valid only for download signed URLs.

### Transfer Manager

The built-in transfer manager queues uploads and downloads so fire-and-forget calls
remain safe without needing a manual `await` at the call site.

```ts
const app = connectApp({
  endpoint: 'https://flare.zuzcdn.net',
  appId: 'my-app',
  apiKey: 'ak',
  storage: {
    transferManager: {
      enabled: true,
      uploadConcurrency: 1,   // default — uploads are serialised
      downloadConcurrency: 2, // allow two downloads in parallel
    },
  },
});

const storage = app.storage();

// All three uploads are queued and executed one at a time — no race conditions.
storage.putObject({ bucket: 'files', key: 'a.png', body: blobA });
storage.putObject({ bucket: 'files', key: 'b.png', body: blobB });
storage.putObject({ bucket: 'files', key: 'c.png', body: blobC });

// Or await them individually for ordered results.
const [resA, resB] = await Promise.all([
  storage.putObject({ bucket: 'files', key: 'a.png', body: blobA }),
  storage.putObject({ bucket: 'files', key: 'b.png', body: blobB }),
]);
console.log(resA.key, resB.key);
```

### External AWS SDK Init From Flare `/aws` Config

  bucket: 'media',
  key: 'uploads/clip.mp4',
import { connectApp } from '@zuzjs/flare';

const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

const aws = await app.getStorageServerAwsConfig('storage-server-id');

const s3 = new S3Client({
  endpoint: aws.endpoint,
  region: aws.region,
  forcePathStyle: Boolean(aws.forcePathStyle),
  credentials: {
    accessKeyId: aws.accessKeyId,
    secretAccessKey: aws.secretAccessKey,
  },
});

await s3.send(new PutObjectCommand({
  Bucket: aws.bucket,
  Key: `${aws.prefix ?? ''}manual/test.txt`,
  Body: 'hello from external sdk',
  ContentType: 'text/plain',
}));
```

### Template-Based Email APIs

### Security Rules Example (Boards Owner Or Team Member)

For a `boards` document shape like:

```json
{
  "uid": "ownerUid",
  "team": ["memberUid1", "memberUid2"]
}
```

Use this DSL to allow read for owner or team member, and allow write only for owner:

```txt
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner(ownerUid) {
      return auth != null && auth.uid == ownerUid;
    }

    function isTeamMember(teamUids) {
      return auth != null && auth.uid in teamUids;
    }

    match /boards/{boardId} {
      allow read: if isOwner(resourceData.uid) || isTeamMember(resourceData.team);
      allow create, update, delete: if isOwner(resourceData.uid);
    }
  }
}
```

Tip: if you set owner uid at create time, prefer checking `requestData.uid` on create and `resourceData.uid` on update/delete.

## Internal Collection Aliases

The client can use public collection names for server-managed collections.
The server maps these names to internal `_flare_*` collections automatically for reads, writes, queries, subscriptions, and rules-related lookups.

Prefer the public names in SDK code:

| Public name | Internal collection |
| --- | --- |
| `users` | `_flare_auth_users` |
| `sessions` | `_flare_auth_sessions` |
| `auth_fields` | `_flare_auth_fields` |
| `email_links` | `_flare_email_links` |
| `email_outbox` | `_flare_email_outbox` |
| `email_verifications` | `_flare_email_verifications` |
| `password_recoveries` | `_flare_password_recoveries` |
| `push_tokens` | `_flare_push_tokens` |
| `push_outbox` | `_flare_push_outbox` |
| `index_suggestions` | `_flare_index_suggestions` |

Example:

```ts
const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

const me = await app.collection('users').doc('alice').get();
const activeSessions = await app.collection('sessions').where({ uid: 'alice' }).get();
const pushTokens = await app.collection('push_tokens').where({ uid: 'alice' }).get();

console.log(me.data(), activeSessions.docs.length, pushTokens.docs.length);
```

Emails are sent only through app-level templates stored in `_flare_email_templates`.

Template placeholders use `{key}` syntax and are replaced from `values`.

If template has `includeVerificationLink: true`, server generates a link in `_flare_email_links` and injects:

- `{verificationLink}`
- `{verifyUrl}`
- `{verificationToken}`

```ts
const app = connectApp({ endpoint: 'https://flare.zuzcdn.net', appId: 'my-app', apiKey: 'ak' });

const sendRes = await app.sendEmail({
  to: 'alice@example.com',
  tag: 'team_invite',
  values: {
    displayName: 'Alice',
    inviterName: 'Bob',
    teamName: 'Product',
  },
});

console.log(sendRes.sent, sendRes.tag, sendRes.verifyUrl);

const verifyRes = await app.verifyEmailLink({
  token: '<token-from-link>',
  tag: 'team_invite',
  email: 'alice@example.com',
});

console.log(verifyRes.verified, verifyRes.tag);
```

## Template Collection Example

Example document in `_flare_email_templates`:

```json
{
  "tag": "team_invite",
  "enabled": true,
  "subject": "Hi {displayName}, you are invited to {teamName}",
  "text": "Hello {displayName},\n\n{inviterName} invited you.\n\nOpen: {verificationLink}",
  "html": "<p>Hello {displayName}</p><p>{inviterName} invited you.</p><p><a href=\"{verificationLink}\">Accept</a></p>",
  "includeVerificationLink": true,
  "verifyUrl": "https://app.example.com/accept?token=__TOKEN__&appId=__APP_ID__&tag=__TAG__",
  "verificationTtlHours": 72
}
```

## Links

- Server package: @zuzjs/flare-server
- Documentation: https://flare.zuz.com.pk

## License

MIT
