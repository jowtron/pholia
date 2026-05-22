# Battery usage minimisation

Audiobook listening is a long-duration use case — often hours per session, often screen-locked with the phone in a pocket. The JS thread sits on top of OS audio playback doing UI updates, server sync, and cache maintenance the user can't see. Every tick of unnecessary CPU or radio activity is real battery cost over an hour of listening.

This document explains the five guards in `player.js` and `app.js` that exist specifically to limit that cost, what each one is doing, and why removing them would silently re-introduce drain that's hard to spot without on-device measurement.

## TL;DR

| # | Guard | File | Saves |
|---|---|---|---|
| 1 | `updateUI()` early-return when page hidden | `player.js` | ~240 redundant DOM writes/minute during screen-locked playback |
| 2 | `updateUI()` per-field change detection (`_lastUI`) | `player.js` | Repeated identical text/src writes 4×/sec |
| 3 | `_updatePositionState` separate 1 Hz path | `player.js` | (Not a saving — must keep firing when hidden) |
| 4 | `_renderTab` background revalidate cooldown (`TAB_CACHE_FRESH_MS`) | `app.js` | Redundant HTTPS request on every quick tab-tap |
| 5 | `Offline.chunkCoverage` memoization (`_coverageVersion`) | `app.js` | Full `cache.keys()` walk per detail-page / fullscreen open and per `onTimeUpdate` tick |

## Why `timeupdate` is the central problem

The `HTMLMediaElement` `timeupdate` event fires roughly 4 times per second on iOS during playback. It fires **even when the screen is locked** — because the audio is still progressing and the spec doesn't tie event delivery to visibility.

Pholia's `Player.onTimeUpdate` handler runs on every tick. The naïve implementation calls `updateUI()` (which does ~12 `getElementById` lookups and 10 `textContent` writes), then runs the mediaSession / position-state updates, then runs the prewarm check. That's a lot of JS executing 4 times a second for the entire duration of a 14-hour audiobook — most of it on UI the user can't see.

The fixes below stagger which parts run when.

## Guard 1: `updateUI()` early-return on hidden

```js
updateUI() {
    if (!this.item) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // ... DOM writes for mini player + fullscreen player ...
}
```

When the page is hidden — PWA backgrounded, screen locked, app switched — no UI is visible, so no DOM writes are needed. The early return drops `updateUI`'s contribution to per-tick work to a single property read.

**Do not remove or weaken this.** The lock-screen scrubber that the user sees during screen-locked playback is NOT driven by `updateUI` — it's driven by `_updatePositionState` (guard 3), which is separately gated and keeps firing.

iOS PWA visibility semantics:
- App in foreground, screen on: `visible`
- App in foreground, screen locked: `hidden`
- App backgrounded (user switched apps): `hidden`

So `visibilityState === 'hidden'` is exactly the "user can't see anything" signal.

## Guard 2: `updateUI()` change detection via `_lastUI`

```js
_lastUI: {},
updateUI() {
    // ... visibility gate ...
    const last = this._lastUI;
    const setText = (id, val) => {
        if (last[id] === val) return;
        last[id] = val;
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    const setSrc = (id, val) => { /* same pattern for img.src */ };
    // ...
    setText('pp-track', title);     // book title — never changes during a book
    setSrc('pp-cover', cover);       // cover URL — same
    setText('pp-narrator', ...);    // chapter title — changes only at chapter boundaries
    setText('pp-time', ...);        // elapsed/duration — actually changes each tick
    // ...
}
```

When the page IS visible, `updateUI` still runs 4×/sec. Most of the fields it writes (title, cover, author) don't change for the entire book. Without change detection we'd be rewriting them 4×/sec anyway, each write triggering DOM mutation events and (for `<img src>`) URL parsing.

The per-field comparison is one string equality check; the write is the expensive part. Skipping the write when the value matches is a real win even on the foreground path.

**Do not simplify these helpers back to direct `el.textContent = ...` writes.**

## Guard 3: `_updatePositionState` keeps firing when hidden

In `onTimeUpdate`:

```js
onTimeUpdate() {
    this.updateUI();  // guarded by visibility — bails when hidden
    // ... chapter change check ...
    const now = Date.now();
    if (now - this._lastPositionPublish > 1000) {
        this._lastPositionPublish = now;
        this._updatePositionState();  // NOT gated on visibility — must keep firing
    }
    // ... sleep timer / prewarm ...
}
```

`_updatePositionState` publishes `mediaSession.setPositionState({ position, duration, playbackRate })`. This is what drives the **lock-screen scrubber** — the position indicator and chapter-scoped duration the user sees on the iOS lock screen.

iOS has a quirk: a one-shot `setPositionState` call doesn't stick. iOS forgets it and falls back to the audio element's intrinsic duration (whole-book, not chapter-scoped). The fix is to republish ~1×/sec for as long as audio is playing — including when the screen is locked.

