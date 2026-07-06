# Commentary Real-Time Flow

How the live commentary feed works — from browser to database and back.

---

## Architecture Overview

```
Browser (commentary.html)
  │
  ├── GET  /matches/:matchId/commentary  ──▶  Express  ──▶  PostgreSQL (load history)
  ├── POST /matches/:matchId/commentary  ──▶  Express  ──▶  PostgreSQL (insert)
  │                                               │
  │                                               └──▶  WebSocket broadcast
  │
  └── WebSocket ws://host/ws  ◀────────────────────────  server push (real-time)
```

There are three flows that all work together:

| Flow | Trigger | Purpose |
|------|---------|---------|
| **GET** | Page load / Refresh button | Hydrate feed from DB |
| **POST** | Form submit | Create a new commentary entry |
| **WebSocket** | Always-on | Push new entries to every subscribed browser in real time |

---

## Flow 1 — GET (load history on page open)

When the page loads, it immediately fetches all existing commentary for the match from the database and renders it in the feed.

### Client
```js
// commentary.html — runs on DOMContentLoaded
async function loadFeed() {
  const res = await fetch(`/matches/${matchId}/commentary`);
  const { data } = await res.json();   // newest-first (desc createdAt)
  feed.innerHTML = data.map(renderEntry).join('');
}
```

### Server route — `src/routes/commentary.ts`
```ts
commentaryRouter.get('/', async (req, res) => {
  const { id: matchId } = matchIdParamSchema.parse({ id: req.params.matchId });
  const limit = Math.min(query.limit ?? 100, 100);

  const rows = await db
    .select()
    .from(commentary)
    .where(eq(commentary.matchId, matchId))
    .orderBy(desc(commentary.createdAt))   // newest first
    .limit(limit);

  res.json({ data: rows });
});
```

### Validation — `src/validation/commentary.js`
```js
export const listCommentaryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});
```

**Response shape**
```json
{
  "data": [
    {
      "id": 6,
      "matchId": 1,
      "minute": 67,
      "sequence": 12,
      "period": "2nd Half",
      "eventType": "goal",
      "actor": "Lionel Messi",
      "team": "Inter Miami",
      "message": "GOAL! Messi curls a stunning free kick into the top corner.",
      "metadata": { "xG": 0.08, "score": { "home": 2, "away": 1 } },
      "tags": ["goal", "free-kick", "highlight"],
      "createdAt": "2026-07-05T05:41:26.918Z"
    }
  ]
}
```

---

## Flow 2 — POST (create commentary)

The form collects all required fields, validates them client-side (basic HTML5) then sends a JSON body to the REST API. The server validates with Zod, inserts into the database, and **broadcasts the saved record to all WebSocket subscribers** of that match before returning the 201 response.

### Client
```js
// commentary.html — form submit handler
const body = {
  minutes:   parseInt(minutesInput.value, 10),
  sequence:  parseInt(sequenceInput.value, 10),
  period:    periodInput.value,
  eventType: eventTypeSelect.value,
  actor:     actorInput.value,
  team:      teamInput.value,
  message:   messageInput.value,
  metadata:  JSON.parse(metadataInput.value || '{}'),
  tags:      tagsInput.value.split(',').map(t => t.trim()).filter(Boolean),
};

await fetch(`/matches/${matchId}/commentary`, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify(body),
});
// The new entry will appear via WebSocket — no manual DOM update needed here
```

### Server route — `src/routes/commentary.ts`
```ts
commentaryRouter.post('/', async (req, res) => {
  // 1. Validate params
  const { id: matchId } = matchIdParamSchema.parse({ id: req.params.matchId });

  // 2. Validate body with Zod
  const parsed = createCommentarySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed.', details: parsed.error.flatten() });
  }

  const { minutes, ...rest } = parsed.data;  // `minutes` → `minute` column rename

  // 3. Insert into DB
  const [entry] = await db
    .insert(commentary)
    .values({ ...rest, minute: minutes, matchId })
    .returning();

  // 4. Broadcast to all WS subscribers of this match
  res.app.locals.broadCastCommentary(entry.matchId, entry);

  res.status(201).json({ data: entry });
});
```

