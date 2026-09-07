# Handover: three problems, and where each one got to

1. [Audio stops at a track boundary when the app is backgrounded](#fixed-audio-stops-at-a-track-boundary-when-the-app-is-backgrounded) — **fixed 2026-09-06**
2. [Third-party Audiobookshelf clients don't all work against the shim](#open-bug-third-party-clients-dont-all-work-against-the-shim) — two of four fixed
3. [Real author images and biographies](#done-real-author-images-and-biographies) — **done 2026-09-06**

---

# Fixed: audio stops at a track boundary when the app is backgrounded

Status: **fixed** in Pholia commit `4417b7d` (2026-09-06), verified on the
device twice — once with the next part uncached (iOS loaded it itself), once
with every part downloaded (the worker served it). In both, the new part
was `playing` within half a second of the old one ending, screen locked.

## What it actually was

The evidence below was read the wrong way round. Two things it did not show:

1. **No boundary load had ever been pinned.** `pinMediaMode` gave the worker
   500 ms to say how it would serve the file and assigned `src` anyway. The
   worker took about a second to answer at every load (a restarted worker
   re-enumerated the whole audio cache first), so every load began unpinned
   and the first Range went out under the fallback rule. Log 2's "native"
   boundary was therefore a worker/native **mix** — its first `bytes=0-1`
   was answered from the cache — which is the re-request loop from
   2026-09-03, not evidence that iOS refuses background loads.
2. **"Native" was not native.** Right after a restart the worker answered
   every audio request with `respondWith(fetch(request))`, which pumps the
   bytes through the worker process even when it had decided not to serve
   the file. Log 2 never bypassed the worker.

So a cold worker being woken *at* the boundary, with the app already quiet,
was what iOS would not carry through. The fix in `4417b7d`:

- the page **waits** for the pin (8 s cap, logged as `pin-wait`) instead of
  timing out at 500 ms, and the worker answers from its existing key map
  (`ensureKeys`) rather than re-enumerating the cache;
- `maybePrewarmNextTrack` **pins the next part 30 s before the boundary**,
  while the app is certainly awake, so `onTrackEnded` assigns `src` at once
  — this is the decisive change, and it is why the worker-served case works
  too;
- a worker with no key map yet **steps aside** for online audio (and pins
  the file native until the page's next announcement) instead of proxying
  it; offline keeps the old wait-for-cache path;
- `sw.js` carries the deploy hash (`SW_BUILD`, stamped by `deploy.yml`),
  shown under the page hash in the tab bar and recorded in every crash log's
  `audio_state.sw`, and a heartbeat runs while the page is hidden.

The two earlier attempts are still reverted and should stay that way.

## Original record (kept for the evidence)

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

## Be sure what you are testing (read before trusting any result above)

The user observed on 2026-09-06 that after the revert had deployed, the app
**still** showed the failure, and only stopped after force-quitting it twice.
A service worker update needs the app closed and reopened to take effect, and
the page and the worker update independently — so for a while you are running
new page code against an old worker, or the reverse.

This matters for the evidence above:

- Log 2 is trustworthy on this point: it contains a `pin` line with the
  `hidden` field, which only the new worker emits.
- **Log 3 is not.** The `src: "stream"` line proves the new page code was
  running, but nothing in it identifies which worker answered, so "the single
  stream made it worse" is not a safe conclusion. It may have been a stale
  worker, or a mix.

Ways to get a clean state before a test:

- Load the app with `?purge` in the URL. `index.html` has an escape hatch that
  deletes every cache, unregisters every service worker, and reloads clean.
- Otherwise force-quit and reopen **twice**, and confirm the build hash shown
  in Settings matches what was deployed.
- The crash log records `app_version`, which is the **page** build only.
  Adding the worker's own version to that payload would remove this ambiguity
  entirely, and is probably worth doing before the next round of testing.

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

## Update 2026-09-07: a pause under 5 s was the one case with no seek

"Works one day, not the next" turned out to be the pause length, not iOS.
`_autoRewindSeconds()` returns 0 under 5 s (a fumbled tap), and the resume
then went out as a bare `play()`. Joseph's log (`manual`, 02:14 UTC, build
8722867): a fully cached file, pause and play on the lock screen within a
second, `playing` fires, then `hb` ticks with `t` frozen at 3872.1 for 15 s
with `paused:false`, `rdy:4` and the whole file buffered. Silence with the
element claiming playback, and no network involved at all. The 10 s pauses
that were verified the day before earned a 3 s rewind and worked.

Fix: `_resumeSeekSeconds()` makes any resume while the page is hidden seek
at least 1 s back, independent of the auto-rewind toggle. Not 0: WebKit
short-circuits a seek to the current position without reaching the media
engine. The same rule went into StoryTeller's `autoRewindSeconds()`.

# Open bug: third-party clients don't all work against the shim

Status: **two of four fixed** (2026-09-06, shim). The apps, as reported:

| App | Symptom | Cause | State |
|---|---|---|---|
| ShelfPlayer (iOS) | Authors tab: "Content unavailable" | Asks `/api/libraries/:id/authors?limit=&page=` and decodes `{results, total}`; the shim always sent `{authors}` | **Fixed**: paged shape when `limit`+`page` are numeric, like real ABS |
| Absorb (iOS) | "0 books, 2 folders"; "30 missing or invalid items"; "couldn't load stats" | `/api/libraries/:id/stats` missing; `filter=issues` ignored so every book came back; `/api/me/listening-stats` and `/api/me/stats/year/:year` missing | **Fixed**: all four added/honoured |
| Prologue (iOS) | "An unknown error occurred" at login | unknown — closed source | **Open**: needs a `wrangler tail` capture while logging in |
| Audiobooth (iOS) | "Failed to decode server response: The data couldn't be read because it is missing." at login | unknown — closed source. **Not** `userDefaultLibraryId`: real ABS sends `null` there too (`.local/fixtures/login.json`), and the login body matches the fixture key for key | **Open**: same capture |

ShelfPlayer's source was removed from GitHub when the app was sold (the
repo is a single "Goodbye" commit); `jfrconley/ShelfPlayer` is a June 2026
fork with the code. Absorb is `pounat/absorb` (Flutter, GPL-3.0).

The original notes follow.

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


---

# Done: real author images and biographies

Status: **built 2026-09-06** in the shim (`src/lib/audnexus.ts`, migration
`0014_author_meta`, routes in `src/routes/authors.ts` and the library
authors listing). Lookups happen a few per authors-listing request in the
background and synchronously when one author is opened; the image is
fetched into R2 (`authors/<id>`) on the first request for
`/api/authors/:id/image`. Verified locally: Dennis E. Taylor resolves to
ASIN B010ETTBJC with a biography and a 19 KB photo. The notes below are
what it was built from.

## Where things stand

Every author the shim reports has `imagePath: null` and `description: null`
(`src/routes/authors.ts`), because authors are derived from the author names
on book metadata rather than being records in their own right.
`GET /api/authors/:id/image` answers with a placeholder PNG so clients get an
image-shaped response instead of a 404.

This may not be cosmetic. A null image path is one of the differences between
the shim and real Audiobookshelf, and ShelfPlayer's Authors tab is one of the
things reported as broken — worth checking whether the two are connected
before treating this as a nice-to-have.

## A source that works

Real Audiobookshelf gets author images and biographies from **Audnexus**, a
free API with no key. Two steps, both confirmed working today:

```
GET https://api.audnex.us/authors?name=Philippa%20Gregory&region=us
    → [{ asin: "B000APO5PQ", name: "Philippa Gregory" }, ...]

GET https://api.audnex.us/authors/B000APO5PQ?region=us
    → { asin, name, description, image, region, similar: [...] }
```

The `image` URL is a real Amazon-hosted JPEG — the Philippa Gregory one is
60,704 bytes and returns `200 image/jpeg`. The record also carries a full
biography, which would fill the `description` field at the same time.

**Matching is the part that needs care.** The name search is loose: searching
"Philippa Gregory" also returns book titles that merely contain "Gregory", and
"Dennis E. Taylor" returns 25 results including both "Dennis E Taylor" and
"Dennis E. Taylor". An exact, case-insensitive, punctuation-insensitive name
comparison against the requested author is the obvious guard.

## Notes for whoever builds it

- Unlike book covers, **no resizing is needed** — these are already small, so
  this does not need the off-Worker Pillow runner that the AudioBookBay cover
  pipeline uses. A Worker can fetch and store the bytes directly.
- The shim already has the storage pattern: images live in the R2 bucket bound
  as `COVERS` (`covers/<itemId>` for books, `abbcovers/<id>.webp` for
  catalogue art), and `/api/items/:id/cover` shows the three-tier
  edge-cache → R2 → fetch-and-store shape to copy.
- Author ids are derived (`derivedId(libraryId, 'author', name)`), so they are
  stable for a given name in a given library and can safely key an R2 object.
- `asin` and `description` are already in the author response shape as nulls,
  so filling them needs no shape change.
- The existing placeholder should stay as the fallback for an author Audnexus
  has never heard of.