This is the **one** thing that has to keep firing on the locked-screen path. The 1 Hz throttle (`now - this._lastPositionPublish > 1000`) keeps the per-tick work to a single `setPositionState` call ≤ once per second.

**Do not gate `_updatePositionState` on `visibilityState`.** Lock-screen UI breaks immediately if you do — the duration reverts to whole-book and the scrubber stops tracking the chapter.

Related: `docs/ios-navbar-safe-area.md` for the broader iOS PWA notes.

## Guard 4: tab-cache SWR cooldown

`App._renderTab` uses a stale-while-revalidate pattern: it paints the cached HTML immediately, then refetches in the background and swaps if the markup changed. Without a cooldown, every tab-tap fires a fresh HTTPS request even if you tapped the same tab 2 seconds ago.

```js
TAB_CACHE_FRESH_MS: 30000,

async _renderTab(tab, produce, bind) {
    const cached = this._tabCache[key];
    if (cached) {
        this.setContent(cached.html);
        bind?.(cached.bindData);
        if (Date.now() - cached.ts > this.TAB_CACHE_FRESH_MS) {
            this._refreshTab(key, produce, bind);
        }
        return;
    }
    // ... fresh fetch path ...
}
```

30 seconds is the cooldown. Tapping Home → Library → Home → Series → Home in 10 seconds now fires zero background refreshes after the first paint of each. Each HTTPS request waking the cellular radio has a non-trivial battery cost on mobile; this stops the multiplier.

**Don't drop the cooldown to "always revalidate" for freshness paranoia.** The data doesn't change that fast, and there are explicit invalidation hooks (`_invalidateTabCache('home')` after download/delete) for the cases that do.

## Guard 5: chunk-coverage memoization

`Offline.chunkCoverage(item)` returns per-track info about which audio chunks are present in the cache — used to paint the green dots on chapter rows that show "this chapter is downloaded." The naïve implementation runs `cache.keys()` on the entire audio cache (thousands of chunk entries on a fully-downloaded library), allocates a Set, then scans the Set per-track.

That walk runs on every detail-page open, every fullscreen-player open, and once per second via `onTimeUpdate` during playback. The user-visible symptom was a 1-3 second delay before green dots appeared on every visit.

The fix is a memo keyed by `item.id`, gated by a global version counter:

```js
_coverageCache: new Map(),  // itemId -> { coverage, version }
_coverageVersion: 0,
_invalidateCoverage() { this._coverageVersion++; },

async chunkCoverage(item) {
    const ver = this._coverageVersion;
    const hit = this._coverageCache.get(item.id);
    if (hit && hit.version === ver) return hit.coverage;
    const coverage = await this._computeChunkCoverage(item);
    if (this._coverageVersion === ver) {
        this._coverageCache.set(item.id, { coverage, version: ver });
    }
    return coverage;
},
```

The version counter bumps on any chunk write (`_streamFetchToCache.cache.put`) and on `deleteBook`. So:
- **Settled (fully-downloaded) book**: nothing is writing, version doesn't bump, cache stays valid for the page's lifetime. First call pays the walk, every subsequent call is a `Map.get`.
- **Actively-downloading book**: writes bump the version, next call rebuilds. Green dots fill in live.

**Do not replace this with a simpler "always recompute" path.** The walk cost scales with total chunks across the whole library, not just the current book — it grows linearly as users download more books, and runs on every chapter-list render.

## How to add new code without re-introducing drain

When adding new code in `player.js` / `app.js` that touches these areas:

- **New per-tick work in `onTimeUpdate`** — think about whether it needs to run when hidden. Only the mediaSession / position-state path needs to. Wrap visibility-dependent work in `if (document.visibilityState !== 'hidden')` or put it inside `updateUI` (which is already gated).
- **New DOM writes in `updateUI`** — use the `setText` / `setSrc` helpers, don't bypass them with direct `el.textContent = …` assignments.
- **New tab views** — use `App._renderTab`, don't roll your own SWR or directly call `setContent` from a `show*` function. The cooldown comes for free.
- **New code that writes to the audio cache via `cache.put`** — call `Offline._invalidateCoverage()` after the write, or route through `Offline._streamFetchToCache` (which already does). Otherwise the chapter-cache green dots will be stale.
- **New `setInterval` polling** — be honest about how often the data actually changes. 15-second polling during playback is a radio wake every 15 seconds for an hour of listening; can you get away with 30 seconds or more?

## Related

- `docs/ios-navbar-safe-area.md` — iOS PWA layout / safe area quirks.
- `CLAUDE.md` "Player Quirks Learned" — older spinner-on-pause / buffer-recovery decisions.
- `CLAUDE.md` "Service Worker — Critical Architecture" — separate set of safeguards on the SW side; same "looks deletable, isn't" pattern.