### Validation — `src/validation/commentary.js`
```js
export const createCommentarySchema = z.object({
  minutes:   z.number().int().nonnegative(),
  sequence:  z.number().int().nonnegative(),
  period:    z.string().min(1),
  eventType: z.enum(['goal','assist','yellow_card','red_card',
                     'substitution','foul','offside','corner','penalty','other']),
  actor:     z.string().min(1),
  team:      z.string().min(1),
  message:   z.string().min(1),
  metadata:  z.record(z.string(), z.unknown()),
  tags:      z.array(z.string()),
});
```

**Error response** (400)
```json
{
  "error": "Validation failed.",
  "details": {
    "fieldErrors": {
      "eventType": ["Invalid enum value. Expected 'goal' | 'assist' | ..."]
    },
    "formErrors": []
  }
}
```

---

## Flow 3 — WebSocket (real-time push)

The browser opens a persistent WebSocket connection on page load and subscribes to the match channel. When any client POSTs a commentary event, the server broadcasts it to every subscriber — all connected browsers update simultaneously without polling.

### Connection lifecycle

```
Browser                             Server (ws/server.ts)
  │                                       │
  │──── WS connect: ws://host/ws ────────▶│
  │◀─── {"type":"welcome"} ───────────────│
  │                                       │
  │──── {"type":"subscribe","matchId":1} ▶│  registers socket in matchSubscribers Map
  │◀─── {"type":"subscribed","matchId":1}─│
  │                                       │
  │  [another browser POSTs commentary]   │
  │                                       │──▶ broadCastCommentary(matchId, entry)
  │◀─── {"type":"commentary","data":{…}} ─│  sends to all sockets in Set for matchId
  │                                       │
  │  [browser closes / navigates away]   │
  │──── WS close ────────────────────────▶│  cleanupSubscriptions removes socket from all Sets
```

### Client — subscribe
```js
// commentary.html
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    // matchId must be an integer — server uses Number.isInteger()
    ws.send(JSON.stringify({ type: 'subscribe', matchId: parseInt(matchId, 10) }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'commentary' && String(msg.data?.matchId) === matchId) {
      prependEntryToFeed(msg.data);   // instant DOM update, no fetch needed
    }
  });

  // Exponential backoff reconnect — 1s → 2s → 4s … → 30s max
  ws.addEventListener('close', () => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    setTimeout(connectWs, reconnectDelay);
  });
}
```

### Server — subscriber map — `src/ws/server.ts`
```ts
// One Map: matchId → Set of open WebSocket connections
const matchSubscribers = new Map<number, Set<WebSocket>>();

function subscribe(matchId: number, socket: WebSocket) {
  if (!matchSubscribers.has(matchId)) matchSubscribers.set(matchId, new Set());
  matchSubscribers.get(matchId)!.add(socket);
}

// Called by POST route after successful DB insert
function broadcastToMatch(matchId: number, payload: object) {
  const subscribers = matchSubscribers.get(matchId);
  if (!subscribers) return;
  const message = JSON.stringify(payload);
  for (const client of subscribers) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

// Exposed to Express via app.locals
function broadCastCommentary(matchId: number, comment: object) {
  broadcastToMatch(matchId, { type: 'commentary', data: comment });
}
```

### WebSocket message types

| Direction | Message | Description |
|-----------|---------|-------------|
| Client → Server | `{"type":"subscribe","matchId":1}` | Subscribe to match events |
| Client → Server | `{"type":"unsubscribe","matchId":1}` | Unsubscribe |
| Server → Client | `{"type":"welcome"}` | Sent on connection open |
| Server → Client | `{"type":"subscribed","matchId":1}` | Subscription confirmed |
| Server → Client | `{"type":"commentary","data":{…}}` | New commentary entry broadcast |
| Server → Client | `{"type":"error","message":"…"}` | Malformed JSON or unknown message |

---

## Database Schema — `src/db/schema.ts`

