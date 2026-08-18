---
name: zuzjs-flare-client
description: Build TypeScript and React applications with @zuzjs/flare, the ZuzFlare realtime database client. Use for configuration, document CRUD, fluent queries, realtime streams, authentication, storage, push notifications, and Next.js CSRF integration.
---

# ZuzFlare Client

`@zuzjs/flare` is the JavaScript/TypeScript client for ZuzFlare Server, a self-hosted realtime database. It provides document operations, fluent collection queries, WebSocket-backed subscriptions, authentication, S3-compatible storage, browser push, and optional React helpers.

## Install and initialize

```bash
npm install @zuzjs/flare
```

Create the client once per browser application and reuse the result:

```ts
import { connectApp } from '@zuzjs/flare';

export const flare = connectApp({
  endpoint: 'https://flare.example.com',
  appId: 'my-app',
  apiKey: 'optional-public-api-key',
});
```

`connectApp()` returns a singleton for a given configuration and opens realtime connectivity outside Next.js server runtimes. Calling it with a materially different configuration disconnects and replaces the existing singleton. Use `getFlare()` to read the current instance and `disconnectFlare()` for deliberate teardown.

```ts
import { connectApp, getFlare, disconnectFlare } from '@zuzjs/flare';

const app = connectApp({ endpoint, appId, apiKey });
console.log(getFlare() === app); // true in normal browser/Node runtimes

disconnectFlare();
```

### Configuration

```ts
const app = connectApp({
  endpoint: 'https://flare.example.com', // required HTTP API base
  appId: 'my-app',                       // required application identifier
  apiKey: 'key',                         // optional application key
  grpcUrl: '127.0.0.1:5051',             // optional Node gRPC endpoint
  transport: 'auto',                     // 'auto' | 'ws' | 'http' | 'grpc'
  wsPath: '/',                           // optional WebSocket path
  httpBase: '/api/flare',                // optional auth proxy base
  authBootstrapMode: 'refresh',          // 'refresh' (default) | 'none'
  autoReconnect: true,
  reconnectDelay: 1_000,
  maxReconnectDelay: 15_000,
  debug: false,
  pushNotifications: false,
  dataMapper: {
    users: (row) => ({ ...row, displayName: String(row.name ?? '') }),
  },
  storage: {
    bucket: 'my-app-storage',
    prefix: 'uploads',
    transferManager: { uploadConcurrency: 2, downloadConcurrency: 2 },
  },
});
```

Use `dataMapper` to shape inbound rows by base collection name or join alias. Storage transfer queues default to one concurrent upload and one concurrent download.

## Documents and collections

Use a typed collection reference and a document reference for direct CRUD:

```ts
type User = {
  id: string;
  name: string;
  email: string;
  score?: number;
  createdAt?: unknown;
};

const users = app.collection<User>('users');

await users.doc('alice').set({
  id: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
});

await users.doc('alice').update({ name: 'Alice Smith' });
const user = await users.doc('alice').get();
await users.doc('alice').delete();
```

- `set()` replaces the document.
- `update()` merges fields into the document.
- `setAndGet()` and `updateAndGet()` write, then re-read server-generated values.
- Direct document subscriptions return an unsubscribe function; always call it during cleanup.

```ts
const stop = users.doc('alice').onDocChanged((next, id, operation) => {
  console.log({ next, id, operation });
});

// Later
stop();
```

For generated IDs, use collection writes:

```ts
const created = await users.add({ name: 'New user', email: 'new@example.com' });
console.log(created.id);
```

For high-volume writes, prefer bounded bulk helpers. They accept arrays or async iterables and support `batchSize`, `concurrency`, `onProgress`, and `continueOnError`.

```ts
await users.addMany(rows(), { batchSize: 1_000, concurrency: 4 });
await users.updateMany([{ id: 'alice', data: { score: 10 } }]);
await users.deleteMany(['alice', 'bob']);
```

## Query data

Collection references are immutable fluent queries. Build the query, then call `get()`, subscribe, or `await` it directly.

```ts
const activeAdmins = await app
  .collection<User>('users')
  .where({ active: true, age: '>= 18' })
  .and({ role: 'admin' })
  .orderBy('name', 'asc')
  .limit(50)
  .get();
```

