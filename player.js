// Audio player controller
const Player = {
    audio: new Audio(),
    session: null,
    item: null,
    chapters: [],
    currentChapterIndex: 0,
    tracks: [],
    currentTrackIndex: 0,
    isPlaying: false,
    sleepTimerId: null,
    sleepEndTime: null,
    sleepEndOfChapter: false,
    savedVolume: 1,
    syncInterval: null,
    lastSyncTime: 0,
    skipDuration: 30,

    _audioRecoveryAttempts: 0,

    init() {
        this.audio.preload = 'auto';
        this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
        this.audio.addEventListener('ended', () => this.onTrackEnded());
        // A silent seek (see loadTime) pauses and resumes under the hood;
        // don't let that pair of events flip the play button.
        this.audio.addEventListener('play', () => { if (!this._silentSeek) this.setPlaying(true); });
        this.audio.addEventListener('pause', () => { if (!this._silentSeek) this.setPlaying(false); });
        // Sustained playback clears the recovery budget so transient stalls
        // over a long listening session don't exhaust 3 attempts forever.
        this.audio.addEventListener('playing', () => { this._audioRecoveryAttempts = 0; });

        // Instrumentation: log every diagnostic-relevant audio-element event to
        // the existing SW debug ring buffer. Only renders when the in-Settings
        // log panel is open (experimentalPartialCache toggle), so zero cost in
        // normal playback. Skip timeupdate / play / pause — too noisy.
        ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough',
         'progress','playing','waiting','stalled','seeking','seeked','abort',
         'emptied','suspend','durationchange','error'].forEach(ev => {
            this.audio.addEventListener(ev, () => this._logAudioEvent(ev));
        });

        // Registered AFTER the instrumentation listeners (they fire in
        // registration order) so the shipped crash-log tail includes the
        // error event itself — recovery ships the log when it runs.
        this.audio.addEventListener('error', () => this._recoverFromAudioError());

        const speed = localStorage.getItem('pholia_speed');
        if (speed) this.audio.playbackRate = parseFloat(speed);

        const skip = localStorage.getItem('pholia_skip');
        if (skip) this.skipDuration = parseInt(skip);
        this.updateSkipLabels();

        this.setupMediaSession();

        // The server only knows the position as of the last sync. Flush it
        // when the app goes to the background or is about to be killed —
        // keepalive so the request outlives the page — instead of leaving up
        // to 30 s of listening to the timer.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && this.item) this.syncProgress(false, { keepalive: true });
        });
        window.addEventListener('pagehide', () => { if (this.item) this.syncProgress(false, { keepalive: true }); });
    },

    // Last position this device saw for an item, written every few seconds
    // while playing and on every sync. Consulted on startItem: newer than the
    // server's lastUpdate means a sync never landed (killed mid-chapter,
    // offline), so resume from here instead of the server's stale value.
    _localPos(itemId) {
        try {
            const v = JSON.parse(localStorage.getItem('pholia_pos_' + itemId));
            return v && typeof v.t === 'number' && typeof v.at === 'number' ? v : null;
        } catch { return null; }
    },
    _saveLocalPos(clear = false) {
        if (!this.item) return;
        try {
            if (clear) localStorage.removeItem('pholia_pos_' + this.item.id);
            else localStorage.setItem('pholia_pos_' + this.item.id, JSON.stringify({ t: this.getGlobalTime(), at: Date.now() }));
        } catch {}
    },

    setupMediaSession() {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => this.prevChapter());
        navigator.mediaSession.setActionHandler('nexttrack', () => this.nextChapter());
        // Use seekbackward/seekforward with seekOffset to control displayed duration
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
            this.skip(-(details?.seekOffset || this.skipDuration), 'ms-seekbackward');
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
            this.skip(details?.seekOffset || this.skipDuration, 'ms-seekforward');
        });
        // seekTime is in the same frame of reference we publish via
        // setPositionState — chapter-relative when chapters exist.
        try {
            navigator.mediaSession.setActionHandler('seekto', (details) => {
                if (details?.seekTime == null) return;
                const ch = this.getCurrentChapter();
                const target = ch ? ch.start + details.seekTime : details.seekTime;
                this.loadTime(target, 'ms-seekto');
            });
        } catch (e) { /* not supported on this browser */ }
    },

    _bufferedSummary() {
        try {
            const b = this.audio.buffered;
            if (!b || !b.length) return { n: 0, sec: 0 };
            let sec = 0;
            for (let i = 0; i < b.length; i++) sec += b.end(i) - b.start(i);
            return { n: b.length, sec: Number(sec.toFixed(1)) };
        } catch { return null; }
    },

    _logSeekCall(source, target) {
        try {
            const from = Number((this.audio.currentTime || 0).toFixed(2));
            const data = { ev: 'seek-call', source, from, to: Number(target.toFixed(2)) };
            if (typeof App !== 'undefined' && App?._swLog) {
                const ts = new Date().toISOString().substring(11, 23);
                App._swLog.push(`${ts} audio ${JSON.stringify(data)}`);
                if (App._swLog.length > (App._swLogMax || 200)) App._swLog.shift();
                App._renderSwLog?.();
            }
        } catch {}
    },

    _logAudioEvent(name) {
        try {
            const a = this.audio;
            const data = {
                ev: name,
                net: a.networkState,
                rdy: a.readyState,
                t: Number((a.currentTime || 0).toFixed(2)),
                err: a.error?.code ?? null,
                paused: a.paused,
                buf: this._bufferedSummary(),
                src: a.currentSrc ? a.currentSrc.split('/').pop()?.split('?')[0] : null,
            };
            console.log('[audio]', data);
            if (typeof App !== 'undefined' && App?._swLog) {
                const ts = new Date().toISOString().substring(11, 23);
                App._swLog.push(`${ts} audio ${JSON.stringify(data)}`);
                if (App._swLog.length > (App._swLogMax || 200)) App._swLog.shift();
                App._renderSwLog?.();
            }
        } catch {}
    },

    // play() rejections are otherwise invisible: NotAllowedError when iOS
    // decides the tap's user activation expired during startItem's awaits,
    // AbortError on src churn. Log them into the ring buffer so crash logs
    // show WHY nothing played.
    _logPlayRejection(source, err) {
        try {
            const data = { ev: 'play-rejected', source, name: err?.name || String(err) };
            console.warn('[audio]', data);
            if (typeof App !== 'undefined' && App?._swLog) {
                const ts = new Date().toISOString().substring(11, 23);
                App._swLog.push(`${ts} audio ${JSON.stringify(data)}`);
                if (App._swLog.length > (App._swLogMax || 200)) App._swLog.shift();
                App._renderSwLog?.();
            }
        } catch {}
    },

    // Play with logging + one retry when the element reports ready. Every
    // programmatic play goes through here so rejections land in the log.
    _tryPlay(source) {
        this.audio.play().catch(err => {
            this._logPlayRejection(source, err);
            this.audio.addEventListener('canplay', () => {
                this.audio.play().catch(e2 => this._logPlayRejection(source + '@canplay', e2));
            }, { once: true });
        });
    },

    // iOS Safari can permanently abandon a stream after its ~1 s Range-stall
    // budget expires (pCloud-backed Ranges via the shim regularly exceed it).
    // Reload the same src and restore playhead; cap at 3 attempts so a
    // genuinely broken stream doesn't infinite-loop.
    _recoverFromAudioError() {
        const err = this.audio.error;
        const code = err?.code;
        console.error('Audio error', { code, message: err?.message });
        // Ship the audio event tail to the server for after-the-fact analysis.
        try { App?.shipCrashLog?.(`audio-error-${code ?? 'x'}`); } catch {}
        // iOS/WebKit reports a network failure or first-byte timeout BEFORE
        // metadata as MEDIA_ERR_SRC_NOT_SUPPORTED (4), not MEDIA_ERR_NETWORK
        // — at readyState 0 it can't tell "server never answered" from "bad
        // codec" (crash-log analysis 2026-08-23: ~40s TTFB on a fresh book
        // -> error 4 -> dead player). Treat that as recoverable too; a
        // genuinely unsupported file just burns the 3 attempts.
        const recoverable = code === 2 /* MEDIA_ERR_NETWORK */ || code === 3 /* MEDIA_ERR_DECODE */
            || (code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */ && this.audio.readyState === 0);
        if (!recoverable || !this.audio.src) return;
        if (this._audioRecoveryAttempts >= 3) {
            console.warn('Audio recovery budget exhausted; tap play to retry');
            return;
        }
        this._audioRecoveryAttempts++;
        const attempt = this._audioRecoveryAttempts;
        const delay = 250 * Math.pow(2, attempt - 1); // 250, 500, 1000 ms
        const savedTime = this.audio.currentTime || 0;
        const wasPlaying = this.isPlaying;
        console.warn(`Recovering audio (attempt ${attempt}/3, resume at ${savedTime.toFixed(1)}s)`);
        setTimeout(() => {
            try {
                this.audio.addEventListener('loadedmetadata', () => {
                    try { this._logSeekCall('error-recover', savedTime); this.audio.currentTime = savedTime; } catch {}
                    if (wasPlaying) this._tryPlay('error-recover');
                }, { once: true });
                this.audio.load();
            } catch (e) {
                console.error('Audio recovery failed', e);
            }
        }, delay);
    },

    setSkipDuration(seconds) {
        this.skipDuration = seconds;
        localStorage.setItem('pholia_skip', seconds);
        this.updateSkipLabels();
    },

    updateSkipLabels() {
        const label = this.skipDuration >= 60 ? Math.round(this.skipDuration / 60) + 'm' : this.skipDuration + '';
        const rwText = document.getElementById('fs-rewind-text');
        const fwText = document.getElementById('fs-forward-text');
        if (rwText) rwText.textContent = label;
        if (fwText) fwText.textContent = label;
    },

    async startItem(item, startTime = null) {
        if (this.session) await this.closeCurrentSession();
        if (this._autoCacheController) { this._autoCacheController.abort(); this._autoCacheController = null; }
        this._audioRecoveryAttempts = 0;

        this.item = item;
        this.chapters = item.media?.chapters || [];
        this.tracks = item.media?.audioFiles || [];
        this._prewarmedFromTrackIndex = -1;

        // Fetch progress alongside the session (not after it) so a resume
        // adds no extra await between the tap and play() — iOS lets the user
        // activation lapse if that gap grows.
        const local = startTime === null ? this._localPos(item.id) : null;
        const progressP = (startTime === null) ? ABS.getProgress(item.id).catch(() => null) : Promise.resolve(null);
        try {
            this.session = await ABS.startSession(item.id);
        } catch (e) {
            console.warn('Could not start session', e);
            this.session = null;
        }

        if (startTime === null) {
            let serverTime = null, serverAt = 0;
            if (this.session?.currentTime) serverTime = this.session.currentTime;
            const progress = await progressP;
            if (progress) {
                serverAt = progress.lastUpdate || 0;
                if (serverTime === null && !progress.isFinished) serverTime = progress.currentTime || 0;
            }
            startTime = serverTime;
            // Newer local position than the server's last write: a sync
            // didn't land. 2 s covers clock skew between phone and server.
            if (local && local.at > serverAt + 2000) startTime = local.t;
        }
        startTime = startTime || 0;

        this.loadTime(startTime);
        this.startSync();
        this.updateMediaSession();
        this.updateUI();

        document.getElementById('player-bar').classList.remove('hidden');
        document.getElementById('main-screen').classList.add('player-active');

        this._startAutoCache();
    },

    // True when the audio element is actively playing but doesn't have much
    // buffered ahead. We use this to pause the cache fetch and yield bandwidth.
    _audioBufferShallow() {
        if (!this.audio || this.audio.paused) return false;
        if (this.audio.readyState < 3) return true; // < HAVE_FUTURE_DATA
        try {
            const b = this.audio.buffered;
            if (b.length === 0) return true;
            const ahead = b.end(b.length - 1) - this.audio.currentTime;
            return ahead < 30; // less than 30s buffered ahead
        } catch { return false; }
    },

    // Cache a track in 10 MB chunks (via Offline._streamFetchToCache).
    // Between chunks, yield to the audio element when its buffer is shallow
    // so the cache doesn't compete with playback. Aborts cleanly on item change.
    async _streamToCache(cache, url, key, signal, itemId, trackIndex) {
        // Compute the playback time at which this track starts in the global
        // book timeline. Used below to translate a chunk's byte offset into
        // an approximate playback time so the sliding 1-hour cache window
        // works inside a single (long) track too.
        const tracks = this.item?.media?.audioFiles || [];
        let trackStart = 0;
        for (let j = 0; j < trackIndex; j++) trackStart += tracks[j]?.duration || 0;
        const trackDuration = tracks[trackIndex]?.duration || 0;
        const TARGET_AHEAD = 3600;

        const KEEP_BEHIND = 1800; // 30 min
        await Offline._streamFetchToCache(cache, url, key,
            async (received, total) => {
                document.dispatchEvent(new CustomEvent('cacheprogress', {
                    detail: { itemId, trackIndex, received, total, done: false },
                }));
                // Sliding-window eviction: drop chunks of this track whose
                // playback time is more than KEEP_BEHIND seconds behind the
                // current playhead. Skip if the entry was explicitly downloaded.
                try {
                    const metaK = Offline.chunkMetaKey(key);
                    const metaRes = await cache.match(metaK);
                    if (!metaRes) return;
                    const m = await metaRes.json();
                    if (m.sticky) return;
                    const cutoff = this.getGlobalTime() - KEEP_BEHIND;
                    if (cutoff <= trackStart) return;
                    let evictedAny = false;
                    for (let ci = 0; ci < m.numChunks; ci++) {
                        // Pin head + tail — codec/duration probes depend on them.
                        if (ci === 0 || ci === m.numChunks - 1) continue;
                        const chunkEndByte = Math.min((ci + 1) * m.chunkSize - 1, m.totalSize - 1);
                        const chunkEndTime = trackStart + (chunkEndByte / m.totalSize) * trackDuration;
                        if (chunkEndTime < cutoff) {
                            if (await cache.delete(Offline.chunkKey(key, ci))) evictedAny = true;
                        }
                    }
                    // After eviction the entry is no longer complete — drop
                    // the sentinel so the SW stops intercepting (would force
                    // a fetch fall-through inside the SW for every Range).
                    if (evictedAny) {
                        if (await cache.delete(Offline.completeKey(key))) {
                            Offline.notifySwCacheChanged();
                        }
                    }
                } catch {}
            },
            {
                priority: 'low',
                // Skip chunks more than 30 min behind the current playhead —
                // we only want to cache around where the listener is, not
                // from the start of the book.
                shouldCache: (byteOffset, totalSize) => {
                    // Always cache the head and tail of every track. The head
                    // (chunk 0) carries the codec/container metadata that the
                    // audio element probes on every play start; the tail
                    // (last chunk) often answers the duration probe. Without
                    // these pinned, both probes leak to network even when the
                    // playhead-area chunks are present.
                    if (byteOffset === 0) return true;
                    if (totalSize > 0 && byteOffset + Offline.CHUNK_SIZE >= totalSize) return true;
                    if (totalSize <= 0 || trackDuration <= 0) return true;
                    const chunkTime = trackStart + (byteOffset / totalSize) * trackDuration;
                    return chunkTime >= this.getGlobalTime() - 1800;
                },
                beforeChunk: async (byteOffset, totalSize) => {
                    if (signal.aborted) throw new Error('aborted');
                    if (localStorage.getItem('pholia_auto_cache') !== 'true') {
                        throw new Error('disabled');
                    }
                    // Sliding window: estimate the playback time of this
                    // chunk's start. If it's more than 1 hour past the
                    // current playhead, sleep until playback catches up.
                    if (totalSize > 0 && trackDuration > 0) {
                        const chunkTime = trackStart + (byteOffset / totalSize) * trackDuration;
                        while (chunkTime > this.getGlobalTime() + TARGET_AHEAD) {
                            await new Promise(r => setTimeout(r, 5000));
                            if (signal.aborted) throw new Error('aborted');
                            if (localStorage.getItem('pholia_auto_cache') !== 'true') {
                                throw new Error('disabled');
                            }
                        }
                    }
                    while (this._audioBufferShallow()) {
                        await new Promise(r => setTimeout(r, 400));
                        if (signal.aborted) throw new Error('aborted');
                    }
                },
            });
        document.dispatchEvent(new CustomEvent('cacheprogress', {
            detail: { itemId, trackIndex, received: 1, total: 1, done: true },
        }));
    },

    // Opportunistically cache audio tracks ahead of the current position so a
    // network blip mid-listen doesn't kill playback. Bandwidth target: roughly
    // one hour ahead. Toggled by the 'pholia_auto_cache' setting.
    async _startAutoCache() {
        if (localStorage.getItem('pholia_auto_cache') !== 'true') return;
        const tracks = this.item?.media?.audioFiles || [];
        if (!tracks.length) return;

        // Abort any loop already running — without this, startItem's
        // loadTime() can trigger _restartAutoCache and then startItem's own
        // _startAutoCache overwrites the controller, leaving the first loop
        // running forever with no way to abort it.
        if (this._autoCacheController) {
            this._autoCacheController.abort();
            this._autoCacheController = null;
        }

        const controller = new AbortController();
        this._autoCacheController = controller;
        const signal = controller.signal;

        // Yield 5s so the initial buffer for the playing track wins the bandwidth.
        await new Promise(r => setTimeout(r, 5000));
        if (signal.aborted) return;

        const TARGET_AHEAD_SEC = 3600; // 1 hour
        const cache = await caches.open(Offline.AUDIO_CACHE);
        const itemId = this.item.id;

        // Save metadata + cover up front so partial sliding-window caches
        // persist across PWA restarts and appear in Settings → Cached with
        // their actual size. Was previously only done after the for loop,
        // which never finishes during a typical play session.
        try {
            const coverUrl = ABS.coverUrl(itemId);
            const coverKey = Offline.keyFor(coverUrl);
            if (!(await cache.match(coverKey))) {
                const coverRes = await fetch(coverUrl, { credentials: 'omit', signal });
                if (coverRes.ok) await cache.put(coverKey, coverRes);
            }
            await Offline.saveMeta(this.item);
        } catch {}

        const KEEP_BEHIND_SEC = 1800; // mirror the per-chunk shouldCache cutoff
        let elapsed = 0;
        for (let i = 0; i < tracks.length; i++) {
            const trackEnd = elapsed + (tracks[i].duration || 0);
            const currentTime = this.getGlobalTime();
            const url = ABS.trackUrl(itemId, tracks[i].ino);
            const key = Offline.keyFor(url);

            if (signal.aborted) return;
            // Skip tracks ending more than 30 min before the playhead — the
            // shouldCache filter would skip every chunk anyway. Tracks that
            // end within the behind-window still get processed so their
            // chunks within [playhead-30min, trackEnd] are cached.
            if (trackEnd <= currentTime - KEEP_BEHIND_SEC) { elapsed = trackEnd; continue; }
            // Stop once we have ~1 hour cached ahead of the listener. For
            // single-file books this still lets the whole file cache (since
            // 1 hour of book is well past the start).
            if (elapsed - currentTime >= TARGET_AHEAD_SEC) break;

            try {
                await this._streamToCache(cache, url, key, signal, itemId, i);
            } catch {
                return; // network/abort — bail out, will retry next play
            }
            elapsed = trackEnd;
        }
    },

    loadTime(globalTime, source = 'loadTime') {
        this._logSeekCall(source, globalTime);
        const prevTime = this.getGlobalTime();
        let url, offset = 0;
        if (this.session && this.session.audioTracks?.length) {
            const tracks = this.session.audioTracks;
            let track = tracks[0];
            offset = globalTime;
            let matched = false;
            for (let i = 0; i < tracks.length; i++) {
                if (globalTime >= tracks[i].startOffset && globalTime < tracks[i].startOffset + tracks[i].duration) {
                    track = tracks[i]; offset = globalTime - tracks[i].startOffset;
                    this.currentTrackIndex = i; matched = true; break;
                }
            }
            if (!matched) {
                // Target at/past the book end (skip() clamps to total
                // duration, which the strict < above never matches). Without
                // this, the tracks[0] default loads the FIRST track with a
                // whole-book offset and currentTrackIndex goes stale.
                const last = tracks.length - 1;
                track = tracks[last];
                this.currentTrackIndex = last;
                offset = Math.max(0, Math.min(globalTime - track.startOffset, track.duration - 0.1));
            }
            url = track.contentUrl.startsWith('http')
                ? track.contentUrl : `${ABS.serverUrl}${track.contentUrl}?token=${ABS.token}`;
        } else if (this.tracks.length) {
            let elapsed = 0;
            for (let i = 0; i < this.tracks.length; i++) {
                if (globalTime < elapsed + this.tracks[i].duration) {
                    this.currentTrackIndex = i;
                    url = ABS.trackUrl(this.item.id, this.tracks[i].ino);
                    offset = globalTime - elapsed; break;
                }
                elapsed += this.tracks[i].duration;
            }
            if (!url) {
                // Same past-the-end case as the session branch above.
                const last = this.tracks.length - 1;
                this.currentTrackIndex = last;
                url = ABS.trackUrl(this.item.id, this.tracks[last].ino);
                offset = Math.max(0, this.tracks[last].duration - 0.1);
            }
        }
        if (!url) return;
        // Diagnostic: if the session's contentUrl path doesn't match what
        // ABS.trackUrl produces (which is the key the offline cache stores
        // under), every audio Range will SW-miss regardless of cache state.
        try {
            const t = this.tracks?.[this.currentTrackIndex];
            if (t?.ino) {
                const expected = Offline.keyFor(ABS.trackUrl(this.item.id, t.ino));
                const actual = Offline.keyFor(url);
                if (expected && expected !== actual) {
                    console.warn('[Pholia] audio URL ≠ cache key — SW will miss', { expected, actual });
                }
            }
        } catch {}
        // Re-assign src even when unchanged if the element is in an error
        // state — an errored element ignores play()/currentTime entirely and
        // only re-running the load algorithm clears it (iOS: error 4 after a
        // load timeout left the player dead until the PWA was killed).
        const srcChanged = this.audio.src !== url || !!this.audio.error;
        if (srcChanged) this.audio.src = url;
        // iOS completes a seek on a PLAYING element in two stages — a quick
        // approximate one that starts sound, then the precise one that snaps
        // back — so the second after a rewind is heard twice (crash-log tail
        // 2026-09-01: seeked at 3209.05, playing at 3209.13, then playing
        // again at 3209.04 with no second seeking). Seek silently instead:
        // pause, set the time, resume once seeked fires.
        const silent = !srcChanged && !this.audio.paused;
        if (silent) {
            this._silentSeek = true;
            this.audio.pause();
        }
        this.audio.currentTime = offset;
        if (silent) {
            let resumed = false;
            const resume = () => {
                if (resumed) return;
                resumed = true;
                this.audio.removeEventListener('seeked', resume);
                this._silentSeek = false;
                this._tryPlay(source);
            };
            this.audio.addEventListener('seeked', resume);
            // Never strand a paused player if seeked doesn't come (src churn).
            setTimeout(resume, 1500);
        } else {
            // Play immediately; if it fails (slow connection), retry when audio is ready
            this._tryPlay(source);
        }
        // Big seek (chapter nav, scrub, jump back/forward) — restart auto-cache
        // so it re-evaluates which chunks fall in the new sliding window. The
        // existing one-shot loop iterates chunks linearly forward and never
        // revisits skipped ones, so without this, scrubbing back to an earlier
        // section never fetches its chunks.
        if (Math.abs(globalTime - prevTime) > 60) this._restartAutoCache();
        this._updatePositionState();
    },

    _restartAutoCache() {
        if (localStorage.getItem('pholia_auto_cache') !== 'true') return;
        if (this._autoCacheController) {
            this._autoCacheController.abort();
            this._autoCacheController = null;
        }
        this._startAutoCache();
    },

    getGlobalTime() {
        if (this.session?.audioTracks?.length) {
            const track = this.session.audioTracks[this.currentTrackIndex];
            return (track?.startOffset || 0) + this.audio.currentTime;
        }
        let elapsed = 0;
        for (let i = 0; i < this.currentTrackIndex; i++) elapsed += this.tracks[i].duration;
        return elapsed + this.audio.currentTime;
    },

    getTotalDuration() {
        return this.session?.duration || this.item?.media?.duration || this.tracks.reduce((s, t) => s + t.duration, 0);
    },

    getCurrentChapter() {
        const time = this.getGlobalTime();
        for (let i = this.chapters.length - 1; i >= 0; i--) {
            if (time >= this.chapters[i].start) { this.currentChapterIndex = i; return this.chapters[i]; }
        }
        return this.chapters[0] || null;
    },

    // Get current chapter progress (0-100) and time within chapter.
    // Books without chapter metadata (e.g. some ABS items) fall back to
    // whole-book progress so the scrubber still works.
    getChapterProgress() {
        const gt = this.getGlobalTime();
        const ch = this.getCurrentChapter();
        if (!ch) {
            const dur = this.getTotalDuration();
            return {
                progress: dur > 0 ? (gt / dur) * 100 : 0,
                elapsed: gt,
                remaining: Math.max(0, dur - gt),
                duration: dur,
            };
        }
        const chDur = ch.end - ch.start;
        const chElapsed = gt - ch.start;
        return {
            progress: chDur > 0 ? (chElapsed / chDur) * 100 : 0,
            elapsed: chElapsed,
            remaining: chDur - chElapsed,
            duration: chDur,
        };
    },

    play() {
        // An errored media element is inert — play() is a silent no-op. A
        // user tap must ALWAYS revive playback: reload the same src via
        // loadTime (which re-assigns src on error) and reset the recovery
        // budget, since a tap is fresh user intent.
        if (this.audio.error && this.item) {
            this._audioRecoveryAttempts = 0;
            this.loadTime(this.getGlobalTime(), 'revive-play');
            return;
        }
        this._tryPlay('play-btn');
        this._updatePositionState();
    },
    pause() {
        this.audio.pause();
        this._updatePositionState();
        // A pause is the position the user will want back; don't wait for the timer.
        if (this.item) this.syncProgress();
    },
    toggle() {
        // paused is unreliable on an errored element (error can fire with
        // paused=false) — route through play()'s revive path first.
        if (this.audio.error) { this.play(); return; }
        this.audio.paused ? this.play() : this.pause();
    },

    skip(seconds, source = 'skip-btn') {
        const t = Math.max(0, Math.min(this.getGlobalTime() + seconds, this.getTotalDuration()));
        this.loadTime(t, source);
    },

    seekToChapterPercent(pct) {
        const ch = this.getCurrentChapter();
        if (!ch) { this.seekToGlobalPercent(pct); return; }
        const chDur = ch.end - ch.start;
        this.loadTime(ch.start + (pct / 100) * chDur);
    },

    seekToGlobalPercent(pct) {
        this.loadTime((pct / 100) * this.getTotalDuration());
    },

    nextChapter() {
        if (this.currentChapterIndex < this.chapters.length - 1)
            this.loadTime(this.chapters[this.currentChapterIndex + 1].start);
    },

    prevChapter() {
        const time = this.getGlobalTime();
        const ch = this.getCurrentChapter();
        if (ch && time - ch.start > 3) this.loadTime(ch.start);
        else if (this.currentChapterIndex > 0) this.loadTime(this.chapters[this.currentChapterIndex - 1].start);
    },

    goToChapter(index) {
        if (index >= 0 && index < this.chapters.length) this.loadTime(this.chapters[index].start);
    },

    seekChapterByTap(index, fraction) {
        if (index < 0 || index >= this.chapters.length) return;
        const ch = this.chapters[index];
        // Dead zone: first 8% of the row snaps to chapter start
        const pct = fraction < 0.08 ? 0 : fraction;
        this.loadTime(ch.start + pct * (ch.end - ch.start));
    },

    setSpeed(rate) { this.audio.playbackRate = rate; localStorage.setItem('pholia_speed', rate); this._updatePositionState(); },

    // ── Sleep timer ──
    SLEEP_REWIND_S: 5,

    startSleep(minutes) {
        this.clearSleep();
        if (minutes === 'chapter') { this.sleepEndOfChapter = true; this.setSleepActive(true); return; }
        this.sleepEndTime = Date.now() + minutes * 60000;
        this.sleepTimerId = setInterval(() => {
            const remaining = this.sleepEndTime - Date.now();
            if (remaining <= 0) {
                clearInterval(this.sleepTimerId); this.sleepTimerId = null;
                this._finishSleep();
                return;
            }
            const m = Math.floor(remaining / 60000);
            const s = Math.floor((remaining % 60000) / 1000);
            this.setSleepDisplay(m + ':' + (s < 10 ? '0' : '') + s);
        }, 1000);
        this.setSleepActive(true);
    },

    _finishSleep() {
        this.pause();
        const target = Math.max(0, this.audio.currentTime - this.SLEEP_REWIND_S);
        this._logSeekCall('sleep-rewind', target);
        this.audio.currentTime = target;
        this.clearSleep();
    },

    clearSleep() {
        if (this.sleepTimerId) { clearInterval(this.sleepTimerId); this.sleepTimerId = null; }
        this.sleepEndTime = null; this.sleepEndOfChapter = false;
        this.setSleepActive(false); this.setSleepDisplay('');
    },

    setSleepActive(active) {
        document.getElementById('pp-sleep')?.classList.toggle('active', active);
        document.getElementById('fs-sleep')?.classList.toggle('active', active);
        const cancel1 = document.getElementById('pp-sleep-cancel');
        const cancel2 = document.getElementById('fs-sleep-cancel');
        if (cancel1) cancel1.style.display = active ? 'block' : 'none';
        if (cancel2) cancel2.style.display = active ? 'block' : 'none';
    },

    setSleepDisplay(txt) {
        const el1 = document.getElementById('pp-sleep-indicator');
        const el2 = document.getElementById('fs-sleep-indicator');
        if (el1) { el1.textContent = txt; el1.classList.toggle('active', !!txt); }
        if (el2) el2.textContent = txt;
    },

    setPlaying(playing) {
        this.isPlaying = playing;
        const playSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        const pauseSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
        document.getElementById('pp-play').innerHTML = playing ? '\u275A\u275A' : '\u25B6';
        document.getElementById('fs-play').innerHTML = playing ? pauseSvg : playSvg;
    },

    _lastChapterIndex: -1,
    _prewarmedFromTrackIndex: -1,
    _lastPositionPublish: 0,
    _lastLocalSave: 0,
    _silentSeek: false,
    onTimeUpdate() {
        this.updateUI();
        // Update media session on chapter change
        if (this.currentChapterIndex !== this._lastChapterIndex) {
            this._lastChapterIndex = this.currentChapterIndex;
            this.updateMediaSession();
        }
        // iOS Safari ignores one-shot setPositionState calls and falls back
        // to the audio element's intrinsic duration on the lock screen.
        // Republishing once a second keeps the chapter-scoped scrubber sticky.
        const now = Date.now();
        if (now - this._lastLocalSave > 5000) {
            this._lastLocalSave = now;
            this._saveLocalPos();
        }
        if (now - this._lastPositionPublish > 1000) {
            this._lastPositionPublish = now;
            this._updatePositionState();
        }
        if (this.sleepEndOfChapter) {
            const next = this.chapters[this.currentChapterIndex + 1];
            if (next && next.start - this.getGlobalTime() <= 0.5) {
                this.sleepEndOfChapter = false;
                this._finishSleep();
            }
        }
        this.maybePrewarmNextTrack();
    },

    // Fetch the head of the next track when within 30s of current track end.
    // Primes DNS/TLS/HTTP cache so onTrackEnded swap is near-instant.
    maybePrewarmNextTrack() {
        const tracks = this.session?.audioTracks || this.tracks;
        if (!tracks || tracks.length < 2) return;
        if (this.currentTrackIndex >= tracks.length - 1) return;
        if (this._prewarmedFromTrackIndex === this.currentTrackIndex) return;
        const cur = tracks[this.currentTrackIndex];
        if (!cur?.duration) return;
        if (this.audio.currentTime < cur.duration - 30) return;

        const next = tracks[this.currentTrackIndex + 1];
        let url;
        if (this.session?.audioTracks) {
            url = next.contentUrl.startsWith('http')
                ? next.contentUrl : `${ABS.serverUrl}${next.contentUrl}?token=${ABS.token}`;
        } else {
            url = ABS.trackUrl(this.item.id, next.ino);
        }
        this._prewarmedFromTrackIndex = this.currentTrackIndex;
        fetch(url, { credentials: 'omit', headers: { Range: 'bytes=0-262143' } }).catch(() => {});
    },

    onTrackEnded() {
        const tracks = this.session?.audioTracks || this.tracks;
        if (this.currentTrackIndex < tracks.length - 1) {
            this.currentTrackIndex++;
            if (this.session?.audioTracks) {
                const t = this.session.audioTracks[this.currentTrackIndex];
                this.audio.src = t.contentUrl.startsWith('http')
                    ? t.contentUrl : `${ABS.serverUrl}${t.contentUrl}?token=${ABS.token}`;
            } else {
                this.audio.src = ABS.trackUrl(this.item.id, this.tracks[this.currentTrackIndex].ino);
            }
            this._logSeekCall('next-track', 0);
            this.audio.currentTime = 0;
            this._tryPlay('next-track');
        } else {
            this.syncProgress(true);
        }
    },

    _lastUI: {},
    updateUI() {
        if (!this.item) return;
        // Skip DOM writes while the page is hidden (PWA backgrounded or screen
        // locked). The lock-screen scrubber is driven by _updatePositionState,
        // which runs independently. timeupdate fires ~4 Hz even with screen
        // off, so skipping here is the main "phone in pocket" battery win.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

        const gt = this.getGlobalTime();
        const dur = this.getTotalDuration();
        const ch = this.getCurrentChapter();
        const chp = this.getChapterProgress();
        const last = this._lastUI;

        // Skip the write if the value hasn't changed — avoids style invalidation
        // churn on the steady fields (title, cover, author) every tick.
        const setText = (id, val) => {
            if (last[id] === val) return;
            last[id] = val;
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        const setSrc = (id, val) => {
            const k = id + '|src';
            if (last[k] === val) return;
            last[k] = val;
            const el = document.getElementById(id);
            if (el) el.src = val;
        };

        const title = this.item.media?.metadata?.title || 'Unknown';
        const author = this.item.media?.metadata?.authorName || '';
        const cover = ABS.coverUrl(this.item.id);
        const elapsedTxt = formatTime(chp.elapsed);
        const remTxt = '-' + formatTime(chp.remaining);
        const chLabel = ch ? `Ch. ${this.currentChapterIndex + 1}: ${ch.title}` : '';
        const progStr = chp.progress + '%';

        // Mini player
        setText('pp-track', title);
        setText('pp-narrator', ch?.title || '');
        setSrc('pp-cover', cover);
        setText('pp-time', elapsedTxt + ' / ' + formatTime(chp.duration));
        setText('pp-remaining', remTxt);
        if (last['pp-scrubber-bg'] !== progStr) {
            last['pp-scrubber-bg'] = progStr;
            const el = document.getElementById('pp-scrubber-bg');
            if (el) el.style.width = progStr;
        }
        const ppSeek = document.getElementById('pp-seek');
        if (!ppSeek.dataset.dragging) ppSeek.value = chp.progress;

        // Fullscreen player
        setSrc('fs-cover', cover);
        setText('fs-title', title);
        setText('fs-narrator', author);
        setText('fs-chapter', chLabel);
        setText('fs-elapsed', elapsedTxt);
        setText('fs-remaining', remTxt);

        const bookPct = dur > 0 ? Math.round((gt / dur) * 100) : 0;
        setText('fs-progress-summary', `${bookPct}% of book \u2022 ${formatTime(gt)} / ${formatTime(dur)}`);

        const fsSeek = document.getElementById('fs-seek');
        if (!fsSeek.dataset.dragging) fsSeek.value = chp.progress;

        // Update any visible chapter list progress fills (FS player + detail view)
        const updateChapterItems = (items, attrName) => {
            items.forEach(el => {
                const idx = parseInt(el.dataset[attrName]);
                if (isNaN(idx)) return;
                const c = this.chapters[idx];
                if (!c) return;
                const cDur = c.end - c.start;
                const isActive = idx === this.currentChapterIndex;
                let prog = 0;
                if (isActive && cDur > 0) prog = ((gt - c.start) / cDur) * 100;
                else if (gt >= c.end) prog = 100;
                el.classList.toggle('is-active', isActive);
                const bar = el.querySelector('.tracklist-progress');
                if (bar) bar.style.width = prog + '%';
            });
        };
        const fsCh = document.getElementById('fs-chapter-list');
        if (fsCh && !fsCh.classList.contains('hidden'))
            updateChapterItems(fsCh.querySelectorAll('.tracklist-item[data-index]'), 'index');
        // Detail view chapter list (data-index items inside #content)
        const detailItems = document.querySelectorAll('#content .tracklist-item[data-index]');
        if (detailItems.length) updateChapterItems(detailItems, 'index');
    },

    updateMediaSession() {
        if (!('mediaSession' in navigator) || !this.item) return;
        const ch = this.getCurrentChapter();
        navigator.mediaSession.metadata = new MediaMetadata({
            title: ch?.title || this.item.media?.metadata?.title || 'Unknown',
            artist: this.item.media?.metadata?.authorName || '',
            album: this.item.media?.metadata?.title || '',
            artwork: [{ src: ABS.coverUrl(this.item.id), sizes: '512x512', type: 'image/jpeg' }],
        });
        this._updatePositionState();
    },

    // Publish chapter-relative position so the iOS/macOS now-playing
    // scrubber reflects the current chapter, not the whole book.
    // Falls back to whole-book values when the item has no chapters.
    _updatePositionState() {
        if (!('mediaSession' in navigator) || !this.item) return;
        if (typeof navigator.mediaSession.setPositionState !== 'function') return;
        const chp = this.getChapterProgress();
        const duration = chp.duration;
        if (!isFinite(duration) || duration <= 0) return;
        const position = Math.max(0, Math.min(chp.elapsed, duration));
        try {
            navigator.mediaSession.setPositionState({
                duration,
                position,
                playbackRate: this.audio.playbackRate || 1,
            });
        } catch (e) { /* invalid state — ignore */ }
    },

    startSync() {
        this.stopSync();
        this.lastSyncTime = Date.now();
        // 30s matches what real ABS clients do; cuts the radio-wake count
        // in half compared to the previous 15s during a typical listening
        // session. Local currentTime is always known, so the only thing we
        // lose is server-side position resolution at finer than 30s.
        this.syncInterval = setInterval(() => this.syncProgress(), 30000);
    },

    stopSync() {
        if (this.syncInterval) { clearInterval(this.syncInterval); this.syncInterval = null; }
    },

    async syncProgress(finished = false, opts = {}) {
        if (!this.item) return;
        const gt = this.getGlobalTime(), dur = this.getTotalDuration();
        const now = Date.now();
        // Only count wall-clock time as listened while audio was running.
        const listened = this.isPlaying ? (now - this.lastSyncTime) / 1000 : 0;
        this.lastSyncTime = now;
        this._saveLocalPos(finished);
        try {
            if (this.session) await ABS.syncSession(this.session.id, gt, dur, listened, opts);
            else await ABS.updateProgress(this.item.id, {
                currentTime: gt, duration: dur,
                progress: dur > 0 ? gt / dur : 0, isFinished: finished,
            }, opts);
        } catch (e) { console.warn('Sync failed', e); }
    },

    async closeCurrentSession() {
        if (!this.session) return;
        this.stopSync();
        try {
            await ABS.closeSession(this.session.id, this.getGlobalTime(), this.getTotalDuration(), 0);
        } catch (e) { console.warn('Close session failed', e); }
        this.session = null;
    },
};

function formatTime(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m}:${s.toString().padStart(2,'0')}`;
}