```ts
export const commentary = pgTable('commentary', {
  id:        serial('id').primaryKey(),
  matchId:   integer('match_id').references(() => matches.id).notNull(),
  minute:    integer('minute'),
  sequence:  integer('sequence').notNull(),
  period:    text('period'),
  eventType: text('event_type').notNull(),
  actor:     text('actor'),
  team:      text('team'),
  message:   text('message').notNull(),
  metadata:  jsonb('metadata'),
  tags:      text('tags').array(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

> **Note:** The Zod schema field is `minutes` (plural) while the DB column is `minute` (singular). The route destructures `{ minutes, ...rest }` and maps it as `{ minute: minutes }` on insert.

---

---

## React Implementation (RTK Query)

RTK Query handles the GET and POST flows (caching, loading/error states, refetch). The WebSocket hook writes new entries **directly into the RTK Query cache** via `updateQueryData` — so the feed stays in one source of truth and there is no separate `useState` for the list.

### Recommended file structure

```
src/
  store/
    store.ts              # Redux store
    commentaryApi.ts      # RTK Query API slice
  hooks/
    useCommentarySocket.ts # WS hook — injects into RTK cache
  components/
    CommentaryEntry.tsx
    CommentaryForm.tsx
  pages/
    CommentaryPage.tsx
  types/
    commentary.ts
  main.tsx
```

### Install dependencies

```bash
npm install @reduxjs/toolkit react-redux
```

---

### 1. Types — `src/types/commentary.ts`

```ts
export interface Commentary {
  id:        number;
  matchId:   number;
  minute:    number | null;
  sequence:  number;
  period:    string | null;
  eventType: string;
  actor:     string | null;
  team:      string | null;
  message:   string;
  metadata:  Record<string, unknown> | null;
  tags:      string[] | null;
  createdAt: string;
}

export interface CreateCommentaryBody {
  minutes:   number;
  sequence:  number;
  period:    string;
  eventType: string;
  actor:     string;
  team:      string;
  message:   string;
  metadata:  Record<string, unknown>;
  tags:      string[];
}
```

---

### 2. RTK Query API slice — `src/store/commentaryApi.ts`

Defines both endpoints. `transformResponse` unwraps the `{ data: [...] }` envelope so components receive the array directly.

```ts
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Commentary, CreateCommentaryBody } from '../types/commentary';

export const commentaryApi = createApi({
  reducerPath: 'commentaryApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/matches' }),
  endpoints: (builder) => ({

    // GET /matches/:matchId/commentary
    getCommentary: builder.query<Commentary[], string>({
      query: (matchId) => `/${matchId}/commentary`,
      transformResponse: (res: { data: Commentary[] }) => res.data,
    }),

    // POST /matches/:matchId/commentary
    createCommentary: builder.mutation<
      Commentary,
      { matchId: string } & CreateCommentaryBody
    >({
      query: ({ matchId, ...body }) => ({
        url:    `/${matchId}/commentary`,
        method: 'POST',
        body,
      }),
      transformResponse: (res: { data: Commentary }) => res.data,
    }),

  }),
});

export const {
  useGetCommentaryQuery,
  useCreateCommentaryMutation,
} = commentaryApi;
```

---

### 3. Redux store — `src/store/store.ts`

```ts
import { configureStore } from '@reduxjs/toolkit';
import { commentaryApi } from './commentaryApi';

export const store = configureStore({
  reducer: {
    [commentaryApi.reducerPath]: commentaryApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(commentaryApi.middleware),
});

export type AppDispatch = typeof store.dispatch;
```

Wrap your app with the `Provider` in `main.tsx`:

```tsx
// src/main.tsx
import { Provider } from 'react-redux';
import { store } from './store/store';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <App />
  </Provider>
);
```

---

### 4. WebSocket hook — `src/hooks/useCommentarySocket.ts`

Connects, subscribes, and on every incoming `commentary` message **patches the RTK Query cache** for the matching query key. Components re-render automatically because they are reading from that same cache.

The `cancelled` flag stops the reconnect loop after the component unmounts.

```ts
import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import type { AppDispatch } from '../store/store';
import { commentaryApi } from '../store/commentaryApi';
import type { Commentary } from '../types/commentary';

