# Handover: two open problems

1. [Audio stops at a track boundary when the app is backgrounded](#open-bug-audio-stops-at-a-track-boundary-when-the-app-is-backgrounded)
2. [Third-party Audiobookshelf clients don't all work against the shim](#open-bug-third-party-clients-dont-all-work-against-the-shim)

---

# Open bug: audio stops at a track boundary when the app is backgrounded

Status: **unsolved**. Two attempts were made and both have been reverted; the
code is back to where it was before either. This is a record of the symptom,
the evidence, and what has already been ruled out, so the next attempt starts
from facts rather than from scratch.

## Symptom

A multi-file book (mp3, one file per ~1 hour) plays normally while the app is
open. With the app backgrounded or the screen locked, playback runs to the end
of the current file and then:

- iOS keeps showing the book as playing and the lock-screen clock keeps
  advancing, but there is no sound;
- opening the app starts the audio, from the beginning of the track it should
  already have been part-way through.

Single-file books (m4b) are unaffected — they have no boundary to cross.

## Evidence

Three logs are in the `crash_logs` table of the `pholia-accounts` D1 database.
Read one with:

```
cd ~/Claude_Code/pholia/pholia
CLOUDFLARE_ACCOUNT_ID=41a62277421a452c6499884fd17b3c8d npx wrangler d1 execute pholia-accounts \
  --remote --json --command "SELECT ts, app_version, audio_state, events_json FROM crash_logs ORDER BY ts DESC LIMIT 1"
```

| id (prefix) | when | build | what it shows |
|---|---|---|---|
| `5e345f60` | 2026-09-05 23:58 | `ffd511b` | boundary crossed with the service worker serving the bytes |
| `6a06c64f` | 2026-09-06 00:06 | `1a92613` | boundary crossed with iOS fetching natively |
| `06fa20c5` | 2026-09-06 00:24 | `1b6a3e5` | the single-stream attempt |

**Log 1 (worker-served).** At 23:57:44 the track ended and the next file was
assigned. The worker enqueued the whole 33.8 MB body in 64 ms
(`stream-done ... delivered 33822858 ms 64`). The element then sat at
`readyState 1` — `loadedmetadata` but no data — and logged `stalled` at
23:57:49. Nothing more happened until 23:58:11, when `canplay`, `playing` and
`canplaythrough` all fired within one millisecond of the app coming to the
foreground.

**Log 2 (natively served).** Same shape. The pin shows
`mode: "native", hidden: true`, so the worker passed the request through and
iOS fetched it itself. iOS issued its probe ranges (`bytes=0-1`,
`bytes=0-1445`), got `loadedmetadata` at 00:06:24.125, logged `stalled` at
00:06:27.3, and then did nothing for ten seconds until the app was
foregrounded at 00:06:37, at which point it requested the body with no Range
header and played.

The conclusion those two logs support: **a backgrounded iOS app cannot begin a
new media load.** It is not about who serves the bytes.

**Log 3 (single-stream attempt).** `src` is `stream`, `readyState` 4, and the
element reports 5196 seconds buffered — effectively the whole book. Despite
that it logs `stalled` at 00:22:14, 00:22:46 and 00:22:51, advances about one
second of playback between 00:22:51 and 00:24:53, and ends `paused: true`.
The user reports that in this build playback stopped as soon as the app was
backgrounded, rather than surviving to the boundary. Note the positions
(4603–4613 s) sit just before the end of what used to be part 1 (4622 s).

## What was tried

**Attempt 1 — load the next track natively when hidden.** `pinMediaMode` was
made to send `hidden` and `online`, and the worker's `modeFor` returned
`native` for a load starting while hidden, on the theory that a body
synthesised by the worker is a JS stream that WebKit will not pull from in the
background. Result: log 2. The load still stalled, so the theory was wrong or
incomplete. Reverted in `e53b7d4`.

**Attempt 2 — remove the boundaries.** A shim endpoint
(`GET /api/items/:id/stream`) laid a book's parts end to end and served byte
ranges across them, and Pholia played multi-part mp3 books through that single
URL so no second load would ever be needed. The endpoint itself was verified
against a real 13-part, 446 MB book: the length equalled the sum of the parts,
a range straddling the join returned bytes identical to the tail of one part
followed by the head of the next, and suffix ranges worked. Result: log 3, and
a worse symptom. Reverted in `2b2c053` (client) and shim commit `59982b1`.

Nothing else was changed in pursuit of this bug. Other work in the same
session (gestures, covers, search, duplicate handling) is unrelated and has
been left in place.

## Ruled out

- **The service worker is not the cause.** The boundary stalls identically
  when the worker is bypassed entirely (log 2).
- **The shim is not failing to serve.** Range responses were byte-verified,
  and in log 1 the whole body reached the element in 64 ms.
- **It is not a decode failure.** No `error` event appears in any log, and
  the same file plays immediately once the app is foregrounded.
- **Removing the boundaries is not sufficient on its own.** With one
  continuous resource and the whole book buffered, the element still stalled
  (log 3).

## Not yet tested

- Whether a *second* `<audio>` element, preloaded to `readyState 4` while the
  app is visible, can be swapped in and played at the boundary.
- Whether the stalls in log 3 came from the endpoint's streaming
  implementation (it read each part to completion inside a single `pull`
  rather than honouring backpressure) rather than from anything iOS did.
- Whether `MediaSource` / Managed Media Source behaves differently, since
  appending buffers to an existing element is not a new resource load.
- What the Media Session position state is doing while the audio is silent,
  and whether iOS is treating the session as still active.

## Where the code is

- `player.js` — `onTrackEnded()` assigns the next `src`; `loadTime()` maps a
  global position onto a track; `_logAudioEvent`/`_logSeekCall` write the ring
  buffer these logs come from.
- `app.js` — `pinMediaMode()` announces a load to the worker before `src` is
  assigned; `Offline` owns the chunk cache.
- `sw.js` — `modeFor()` decides worker vs native per file, `decideAudio()`
  applies it, `serveChunked()` streams cached chunks and bridges the rest.

## Constraints that must not be broken

- **A media load must be all-worker or all-native.** iOS cancels a resource
  whose CORS status changes between Range responses; mixing produced a
  170 ms re-request loop and dead playback (2026-09-03). This is why the mode
  is pinned per file at `MEDIA_LOAD`.
- **A 206 must cover the whole requested range**, never a truncated chunk.
- **Never `cache.put` a multi-hundred-MB response**; the iOS PWA working
  budget is around 50 MB, which is why audio is cached in 10 MB chunks.
- The chapter scrubber and the elapsed/remaining times read `chapters` and
  the global position, not the track layout — that behaviour should survive
  whatever replaces the current track handling.

## Reproducing

Play a multi-part mp3 book (for example Tidelands, 13 parts, item
`it-02ce70d4-959`), skip to within a minute of the end of a part, lock the
phone, and wait for the boundary. To capture a log, turn on the debug toggle
in Settings and use the send-log control after the failure.


---

# Open bug: third-party clients don't all work against the shim

Status: **not investigated**. Reported by the user, with no debugging done
yet. The worry is that the shim has drifted from what real Audiobookshelf
sends, and that Pholia — developed alongside the shim — has been papering over
it by being tolerant.

## What was reported

- Some clients will not log in at all.
- One of them says: **"Failed to decode server response: The data couldn't be
  read because it is missing."** That wording is Swift's `DecodingError`, and
  "missing" specifically means a key the client's struct declares as
  non-optional was absent or `null`.
- ShelfPlayer mostly works, but its **Authors tab** does not. Authors work in
  Pholia, so the data exists; something about the shape or the endpoint
  differs from what ShelfPlayer expects.

**First thing to ask the user**: exactly which apps, on which platform, and
what each one does — fails at the server URL, fails after entering
credentials, logs in but shows an empty library, and so on. The three symptoms
above may be three different clients or one client at three stages.

## What the shim currently returns

Checked 2026-09-06 against production. These are facts, not diagnoses.

`POST /login` and `POST /api/authorize` both return:

```
{ user: {...}, userDefaultLibraryId: null, serverSettings: {...},
  ereaderDevices: [], Source: "cloudflare-shim" }
```

**`userDefaultLibraryId` is hard-coded `null`** (`src/index.ts`, two places).
Real Audiobookshelf sends the user's default library id, a string. A client
that declares it non-optional would fail to decode the login response, and the
error it printed would look exactly like the one quoted above. This is a
cheap, specific thing to check first.

`GET /api/libraries/:id/authors` returns 16 authors shaped like:

```
{ id, asin: null, name, description: null, imagePath: null, libraryId,
  addedAt: 0, updatedAt: 0, numBooks, lastFirst }
```

`GET /api/authors/:id` returns the same fields minus `lastFirst`, and
**omits `libraryItems` unless `?include=items` is passed**
(`src/routes/authors.ts`). Whether ShelfPlayer asks for that include, or
expects the items unconditionally, is unknown.

Note `addedAt` and `updatedAt` are `0`, and `imagePath` is `null` for every
author. Author images are served as a placeholder PNG from
`/api/authors/:id/image`.

## How this kind of bug has been found before

The shim's `CLAUDE.md` has a section on strict-client compatibility that is
worth reading first; the lessons in it were all learned this way:

- Run `npx wrangler tail --format pretty` against the shim and watch what the
  client actually requests, in order, and where it stops.
- Read the client's own decoding structs. For a Swift client on GitHub:
  `gh api repos/<owner>/<repo>/contents/<path> --jq '.content' | base64 -d`.
- Diff those declarations against what `src/lib/abs-shapes.ts` emits.
- Captured real-ABS fixtures live under `.local/fixtures/` in the shim repo.

Known landmines already fixed, which show the shape of the problem: ShelfPlayer
needs `publishedYear` as a **string** even though it is an integer in the
database; `media.tracks` is required for playback; and `/api/*` must return a
JSON 404 rather than the SPA's HTML, or a strict client treats the HTML as a
malformed response and goes offline.
