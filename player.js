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

    init() {
        this.audio.preload = 'auto';
        this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
        this.audio.addEventListener('ended', () => this.onTrackEnded());
        this.audio.addEventListener('play', () => this.setPlaying(true));
        this.audio.addEventListener('pause', () => { this.setPlaying(false); this.onBufferingEnd(); });
        this.audio.addEventListener('error', (e) => console.error('Audio error', e));
        this.audio.addEventListener('waiting', () => this.onBufferingStart());
        this.audio.addEventListener('stalled', () => this.onBufferingStart());
        this.audio.addEventListener('playing', () => this.onBufferingEnd());
        this.audio.addEventListener('canplay', () => this.onBufferingEnd());

        const speed = localStorage.getItem('cadence_speed');
        if (speed) this.audio.playbackRate = parseFloat(speed);

        const skip = localStorage.getItem('cadence_skip');
        if (skip) this.skipDuration = parseInt(skip);
        this.updateSkipLabels();

        this.setupMediaSession();
    },

    setupMediaSession() {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => this.prevChapter());
        navigator.mediaSession.setActionHandler('nexttrack', () => this.nextChapter());
        // Use seekbackward/seekforward with seekOffset to control displayed duration
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
            this.skip(-(details?.seekOffset || this.skipDuration));
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
            this.skip(details?.seekOffset || this.skipDuration);
        });
    },

    setSkipDuration(seconds) {
        this.skipDuration = seconds;
        localStorage.setItem('cadence_skip', seconds);
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

        this.item = item;
        this.chapters = item.media?.chapters || [];
        this.tracks = item.media?.audioFiles || [];
        this._prewarmedFromTrackIndex = -1;

        try {
            this.session = await ABS.startSession(item.id);
        } catch (e) {
            console.warn('Could not start session', e);
            this.session = null;
        }

        if (startTime === null && this.session?.currentTime) {
            startTime = this.session.currentTime;
        }
        if (startTime === null) {
            const progress = await ABS.getProgress(item.id);
            if (progress && !progress.isFinished) startTime = progress.currentTime || 0;
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
        await Offline._streamFetchToCache(cache, url, key,
            (received, total) => {
                document.dispatchEvent(new CustomEvent('cacheprogress', {
                    detail: { itemId, trackIndex, received, total, done: false },
                }));
            },
            {
                priority: 'low',
                beforeChunk: async () => {
                    if (signal.aborted) throw new Error('aborted');
                    // Re-check the setting between chunks so toggling Cache
                    // while playing OFF takes effect immediately.
                    if (localStorage.getItem('cadence_auto_cache') !== 'true') {
                        throw new Error('disabled');
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
    // one hour ahead. Toggled by the 'cadence_auto_cache' setting.
    async _startAutoCache() {
        if (localStorage.getItem('cadence_auto_cache') !== 'true') return;
        const tracks = this.item?.media?.audioFiles || [];
        if (!tracks.length) return;

        const controller = new AbortController();
        this._autoCacheController = controller;
        const signal = controller.signal;

        // Yield 5s so the initial buffer for the playing track wins the bandwidth.
        await new Promise(r => setTimeout(r, 5000));
        if (signal.aborted) return;

        const TARGET_AHEAD_SEC = 3600; // 1 hour
        const cache = await caches.open(Offline.AUDIO_CACHE);
        const itemId = this.item.id;

        let elapsed = 0;
        for (let i = 0; i < tracks.length; i++) {
            const trackEnd = elapsed + (tracks[i].duration || 0);
            const currentTime = this.getGlobalTime();
            const url = ABS.trackUrl(itemId, tracks[i].ino);
            const key = Offline.keyFor(url);

            if (signal.aborted) return;
            // Skip tracks that end before the current position
            if (trackEnd <= currentTime) { elapsed = trackEnd; continue; }
            // Skip the currently-playing track — caching it competes with the
            // audio element for bandwidth and causes glitches.
            if (currentTime >= elapsed && currentTime < trackEnd) { elapsed = trackEnd; continue; }
            // Stop once we have ~1 hour cached ahead of the listener
            if (elapsed - currentTime >= TARGET_AHEAD_SEC) break;

            if (!(await cache.match(key))) {
                try {
                    await this._streamToCache(cache, url, key, signal, itemId, i);
                } catch {
                    return; // network/abort — bail out, will retry next play
                }
            } else {
                document.dispatchEvent(new CustomEvent('cacheprogress', {
                    detail: { itemId, trackIndex: i, received: 1, total: 1, done: true },
                }));
            }
            elapsed = trackEnd;
        }

        // Save metadata + cover so the book appears in the offline list.
        try {
            const coverUrl = ABS.coverUrl(itemId);
            const coverKey = Offline.keyFor(coverUrl);
            if (!(await cache.match(coverKey))) {
                const coverRes = await fetch(coverUrl, { credentials: 'omit', signal });
                if (coverRes.ok) await cache.put(coverKey, coverRes);
            }
            await Offline.saveMeta(this.item);
        } catch {}
    },

    loadTime(globalTime) {
        let url, offset = 0;
        if (this.session && this.session.audioTracks?.length) {
            const tracks = this.session.audioTracks;
            let track = tracks[0];
            offset = globalTime;
            for (let i = 0; i < tracks.length; i++) {
                if (globalTime >= tracks[i].startOffset && globalTime < tracks[i].startOffset + tracks[i].duration) {
                    track = tracks[i]; offset = globalTime - tracks[i].startOffset;
                    this.currentTrackIndex = i; break;
                }
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
        }
        if (!url) return;
        if (this.audio.src !== url) this.audio.src = url;
        this.audio.currentTime = offset;
        // Play immediately; if it fails (slow connection), retry when audio is ready
        this.audio.play().catch(() => {
            this.audio.addEventListener('canplay', () => this.audio.play().catch(() => {}), { once: true });
        });
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

    // Get current chapter progress (0-100) and time within chapter
    getChapterProgress() {
        const ch = this.getCurrentChapter();
        if (!ch) return { progress: 0, elapsed: 0, remaining: 0, duration: 0 };
        const gt = this.getGlobalTime();
        const chDur = ch.end - ch.start;
        const chElapsed = gt - ch.start;
        return {
            progress: chDur > 0 ? (chElapsed / chDur) * 100 : 0,
            elapsed: chElapsed,
            remaining: chDur - chElapsed,
            duration: chDur,
        };
    },

    play() { this.audio.play().catch(() => {}); },
    pause() { this.audio.pause(); },
    toggle() { this.audio.paused ? this.play() : this.pause(); },

    skip(seconds) {
        const t = Math.max(0, Math.min(this.getGlobalTime() + seconds, this.getTotalDuration()));
        this.loadTime(t);
    },

    seekToChapterPercent(pct) {
        const ch = this.getCurrentChapter();
        if (!ch) return;
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

    setSpeed(rate) { this.audio.playbackRate = rate; localStorage.setItem('cadence_speed', rate); },

    // ── Sleep timer with volume fade ──
    startSleep(minutes) {
        this.clearSleep();
        if (minutes === 'chapter') { this.sleepEndOfChapter = true; this.setSleepActive(true); return; }
        this.savedVolume = this.audio.volume;
        this.sleepEndTime = Date.now() + minutes * 60000;
        this.sleepTimerId = setInterval(() => {
            const remaining = this.sleepEndTime - Date.now();
            if (remaining <= 0) {
                this.pause(); this.audio.volume = this.savedVolume; this.clearSleep(); return;
            }
            const m = Math.floor(remaining / 60000);
            const s = Math.floor((remaining % 60000) / 1000);
            this.setSleepDisplay(m + ':' + (s < 10 ? '0' : '') + s);
            if (remaining < 30000) {
                this.audio.volume = Math.max(0, (remaining / 30000) * this.savedVolume);
            }
        }, 1000);
        this.setSleepActive(true);
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

    isBuffering: false,
    _bufferingTimer: null,
    _recoveryAttempts: 0,

    onBufferingStart() {
        if (this.isBuffering) return;
        // Don't show the spinner if the audio isn't actively trying to play.
        // 'waiting'/'stalled' can fire after pause if the browser was mid-fetch.
        if (this.audio.paused) return;
        this.isBuffering = true;
        this.setBufferingUI(true);
        this._scheduleRecovery();
    },

    onBufferingEnd() {
        if (!this.isBuffering) return;
        this.isBuffering = false;
        this._recoveryAttempts = 0;
        if (this._bufferingTimer) { clearTimeout(this._bufferingTimer); this._bufferingTimer = null; }
        this.setBufferingUI(false);
    },

    // After ~8s of buffering, nudge currentTime to force a fresh Range request.
    // Helps recover from a stalled fetch on flaky connections.
    _scheduleRecovery() {
        if (this._bufferingTimer) clearTimeout(this._bufferingTimer);
        this._bufferingTimer = setTimeout(() => {
            if (!this.isBuffering || this.audio.paused) return;
            if (++this._recoveryAttempts > 3) return;
            const t = this.audio.currentTime;
            this.audio.currentTime = Math.max(0, t - 0.5);
            this.audio.play().catch(() => {});
            this._scheduleRecovery();
        }, 8000);
    },

    setBufferingUI(active) {
        document.getElementById('pp-play')?.classList.toggle('buffering', active);
        document.getElementById('fs-play')?.classList.toggle('buffering', active);
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
    onTimeUpdate() {
        this.updateUI();
        // Update media session on chapter change
        if (this.currentChapterIndex !== this._lastChapterIndex) {
            this._lastChapterIndex = this.currentChapterIndex;
            this.updateMediaSession();
        }
        if (this.sleepEndOfChapter) {
            const next = this.chapters[this.currentChapterIndex + 1];
            if (next && next.start - this.getGlobalTime() <= 0.5) {
                this.pause(); this.sleepEndOfChapter = false; this.setSleepActive(false);
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
            this.audio.currentTime = 0;
            this.audio.play().catch(() => {
                this.audio.addEventListener('canplay', () => this.audio.play().catch(() => {}), { once: true });
            });
        } else {
            this.syncProgress(true);
        }
    },

    updateUI() {
        if (!this.item) return;
        const gt = this.getGlobalTime();
        const dur = this.getTotalDuration();
        const ch = this.getCurrentChapter();
        const chp = this.getChapterProgress();

        // Mini player — shows CHAPTER progress, not book progress
        document.getElementById('pp-track').textContent = this.item.media?.metadata?.title || 'Unknown';
        document.getElementById('pp-narrator').textContent = ch?.title || '';
        document.getElementById('pp-cover').src = ABS.coverUrl(this.item.id);
        document.getElementById('pp-time').textContent = formatTime(chp.elapsed) + ' / ' + formatTime(chp.duration);
        document.getElementById('pp-remaining').textContent = '-' + formatTime(chp.remaining);
        document.getElementById('pp-scrubber-bg').style.width = chp.progress + '%';
        const ppSeek = document.getElementById('pp-seek');
        if (!ppSeek.dataset.dragging) ppSeek.value = chp.progress;

        // Fullscreen player — scrubber is CHAPTER progress, summary shows book progress
        document.getElementById('fs-cover').src = ABS.coverUrl(this.item.id);
        document.getElementById('fs-title').textContent = this.item.media?.metadata?.title || 'Unknown';
        document.getElementById('fs-narrator').textContent = this.item.media?.metadata?.authorName || '';
        const chLabel = ch ? `Ch. ${this.currentChapterIndex + 1}: ${ch.title}` : '';
        document.getElementById('fs-chapter').textContent = chLabel;
        document.getElementById('fs-elapsed').textContent = formatTime(chp.elapsed);
        document.getElementById('fs-remaining').textContent = '-' + formatTime(chp.remaining);

        // Book-level progress summary
        const bookPct = dur > 0 ? Math.round((gt / dur) * 100) : 0;
        document.getElementById('fs-progress-summary').textContent =
            `${bookPct}% of book \u2022 ${formatTime(gt)} / ${formatTime(dur)}`;

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
            updateChapterItems(fsCh.querySelectorAll('.tracklist-item[data-ch]'), 'ch');
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
    },

    startSync() {
        this.stopSync();
        this.lastSyncTime = Date.now();
        this.syncInterval = setInterval(() => this.syncProgress(), 15000);
    },

    stopSync() {
        if (this.syncInterval) { clearInterval(this.syncInterval); this.syncInterval = null; }
    },

    async syncProgress(finished = false) {
        if (!this.item) return;
        const gt = this.getGlobalTime(), dur = this.getTotalDuration();
        const now = Date.now(); const listened = (now - this.lastSyncTime) / 1000;
        this.lastSyncTime = now;
        try {
            if (this.session) await ABS.syncSession(this.session.id, gt, dur, listened);
            else await ABS.updateProgress(this.item.id, {
                currentTime: gt, duration: dur,
                progress: dur > 0 ? gt / dur : 0, isFinished: finished,
            });
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