export function useCommentarySocket(matchId: string) {
  const dispatch = useDispatch<AppDispatch>();

  useEffect(() => {
    let ws: WebSocket;
    let reconnectDelay = 1000;
    let cancelled = false;

    function connect() {
      if (cancelled) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);

      ws.addEventListener('open', () => {
        reconnectDelay = 1000;
        // matchId must be a number — server checks Number.isInteger()
        ws.send(JSON.stringify({ type: 'subscribe', matchId: Number(matchId) }));
      });

      ws.addEventListener('message', (event) => {
        let msg: { type: string; data?: Commentary };
        try { msg = JSON.parse(event.data as string); } catch { return; }

        if (msg.type === 'commentary' && String(msg.data?.matchId) === matchId) {
          // Prepend the new entry into the cached query result — no extra fetch needed
          dispatch(
            commentaryApi.util.updateQueryData('getCommentary', matchId, (draft) => {
              draft.unshift(msg.data!);
            })
          );
        }
      });

      ws.addEventListener('close', () => {
        if (cancelled) return;
        setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      });

      ws.addEventListener('error', () => ws.close());
    }

    connect();

    // Cleanup: stop reconnect loop and close socket on unmount
    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [matchId, dispatch]); // re-runs only if matchId changes
}
```

---

### 5. CommentaryEntry component — `src/components/CommentaryEntry.tsx`

```tsx
import type { Commentary } from '../types/commentary';

const EVENT_ICONS: Record<string, string> = {
  goal: '⚽', assist: '🅰️', yellow_card: '🟨', red_card: '🟥',
  substitution: '🔄', foul: '⚠️', offside: '🚩', corner: '🚩',
  penalty: '🎯', other: '📋',
};

export function CommentaryEntry({ entry }: { entry: Commentary }) {
  const { eventType, minute, period, actor, team, message, metadata, tags } = entry;
  const meta = (metadata ?? {}) as Record<string, any>;
  const score = meta.score ? `${meta.score.home}–${meta.score.away}` : null;

  return (
    <div className={`entry ${eventType}`}>
      <div className="minute-col">
        <span>{EVENT_ICONS[eventType] ?? '📋'}</span>
        <span>{minute ?? 0}'</span>
      </div>
      <div className="entry-content">
        <div className="entry-header">
          <strong>{actor}</strong>
          <span>{team}</span>
          <span className="period-chip">{period}</span>
        </div>
        <p>{message}</p>
        {score && <span className="score-pill">🏆 {score}</span>}
        {meta.assistBy && <span>Assist: {meta.assistBy}</span>}
        <div className="tags">
          {(tags ?? []).map((t) => <span key={t} className={`tag ${t}`}>{t}</span>)}
        </div>
      </div>
    </div>
  );
}
```

---

### 6. CommentaryForm component — `src/components/CommentaryForm.tsx`

`unwrap()` converts the RTK mutation promise into a real promise that throws on failure, enabling a standard try-catch block.

```tsx
import { useState } from 'react';
import { useCreateCommentaryMutation } from '../store/commentaryApi';

const EVENT_TYPES = [
  'goal','assist','yellow_card','red_card','substitution',
  'foul','offside','corner','penalty','other',
] as const;

const EMPTY = {
  minutes:'', sequence:'', period:'', eventType:'',
  actor:'', team:'', message:'', metadata:'', tags:'',
};

