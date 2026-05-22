# iOS PWA gotchas

A consolidated list of iOS-Safari-specific quirks that have caused real bugs in Pholia. Almost every "that should work but doesn't" investigation in this project has ended at one of these. Read this before adding new code that touches audio, media-session, the service worker, or the page-lifecycle.

The bugs aren't theoretical — each section ends with where it bit us and what we did about it. The fixes are load-bearing.

## Scope

This document is specifically about **iOS Safari running a PWA in standalone mode** (i.e. installed via Add to Home Screen, no Safari chrome). Many of these quirks also apply to iOS Safari in a regular browser tab, but the PWA context is where they matter most for Pholia — that's how the user actually uses the app.

## Audio

### `audio.volume` writes are silently ignored

`HTMLMediaElement.volume` is hardware-only on iOS. Writes like `audio.volume = 0.5` accept the assignment without error, the property reads back as `0.5`, but the actual output volume doesn't change — device volume is under user hardware control only.

**Effect:** JS volume animations (fade-out, ducking, etc.) have zero audible effect on iOS, even though the same code works on macOS/desktop browsers.

**Workaround:** There isn't one. Web Audio `GainNode` produces an audible fade, but introduces a worse problem (see next section). The pragmatic choice for Pholia: no audible fade on iOS. Sleep timer just pauses + rewinds.

**Where it bit us:** Sleep-timer fade originally used `audio.volume` ramping — silent on iOS. See `feedback_ios_audio_volume` memory.

### Web Audio `createMediaElementSource` permanently captures audio output

Calling `audioCtx.createMediaElementSource(audioElement)` is a **one-way door**. Once invoked, that audio element's output is routed through the `AudioContext` for the lifetime of the element. There is no `disconnect()` that gives you native routing back.

iOS suspends `AudioContext` when the screen locks. So if your audio element is routed through an AC, lock-screen → audio stops entirely, even though the element thinks it's playing and the lock-screen scrubber may still tick.

**Effect:** Any feature using Web Audio routing breaks background / lock-screen playback.

**Workaround:** None that we found. We tried a "throwaway second element" approach — create a fresh AC + element just for a fade window, dispose after. Sounds clever, but iOS suspends ANY AC on lock, so even a fresh one is dead under lock. No library helps because the constraint is at the browser/OS boundary, not the JS layer.

**Where it bit us:** We shipped Web Audio routing for a sleep-timer fade, immediately had users report "audio stops when screen locks." Reverted in commit `3f91ca9`. See `feedback_ios_audio_volume`.

## Media Session

### `setPositionState` doesn't stick — must republish ~1 Hz

`navigator.mediaSession.setPositionState({ position, duration, playbackRate })` updates the lock-screen scrubber and reported duration. On iOS, a one-shot call doesn't stick — iOS forgets it and falls back to the audio element's intrinsic duration (whole-book, not chapter-scoped).

**Fix:** Republish ~1 Hz for as long as audio is playing, including when the screen is locked. Pholia does this from `onTimeUpdate` with a `_lastPositionPublish` timestamp throttle.

**Critical:** the republish must NOT be gated on `visibilityState` — it's what drives the lock-screen UI when the user can't see anything else. See `docs/battery-usage-minimisation.md` (guard 3).

**Where it bit us:** Lock-screen scrubber kept reverting to whole-book duration after every chapter change. See `feedback_ios_position_state`.

## Memory

### ~50 MB working memory budget per tab (PWA)

iOS Safari aggressively kills tabs / PWAs that exceed ~50 MB working memory. The kill is silent — you get a "Service Worker context closed" error, or in worse cases the whole page reloads. Logging the OOM is the OS's job; you mostly find out from user reports.

This budget is shared across the SW and the page. Loading a single multi-hundred-MB audio file into a `Blob` or `ArrayBuffer` will absolutely OOM the tab.

**Implications for Pholia:**

- **Never** `cache.put(url, hugeResponse)` as a single entry. Audio is cached in 10 MB chunks (`OFFLINE_AUDIO_CACHE`).
- **Never** `await response.arrayBuffer()` or `await response.blob()` on a multi-MB audio response. Stream it in chunks.
- **Never** stream all cached chunks into a single `ReadableStream` that a caller might not drain. HEAD requests are a hazard — they want headers only, never the body, so any stream you build for a HEAD request just sits in the queue.

**Where it bit us:**

- **Wide-range Range responses** in `serveChunked` were stitching every overlapping chunk into a single Blob and returning as 206. iOS sends `bytes=N-` open-ended Ranges after seeks — easily spans 50+ chunks. We added `MAX_RANGE_SLICE = 4 MB` cap; iOS sees a partial 206 and re-issues for the next slice. See `project_pholia_sw_memory` memory.
- **HEAD requests** hitting `serveChunked`'s no-Range branch were building a `ReadableStream` pulling every cached chunk's `arrayBuffer()` into memory. HEAD callers never drain the body — queue fills with the whole file. Fix: pass HEAD straight through to network. See `sw.js` line 115.

## Page lifecycle

### `visibilityState === 'hidden'` triggers on screen lock

iOS Safari fires `visibilitychange` to `hidden` when:
- The user switches apps (PWA backgrounded)
- The user locks the screen (PWA still foreground from the OS perspective, but the page is hidden)

It fires back to `visible` when the app returns to foreground AND the screen is unlocked.

**Implication:** `visibilityState` is the right signal for "user can't see anything" — gating UI updates on it correctly skips work for both backgrounded and screen-locked cases. Pholia uses this in `updateUI()` to skip ~240 DOM writes/minute during screen-locked playback. See `docs/battery-usage-minimisation.md` (guard 1).