Supported common filters include:

```ts
const query = app.collection('posts')
  .where({ status: 'published' })
  .or({ authorId: 'owner-1' })
  .in('category', ['news', 'release'])
  .arrayContains('tags', 'typescript')
  .some('comments', { approved: true })
  .like('title', '%flare%')
  .exists('publishedAt')
  .orderBy('_seq', 'desc')
  .startAfter(cursor)
  .limit(25)
  .offset(0);
```

The object form of `where()` treats strings prefixed with `>=`, `<=`, `!=`, `>`, `<`, or `==` as operators. Arrays imply `in`. Use explicit fluent methods for more complex operations and logical combinations.

For newest-first feeds, use `.latest()`. For stable manual pagination, order by a stable field, retain the last row’s cursor, then use `.startAfter(cursor)` for the next page.

## Realtime subscriptions and streams

Use `onSnapshot()` for raw realtime events:

```ts
const stop = app.collection<User>('users').where({ active: true }).onSnapshot((event) => {
  console.log(event);
});

// Component/service cleanup
stop();
```

Use `stream()` for a maintained, batched list—especially chat, activity, or rapidly changing UI lists. It collapses bursts rather than triggering work for every incoming change.

```ts
const stream = app
  .collection<{ id: string; roomId: string; text: string }>('messages')
  .where({ roomId: 'room-1' })
  .latest()
  .limit(200)
  .stream({
    flushMs: 24,
    maxBatchSize: 200,
    insertAt: 'start',
    maxDocs: 200,
  });

const stop = stream.subscribe((rows, meta) => {
  console.log(rows, meta.ready, meta.reason);
});

stream.onError(console.error);
stream.onPermissionDenied(console.error);

// Always release both subscription and stream resources.
stop();
stream.close();
```

For `useSyncExternalStore`, use `.asStore()` and pass `subscribe`, `getSnapshot`, and `getServerSnapshot` directly. Recreate and close streams when query inputs change.

## Server timestamps, counters, vectors, and time helpers

Use sentinels when the server must perform the operation:

```ts
import {
  ServerTimeStamp,
  ServerTimeStampField,
  increment,
  vector,
} from '@zuzjs/flare';

await app.collection('posts').doc('post-1').update({
  updatedAt: ServerTimeStamp,
  createdAt: ServerTimeStampField,
  viewCount: increment(1),
  embedding: vector('Article body'),
});
```

`increment(-1)` decrements. `vector()` accepts text or `{ contentBase64, mime? }`, with optional `'text'` or `'image'` mode.

Normalize timestamps returned in several formats with `toDate()`, `getDocumentTimestamp()`, `formatLocalDateTime()`, `diffMs()`, and `timeAgo()`.

## Authentication

The client exposes email/password, token, OAuth, verification, recovery, and auth-state APIs.

```ts
await app.ensureCsrfProtection(); // Browser SPA before cookie-protected mutations

await app.createUserWithEmail('alice@example.com', 'StrongPassword123!');
await app.signInWithEmail('alice@example.com', 'StrongPassword123!');

const stopAuth = app.onAuthStateChanged((session) => {
  console.log(session?.uid ?? 'signed out');
});

await app.refreshAuthSession();
await app.signOut();
stopAuth();
```

Aliases such as `createUserWithEmailAndPassword`, `signInWithEmailAndPassword`, and legacy `onAuthStateChange` are available. Use `getCurrentUser()` to read the current user and `loadAuthConfig()` / `onAuthConfigLoaded()` for provider configuration.

OAuth helpers initiate redirects in browser contexts:

```ts
await app.signInWithGoogle();
// After returning from the provider redirect:
const result = await app.handleSignInRedirect();
```

Email verification and recovery:

```ts
await app.sendEmailVerification('alice@example.com');
await app.verifyEmailWithCode('alice@example.com', '123456');

await app.sendAccountRecovery('alice@example.com');
await app.recoverAccountWithCode('alice@example.com', '123456', 'NewPassword123!');
```

## Next.js and CSRF

In a browser-only SPA, explicitly call `ensureCsrfProtection()` before cookie-protected auth mutations. The client does not fetch CSRF automatically at construction.