export function CommentaryForm({ matchId }: { matchId: string }) {
  const [form, setForm]     = useState(EMPTY);
  const [toast, setToast]   = useState<{ type: 'success'|'error'; msg: string } | null>(null);
  const [createCommentary, { isLoading }] = useCreateCommentaryMutation();

  function field(key: keyof typeof EMPTY) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setToast(null);

    // Validate metadata JSON before sending
    let metadata: Record<string, unknown> = {};
    if (form.metadata.trim()) {
      try {
        metadata = JSON.parse(form.metadata);
      } catch {
        return setToast({ type: 'error', msg: 'Metadata is not valid JSON.' });
      }
    }

    try {
      // unwrap() throws if the server returns a non-2xx response
      await createCommentary({
        matchId,
        minutes:   parseInt(form.minutes,  10),
        sequence:  parseInt(form.sequence, 10),
        period:    form.period,
        eventType: form.eventType,
        actor:     form.actor,
        team:      form.team,
        message:   form.message,
        metadata,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      }).unwrap();

      setForm(EMPTY);
      setToast({ type: 'success', msg: 'Commentary posted! 🎉' });
      // No need to manually update the feed — WS will deliver it and patch the cache
    } catch (err: any) {
      // RTK Query wraps server errors: err.data contains the Express JSON body
      const fieldErrors = err?.data?.details?.fieldErrors ?? {};
      const firstError  = (Object.values(fieldErrors)[0] as string[])?.[0];
      setToast({ type: 'error', msg: firstError ?? err?.data?.error ?? 'Failed to post.' });
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="field-row">
        <label>Minute<input type="number" min={0} value={form.minutes}  onChange={field('minutes')}  required /></label>
        <label>Sequence<input type="number" min={0} value={form.sequence} onChange={field('sequence')} required /></label>
      </div>

      <div className="field-row">
        <label>Period<input value={form.period} onChange={field('period')} placeholder="1st Half" required /></label>
        <label>Event Type
          <select value={form.eventType} onChange={field('eventType')} required>
            <option value="">— select —</option>
            {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>

      <div className="field-row">
        <label>Actor<input value={form.actor} onChange={field('actor')} placeholder="Messi" required /></label>
        <label>Team<input value={form.team}  onChange={field('team')}  placeholder="Inter Miami" required /></label>
      </div>

      <label>Message<textarea value={form.message} onChange={field('message')} required /></label>
      <label>Tags (comma-separated)<input value={form.tags} onChange={field('tags')} placeholder="goal, highlight" /></label>
      <label>Metadata (JSON)<textarea value={form.metadata} onChange={field('metadata')} placeholder='{"xG": 0.08}' /></label>

      <button type="submit" disabled={isLoading}>
        {isLoading ? 'Posting…' : '+ Post Commentary'}
      </button>

      {toast && <p className={`toast ${toast.type}`}>{toast.msg}</p>}
    </form>
  );
}
```

---

### 7. CommentaryPage — `src/pages/CommentaryPage.tsx`

The page component is thin. RTK Query owns the data; the WS hook owns the socket.

```tsx
import { useGetCommentaryQuery } from '../store/commentaryApi';
import { useCommentarySocket }   from '../hooks/useCommentarySocket';
import { CommentaryForm }        from '../components/CommentaryForm';
import { CommentaryEntry }       from '../components/CommentaryEntry';

export function CommentaryPage({ matchId }: { matchId: string }) {
  // 1. Fetch history from DB on mount; cached for subsequent renders
  const {
    data: entries = [],
    isLoading,
    isError,
    refetch,
  } = useGetCommentaryQuery(matchId);

  // 2. Open WS, subscribe, and patch the same cache on new events
  useCommentarySocket(matchId);

  return (
    <div className="layout">
      <aside className="form-panel">
        <CommentaryForm matchId={matchId} />
      </aside>

      <section className="feed-panel">
        <button onClick={refetch}>↻ Refresh</button>

        {isLoading && <p>Loading commentary…</p>}
        {isError   && <p>Failed to load. <button onClick={refetch}>Retry</button></p>}

        {entries.map((entry) => (
          <CommentaryEntry key={entry.id} entry={entry} />
        ))}

        {!isLoading && !isError && entries.length === 0 && (
          <p>No commentary yet. Post the first event!</p>
        )}
      </section>
    </div>
  );
}
```

---

### Data flow with RTK Query

```
CommentaryPage mounts
  │
  ├── useGetCommentaryQuery(matchId)
  │     └── GET /matches/:matchId/commentary ──▶ DB
  │           └── stores result in RTK cache
  │
  └── useCommentarySocket(matchId)
        └── WS connect → subscribe
              │
              │  [POST from any client]
              │
              ▼
        ws.message { type:"commentary", data:{…} }
              │
              └── dispatch(updateQueryData('getCommentary', matchId, draft => draft.unshift(entry)))
                    └── RTK cache updated → CommentaryPage re-renders automatically
```

**Why `updateQueryData` instead of a separate `useState`:**
- The feed always stays in sync with the RTK cache — `refetch()` replaces the same cache key
- No risk of duplicates from a race between POST response and WS push
- Components re-render automatically, no manual state management

---

## UI Routes

| URL | Description |
|-----|-------------|
| `GET /hello/ui` | The commentary UI (served from `src/public/commentary.html`) |
| `GET /hello/ui?matchId=2` | Commentary UI for match 2 |

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/matches/:matchId/commentary` | List commentary (newest first, max 100) |
| `POST` | `/matches/:matchId/commentary` | Create a commentary entry |
| `WS`   | `ws://host/ws` | WebSocket endpoint |