### `requestAnimationFrame` does NOT fire when hidden

Per spec, `requestAnimationFrame` callbacks pause when the page is hidden (in any browser). On iOS specifically, this means rAF stops firing the moment the screen locks or the user backgrounds the app.

**Implication:** Don't use rAF for anything that needs to keep running during screen-locked playback (fade animations, position updates, timers). Use `setInterval` instead — it's throttled to ~1 Hz when hidden on iOS, but it still fires.

**Where it bit us:** Early sleep-timer fade implementation used rAF. The fade silently stopped the moment the screen locked. Replaced with `setInterval`.

### `timeupdate` keeps firing when hidden

Unlike rAF, `HTMLMediaElement` `timeupdate` events keep firing during screen-locked playback (~4 Hz). The audio is progressing; the event reflects that progression.

**Implication:** Any `timeupdate` handler is also running 4 Hz during screen-locked playback. If it does meaningful work (DOM updates, fetches, etc.), that's pure battery drain — the user can't see the result. Gate it on `visibilityState` where possible. See guard 1 in `docs/battery-usage-minimisation.md`.

### `setInterval` is throttled but still fires when hidden

iOS throttles `setInterval` to ~1 Hz max when the page is hidden. So your `setInterval(fn, 250)` becomes `setInterval(fn, 1000)` once the screen locks, but it doesn't stop firing entirely.

**Implication:** This is the right tool for "do something every N seconds even when the user can't see the screen" — sleep timer countdown, sync interval, etc. Don't use rAF for these.

## Service Worker

### `fetch()` inside SW respects the browser HTTP cache by default

"Network-first" SW handlers are misleading. When the SW does `fetch(request)`, the fetch goes through the browser's HTTP cache. If the upstream sent `Cache-Control: max-age=86400`, that response is served from disk cache, not the network — even though the SW thinks it's doing a network request.

**Effect:** A "network-first" SW for assets with long max-age silently serves stale responses for the full max-age. Update banners may not fire, build versions look fresh while behavior is from the previous build.

**Fix:** Either (a) cache-bust the URL itself (Pholia uses `?v=<hash>` injected at deploy time, see `project_pholia_cache_busting`), or (b) pass `{ cache: 'reload' }` / `'no-cache'` to the SW's `fetch()` call.

**Where it bit us:** We shipped tab caching + empty-state spinner fix; users still saw the bugs because `app.js` had a 24h max-age and the SW was serving yesterday's bytes. Diagnosed in conversation, fixed in commit `4a09dc2`.

### Selective interception is mandatory for media

The SW intercepting cross-origin media requests adds measurable latency on iOS WebKit — even for pure passthrough. Streaming over slow networks (e.g. a self-hosted ABS on Tailscale) gets buffer underruns and audible glitches.

**Pholia's approach:** the SW maintains an in-memory `cachedKeys` Set. The fetch handler consults this synchronously; for URLs not in the set, the handler returns without calling `respondWith`, leaving the browser to fetch natively as if no SW existed. Only intercept what's actually cached.

The set is populated lazily from `cache.keys()` on SW startup and refreshed when the page sends `CACHE_CHANGED` messages after `downloadBook` / `deleteBook`.

**Where it bit us:** Original "always intercept media" implementation introduced playback glitches that didn't reproduce in DevTools. Fixed in commit `1bb9705`. See CLAUDE.md → Service Worker → Selective interception.

### Cache API strips URL fragments before storing/matching

Per spec, the Cache API treats `url#a` and `url#b` as the same cache key (the fragment is stripped). So if you key chunked entries with `url#chunk=0`, `url#chunk=1`, etc., they all collapse to the same key — every write overwrites the previous one.

**Use query params instead:** `url?__chunk=0`, `url?__chunk=1`, `url?__meta=1`. Query params are preserved.

**Where it bit us:** Weeks of mysterious "downloads complete instantly", "1 byte cached", "all chapters falsely green" symptoms. Fixed by switching to query-param keys (bumped audio cache to v2). See CLAUDE.md → Service Worker → Chunked offline audio cache.

## Misc

### Cloudflare Pages `_headers` rules are additive

Not iOS-specific, but bit us hard once and the symptom looked iOS-specific. If you have multiple matching `Cache-Control` rules in `_headers`, Cloudflare Pages concatenates them. A wildcard `Cache-Control: max-age=86400` plus `/sw.js Cache-Control: no-cache` produces a header like `max-age=86400, ..., no-cache, ..., max-age=86400`. Safari picks one of the long values and caches `sw.js` for 24 hours, breaking all SW updates.

**Fix:** Use only explicit per-file rules in `_headers`, never wildcards. See commit `f79d8b3`.

### `<input type="url">` rejects bare hostnames

Trying to type `myabs.local` in a `type="url"` field gives "please enter a URL" — you have to type `https://myabs.local`. Annoying for the ABS server URL field where users may not include the scheme.

**Fix:** Use `type="text"` and auto-prepend `https://` if missing.

### `?purge` URL escape hatch

When all else fails (SW stuck, cache poisoning, weird intermediate state), `https://pholia.pages.dev/?purge` nukes all caches and unregisters the SW, then reloads clean. Implementation at the bottom of `index.html`. Tell users about this when debugging — it's faster than walking them through DevTools.

## Related

- `docs/battery-usage-minimisation.md` — the five load-bearing battery guards.
- `docs/ios-navbar-safe-area.md` — safe-area insets in PWA mode.
- `docs/service-worker-architecture.md` — deeper dive on the SW design.
- `CLAUDE.md` → "CORS saga" — auth-via-token instead of Authorization header, because Safari is the strictest about CORS spec compliance.