For Next.js SSR, route auth traffic through `httpBase` when appropriate and use the exported CSRF proxy helpers. Import these from the package root, not an undocumented deep path.

```ts
// app/api/flare/csrf/route.ts
import { createCsrfProxy } from '@zuzjs/flare';

export const GET = createCsrfProxy({
  endpoint: process.env.FLARE_ENDPOINT!,
  appId: process.env.NEXT_PUBLIC_FLARE_APP_ID!,
  apiKey: process.env.FLARE_API_KEY,
});
```

On the server, obtain the token with `extractCsrfFromRequest()` and forward it using `buildFlareHeaders()`. `connectApp()` creates isolated clients in Next.js server/middleware runtimes to avoid leaking mutable auth state between requests.

## Storage

Call `app.storage()` for S3-compatible object storage. Use bucket **names**, not internal server IDs. `putObject()` creates a missing bucket automatically.

```ts
const storage = app.storage();

const result = await storage.putObject({
  bucket: 'attachments',
  key: `users/alice/avatar.png`,
  body: file,
  contentType: 'image/png',
  access: 'public',
  onProgress: ({ percent }) => console.log(`${percent}%`),
});

const listing = await storage.listObjects({ bucket: 'attachments', prefix: 'users/alice/' });
const object = await storage.getObject({ bucket: 'attachments', key: 'users/alice/avatar.png' });
await storage.deleteObject({ bucket: 'attachments', key: 'users/alice/avatar.png' });
```

Keep folders in `key`; bucket names cannot contain `/`. For files larger than the base64 upload limit (4 MiB), use the normal signed upload path via `putObject()` rather than manually constructing base64 payloads.

For React queue management, install the optional peer dependency and import from the React subpath:

```ts
import { useStorage, Status } from '@zuzjs/flare/react';
```

`useStorage(...).addToQueue()` starts automatically unless `autoStartOnAdd: false`. `pause()` prevents scheduling further transfers but does not cancel an already running request.

## Push notifications

Browser push requires a supported browser, a service worker, permission, and a configured server-side push provider.

```ts
await app.setupPushServiceWorker();
await app.requestPushPermission();

const { token } = await app.acquireBrowserPushToken();
await app.registerPushToken({ token, platform: 'web', topics: ['news'] });

await app.sendPushNotification({
  title: 'Update available',
  body: 'Your report is ready.',
  topic: 'news',
});
```

Setting `pushNotifications: true` enables automatic browser registration after auth state changes. Use it only where automatic permission/registration behavior is desired.

## React live queries

The optional React entrypoint is `@zuzjs/flare/react` and declares React as an optional peer dependency.

```tsx
import { useEffect, useMemo, useState } from 'react';
import { connectApp } from '@zuzjs/flare';

const app = connectApp({ endpoint, appId, apiKey });

export function Messages({ roomId }: { roomId: string }) {
  const [rows, setRows] = useState<readonly { id: string; text: string }[]>([]);

  const stream = useMemo(
    () => app.collection<{ id: string; text: string }>('messages')
      .where({ roomId })
      .latest()
      .limit(100)
      .stream({ flushMs: 20, maxBatchSize: 100, insertAt: 'start', maxDocs: 100 }),
    [roomId],
  );

  useEffect(() => {
    const stop = stream.subscribe((next) => setRows(next));
    return () => { stop(); stream.close(); };
  }, [stream]);

  return <>{rows.map((row) => <p key={row.id}>{row.text}</p>)}</>;
}
```

The `useLiveQuery` hook is also available from `@zuzjs/flare/react`; it can build and manage a collection stream with retry behavior for transient first-emission races.

## Development and maintenance

- Runtime requirement: Node.js `>=18.17.0`.
- Build: `npm run build`.
- Test suite: `npm test`.
- Real-server auth test: `npm run test:real` (requires `RUN_REAL_FLARE_TESTS=1` and an available server setup).
- The package ships ESM and CommonJS builds plus the `@zuzjs/flare/react` subpath.
- When changing a public SDK API, update `README.md` and include a usage example in the same change.

Avoid relying on private source paths such as `src/Client/*` or `src/Query/*`; consume the root exports or the documented `@zuzjs/flare/react` subpath.
