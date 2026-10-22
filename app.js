const App = {
    currentLibraryId: null,
    currentMediaType: 'book',
    libraries: [],
    currentTab: 'home',
    navStack: [],

    init() {
        this.setupCrashLog();
        // Launch timing: how long index.html took, and when the scripts had
        // parsed. The rest of the launch marks come from tryAutoLogin and the
        // home render.
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            if (nav) Player._logMark('launch-html', Math.round(nav.responseEnd));
        } catch {}
        this._launchMark('js');
        // Cards show covers at their own aspect ratio inside a square
        // "shelf" slot (.cover-box in style.css): the box learns the ratio
        // when its image loads, and the CSS sizes the cover, the play
        // overlay and the badges from it. Capture phase — load doesn't bubble.
        document.addEventListener('load', (e) => {
            const img = e.target;
            if (!(img instanceof HTMLImageElement)) return;
            const box = img.parentElement;
            if (!box || !box.classList.contains('cover-box')) return;
            if (img.naturalWidth && img.naturalHeight) box.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4));
        }, true);
        Player.init();
        this.bindEvents();
        this.applyTabVisibility();
        this._consumePholiaHandoff();
        this.tryAutoLogin();
        this.setupSwUpdate();
        this.setupSwDebugBridge();
        this.setupPush();
        document.addEventListener('cacheprogress', (e) => this.onCacheProgress(e.detail));
        // Clear phantom downloads (meta entries with no audio) left behind
        // by SW cleanups of legacy oversized cache entries.
        Offline.cleanupPhantoms();
    },

    // ── Crash log shipping ────────────────────────────────────────────────
    // Pholia is a PWA; iOS can kill the tab or silently park the audio
    // element without any error event we'd otherwise see. We periodically
    // snapshot the audio event ring buffer to localStorage so the next launch
    // can ship the previous (likely-crashed) session's tail to a Pages
    // function backed by D1. Server-side endpoint: /api/log
    _sessionId: null,
    // -Infinity, not 0: performance.now() starts at page load, so a 0 here
    // blocked every ship in the first 30 s of a launch ("Failed (no request)"
    // on a manual send straight after a relaunch, 2026-09-07).
    _crashLogShipThrottle: -Infinity,

    setupCrashLog() {
        try {
            // New session id for this launch. The previous launch's id is
            // still in localStorage at this point so we can ship its tail.
            const newId = (crypto.randomUUID?.() || Math.random().toString(36).slice(2));

            // If a previous session left a buffer behind without a clean
            // shutdown flag, ship it now. Async — don't block init.
            const prevId = localStorage.getItem('pholia_session_id');
            const prevBuf = localStorage.getItem('pholia_session_buffer');
            const wasClean = localStorage.getItem('pholia_session_clean') === 'true';
            if (prevId && prevBuf && !wasClean) {
                try {
                    const events = JSON.parse(prevBuf);
                    if (Array.isArray(events) && events.length) {
                        this._postCrashLog({
                            session_id: prevId,
                            reason: 'prior-session-tail',
                            events,
                        });
                    }
                } catch {}
            }

            // Reset for this session.
            localStorage.setItem('pholia_session_id', newId);
            localStorage.removeItem('pholia_session_buffer');
            localStorage.removeItem('pholia_session_clean');
            this._sessionId = newId;

            // Periodic backup of the in-memory ring buffer.
            this._refreshStorageEstimate();
            setInterval(() => { this._snapshotCrashLog(); this._refreshStorageEstimate(); }, 10000);

            // Also snapshot when the tab is hidden — iOS may kill us soon.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') this._snapshotCrashLog();
            });

            // On a clean unload, mark clean so the next launch doesn't
            // re-ship the buffer.
            window.addEventListener('pagehide', () => {
                try {
                    this._snapshotCrashLog();
                    localStorage.setItem('pholia_session_clean', 'true');
                } catch {}
            });
        } catch {}
    },

    _snapshotCrashLog() {
        try {
            if (!this._swLog?.length) return;
            localStorage.setItem('pholia_session_buffer', JSON.stringify(this._swLog));
        } catch {}
    },

    // Throttled to one ship every 30s per reason to keep a flapping error
    // from spamming the table. prior-session-tail bypasses the throttle.
    shipCrashLog(reason, opts) {
        const now = performance.now();
        const force = reason === 'prior-session-tail' || (opts && opts.force);
        if (!force && now - this._crashLogShipThrottle < 30000) return null;
        this._crashLogShipThrottle = now;
        try {
            return this._postCrashLog({
                session_id: this._sessionId,
                reason,
                events: this._swLog ? this._swLog.slice() : [],
                audio_state: this._currentAudioState(),
            }, opts);
        } catch { return null; }
    },

    _currentAudioState() {
        try {
            const a = Player?.audio;
            if (!a) return null;
            let buf = null;
            try {
                const b = a.buffered;
                if (b && b.length) {
                    let sec = 0;
                    for (let i = 0; i < b.length; i++) sec += b.end(i) - b.start(i);
                    buf = { n: b.length, sec: Number(sec.toFixed(1)) };
                } else buf = { n: 0, sec: 0 };
            } catch {}
            return {
                src: a.currentSrc ? a.currentSrc.split('/').pop()?.split('?')[0] : null,
                t: Number((a.currentTime || 0).toFixed(2)),
                net: a.networkState,
                rdy: a.readyState,
                err: a.error?.code ?? null,
                paused: a.paused,
                playing: Player.isPlaying,
                item_id: Player.item?.id || null,
                buf,
                sw: this._swBuild || null,
                vis: document.visibilityState,
                storage: this._lastStorageEstimate || null,
            };
        } catch { return null; }
    },

    _refreshStorageEstimate() {
        try {
            navigator.storage?.estimate?.().then(e => {
                this._lastStorageEstimate = {
                    usage_mb: e?.usage ? Math.round(e.usage / 1048576) : null,
                    quota_mb: e?.quota ? Math.round(e.quota / 1048576) : null,
                };
            }).catch(() => {});
        } catch {}
    },

    // The server refuses bodies over its cap (functions/api/log: 256 KB, was
    // 64 KB) and sendBeacon itself has a 64 KB budget in WebKit, so trim the
    // OLDEST lines until the body fits: with the SW debug log on, a range
    // request is three ~250-byte lines and a 400-line buffer passes 64 KB
    // inside one long session. That is how a "Sent" log on 2026-09-07 never
    // arrived — the ring had grown since the morning's ship, and nothing
    // reported the 413. The newest lines are the ones that matter.
    _crashLogMaxBytes: 60 * 1024,
    _postCrashLog(payload, { viaFetch = false } = {}) {
        try {
            const events = Array.isArray(payload.events) ? payload.events.slice() : [];
            const build = () => JSON.stringify({
                ...payload,
                events,
                app_version: document.getElementById('build-version')?.textContent || null,
            });
            let body = build();
            while (body.length > this._crashLogMaxBytes && events.length > 1) {
                events.splice(0, Math.max(1, Math.ceil(events.length / 8)));
                body = build();
            }
            const post = () => fetch('/api/log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            });
            // A manual send is in the foreground and wants to know whether it
            // landed; the automatic paths prefer sendBeacon, which survives
            // pagehide / app kill but never reports a failure.
            if (viaFetch) return post();
            if (navigator.sendBeacon) {
                const blob = new Blob([body], { type: 'application/json' });
                if (navigator.sendBeacon('/api/log', blob)) return null;
            }
            post().catch(() => {});
        } catch {}
        return null;
    },

    sendSwConfig() {
        // 'pholia_sw_experimental' is the audio debug log. The partial-cache
        // intercept has no toggle any more (2026-09-08: it was found switched
        // off and that alone cost 34 s startups) — it is always on, and only
        // the automatic partialDisabledUntil fallback in sw.js disables it.
        // Keep sending true: during an update the new page can briefly talk
        // to the OLD worker, which reads a missing field as false.
        const swDebugLog = localStorage.getItem('pholia_sw_experimental') === 'true';
        try {
            navigator.serviceWorker?.controller?.postMessage({
                type: 'SW_CONFIG',
                experimentalPartialCache: true,
                swDebugLog,
            });
        } catch {}
    },

    _swLog: [],
    // 400, not 200: the hidden-page heartbeat (Player._hiddenHeartbeat) adds
    // a line every few seconds and must not push a boundary's events out.
    _swLogMax: 400,

    // One line into the diagnostic ring buffer (the same one the SW_DEBUG
    // bridge and the audio-element events write to).
    _pushLog(tag, data) {
        try {
            if (!this._swLog) return;
            const ts = new Date().toISOString().substring(11, 23);
            this._swLog.push(`${ts} ${tag} ${JSON.stringify(data)}`);
            if (this._swLog.length > this._swLogMax) this._swLog.shift();
            this._renderSwLog();
        } catch {}
    },

    // The worker's own build hash (SW_BUILD in sw.js). Shown under the page's
    // hash in the nav and recorded in every crash log's audio_state, because
    // the two update independently and a test against a stale worker is
    // worthless (2026-09-06).
    _swBuild: null,
    _setSwBuild(b) {
        if (!b || b === this._swBuild) return;
        this._swBuild = b;
        const el = document.getElementById('sw-build');
        if (el) el.textContent = 'sw ' + b;
    },
    querySwBuild() {
        try {
            const ctrl = navigator.serviceWorker?.controller;
            if (!ctrl) return;
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => this._setSwBuild(e.data?.build);
            ctrl.postMessage({ type: 'SW_VERSION' }, [ch.port2]);
        } catch {}
    },

    // Tell the SW a media load for `url` is about to begin so it pins how it
    // will answer every request for that file (all from the worker, or none):
    // iOS cancels a media load whose CORS status changes between responses.
    // Resolves with the mode, or null if there's no controller / no reply.
    pinMediaMode(url) {
        const started = performance.now();
        const log = (mode, timedOut) => this._pushLog('page', {
            ev: 'pin-wait', url: url.split('/').pop()?.split('?')[0] || null, mode, timedOut,
            ms: Math.round(performance.now() - started), vis: document.visibilityState,
        });
        return new Promise(resolve => {
            const ctrl = navigator.serviceWorker?.controller;
            if (!ctrl) return resolve(null);
            const ch = new MessageChannel();
            // This was 500 ms, and the worker missed it at EVERY load in the
            // 2026-09-06 logs (a restarted worker takes about a second to
            // answer), so src was assigned unpinned and the first Range went
            // out under the fallback rule — which made attempt 1's "native"
            // boundary a worker/native mix. Wait for the pin; the cap only
            // guards against a worker that never replies at all.
            const t = setTimeout(() => { log(null, true); resolve(null); }, 8000);
            ch.port1.onmessage = (e) => {
                clearTimeout(t);
                this._setSwBuild(e.data?.build);
                log(e.data?.mode || null, false);
                resolve(e.data?.mode || null);
            };
            try { ctrl.postMessage({ type: 'MEDIA_LOAD', url }, [ch.port2]); } catch { clearTimeout(t); resolve(null); }
        });
    },

    setupSwDebugBridge() {
        if (!('serviceWorker' in navigator)) return;
        // Send config now and on every controllerchange (new SW = needs the flag again).
        this.sendSwConfig();
        this.querySwBuild();
        navigator.serviceWorker.addEventListener('controllerchange', () => { this.sendSwConfig(); this.querySwBuild(); });
        // The SW persists its flags, but re-sending on every foreground is
        // cheap insurance for a worker that restarted while we were hidden.
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { this.sendSwConfig(); this.querySwBuild(); } });
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data?.type !== 'SW_DEBUG') return;
            console.log('[sw]', e.data.tag, e.data.data);
            const ts = new Date(e.data.t || Date.now()).toISOString().substring(11, 23);
            this._swLog.push(`${ts} ${e.data.tag} ${JSON.stringify(e.data.data)}`);
            if (this._swLog.length > this._swLogMax) this._swLog.shift();
            this._renderSwLog();
        });
    },

    _renderSwLog() {
        const pre = document.getElementById('sw-log-pre');
        if (!pre) return;
        // Only re-render if the section is currently visible.
        if (document.getElementById('sw-log-section')?.classList.contains('hidden')) return;
        pre.textContent = this._swLog.join('\n');
        pre.scrollTop = pre.scrollHeight;
    },

    applyTabVisibility() {
        const hideCollections = localStorage.getItem('pholia_hide_collections') === 'true';
        document.documentElement.classList.toggle('hide-collections', hideCollections);
        if (hideCollections && this.currentTab === 'collections') this.switchTab('home');
    },

    _updateBannerShown: false,
    _showUpdateBanner(reg) {
        if (this._updateBannerShown) return;
        this._updateBannerShown = true;
        document.getElementById('update-banner').classList.remove('hidden');
        // Auto-apply after 5s
        setTimeout(() => {
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }, 5000);
        // Failsafe: if controllerchange never fires, force a reload.
        setTimeout(() => {
            if (document.visibilityState === 'visible') window.location.reload();
        }, 12000);
    },

    // After update(), reg.waiting may not be populated for several seconds
    // (especially on iOS PWA where update() can resolve before install
    // completes). Poll repeatedly and also re-fetch the registration in
    // case the live object isn't reflecting state changes.
    _pollInFlight: false,
    async _pollForUpdate() {
        if (!('serviceWorker' in navigator)) return;
        if (this._pollInFlight) return;
        this._pollInFlight = true;
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            if (!reg) return;
            try { await reg.update(); } catch {}
            // If a new SW is installing, await its statechange.
            if (reg.installing) {
                const installer = reg.installing;
                await new Promise(resolve => {
                    const done = () => {
                        if (installer.state === 'installed' || installer.state === 'activated' || installer.state === 'redundant') {
                            installer.removeEventListener('statechange', done);
                            resolve();
                        }
                    };
                    installer.addEventListener('statechange', done);
                    setTimeout(() => { installer.removeEventListener('statechange', done); resolve(); }, 8000);
                });
            }
            // Poll reg.waiting for up to 10s.
            for (let i = 0; i < 20; i++) {
                const fresh = await navigator.serviceWorker.getRegistration();
                if (fresh?.waiting) { this._showUpdateBanner(fresh); return; }
                await new Promise(r => setTimeout(r, 500));
            }
        } finally {
            this._pollInFlight = false;
        }
    },

    setupSwUpdate() {
        if (!('serviceWorker' in navigator)) return;

        document.getElementById('update-btn').addEventListener('click', async () => {
            try {
                const reg = await navigator.serviceWorker.getRegistration();
                if (reg?.waiting) {
                    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                    setTimeout(() => window.location.reload(), 1500);
                } else {
                    window.location.reload();
                }
            } catch {
                window.location.reload();
            }
        });

        navigator.serviceWorker.getRegistration().then(reg => {
            if (!reg) return;
            // updatefound listener catches updates that happen while the page
            // is open (most browsers). The poll in _pollForUpdate is the
            // belt-and-suspenders for iOS.
            reg.addEventListener('updatefound', () => {
                const newSw = reg.installing;
                if (!newSw) return;
                newSw.addEventListener('statechange', () => {
                    if (newSw.state === 'installed' && navigator.serviceWorker.controller) {
                        this._showUpdateBanner(reg);
                    }
                });
            });
        });

        // Initial poll (covers updates already installed at page load) —
        // deferred so the index.html refetch and the sw.js re-download don't
        // share the radio with the launch API calls (2026-09-20). Until this
        // fires, checkForSwUpdate (the first switchTab) is a no-op too.
        setTimeout(() => {
            this._updateChecksArmed = true;
            this._lastSwCheck = 0;
            this.checkForSwUpdate();
        }, 6000);

        // Reload when new SW takes control. Skip the first-install case so we
        // don't blow away in-memory state.
        const hadController = !!navigator.serviceWorker.controller;
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (hadController && !refreshing) { refreshing = true; window.location.reload(); }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this._pollForUpdate();
                this._checkBuildVersion();
            }
        });
    },

    bindEvents() {
        // Login
        document.getElementById('login-form').addEventListener('submit', e => {
            e.preventDefault(); this.handleLogin();
        });
        document.getElementById('passkey-login-btn').addEventListener('click', () => this.handlePasskeyLogin());
        document.getElementById('server-url').addEventListener('change', () => this._offerPasswordReset());
        document.getElementById('username').addEventListener('change', () => this._offerPasswordReset());
        document.getElementById('save-account-yes').addEventListener('click', () => this._confirmSaveToAccount());
        document.getElementById('save-account-no').addEventListener('click', () => this._dismissSaveToAccount());
        document.getElementById('server-picker-add').addEventListener('click', () => {
            document.getElementById('server-picker').classList.remove('active');
            document.getElementById('login-screen').classList.add('active');
            document.getElementById('login-form').reset();
            document.getElementById('login-error').textContent = '';
        });
        document.getElementById('server-picker-logout').addEventListener('click', async () => {
            await Account.logout();
            document.getElementById('server-picker').classList.remove('active');
            document.getElementById('login-screen').classList.add('active');
            await this.setupPasskeyButton();
        });

        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Header
        document.getElementById('back-btn').addEventListener('click', () => this.goBack());
        document.getElementById('settings-btn').addEventListener('click', () => this.showSettings());
        // Tap a book's cover on its detail screen → full-size cover in a lightbox
        // (delegated: the detail view is re-rendered as innerHTML).
        document.addEventListener('click', (e) => {
            const img = e.target.closest && e.target.closest('img.detail-cover');
            if (img && img.src && img.style.visibility !== 'hidden') this._abbLightbox(img.src);
        });
        document.addEventListener('click', (e) => {
            const img = e.target.closest && e.target.closest('img.author-photo');
            if (img) this._abbLightbox(img.dataset.full || img.src, img.src);
        });
        document.getElementById('search-btn').addEventListener('click', () => this.showSearch());
        document.getElementById('abb-btn').addEventListener('click', () => this.toggleAdd());
        document.getElementById('content').addEventListener('scroll', (e) => {
            if (e.target.classList?.contains('h-scroll')) this._markShelves(e.target);
        }, true);
        window.addEventListener('resize', () => this._markShelves());

        // Search
        document.getElementById('search-cancel').addEventListener('click', () => this.hideSearch());
        document.getElementById('search-input').addEventListener('input', debounce(e => this.doSearch(e.target.value), 300));
        // Enter: put the keyboard away and search now, directory included.
        document.getElementById('search-input').addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.target.blur();
            this.doSearch(e.target.value, null, { now: true });
        });
        this._wireSearchClear(document.getElementById('search-input'), document.getElementById('search-clear'), () => this.doSearch(''));

        // Settings
        document.getElementById('settings-close').addEventListener('click', () => this.hideSettings());
        document.getElementById('stats-open').addEventListener('click', () => { this.hideSettings(); this.showStats(); });
        // Click outside the modal content closes the modal.
        document.getElementById('settings-modal').addEventListener('click', (e) => {
            if (e.target.id === 'settings-modal') this.hideSettings();
        });
        document.getElementById('check-updates-btn').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const orig = btn.textContent;
            btn.textContent = 'Checking…';
            btn.disabled = true;
            this._lastSwCheck = 0; // bypass debounce
            // Run both probes — SW poll catches updates that installed via the
            // normal lifecycle; build-version probe catches updates iOS PWA
            // stubbornly fails to detect via reg.update().
            await Promise.all([this._pollForUpdate(), this._checkBuildVersion()]);
            if (this._updateBannerShown) {
                btn.textContent = 'Update found — see banner';
                btn.disabled = false;
                setTimeout(() => { btn.textContent = orig; }, 4000);
                return;
            }
            btn.textContent = 'Up to date';
            btn.disabled = false;
            setTimeout(() => { btn.textContent = orig; }, 2500);
        });
        document.getElementById('logout-btn').addEventListener('click', () => this.logout());
        document.getElementById('setting-speed').addEventListener('change', e => Player.setSpeed(parseFloat(e.target.value)));
        document.getElementById('setting-skip').addEventListener('change', e => Player.setSkipDuration(parseInt(e.target.value)));
        document.getElementById('setting-theme').addEventListener('change', e => {
            document.documentElement.setAttribute('data-theme', e.target.value);
            localStorage.setItem('pholia_theme', e.target.value);
        });
        document.getElementById('setting-auto-rewind').addEventListener('change', e => {
            localStorage.setItem('pholia_auto_rewind', e.target.checked ? 'true' : 'false');
        });
        document.getElementById('setting-keep-played').addEventListener('change', e => {
            localStorage.setItem('pholia_keep_played_episodes', e.target.checked ? 'true' : 'false');
        });
        document.getElementById('setting-autoplay-next').addEventListener('change', e => {
            localStorage.setItem('pholia_autoplay_next', e.target.checked ? 'true' : 'false');
        });
        document.getElementById('setting-auto-cache').addEventListener('change', e => {
            localStorage.setItem('pholia_auto_cache', e.target.checked ? 'true' : 'false');
            if (e.target.checked && Player.item) Player._startAutoCache();
            else if (!e.target.checked && Player._autoCacheController) {
                Player._autoCacheController.abort();
                Player._autoCacheController = null;
            }
        });
        document.getElementById('setting-hide-collections').addEventListener('change', e => {
            localStorage.setItem('pholia_hide_collections', e.target.checked ? 'true' : 'false');
            this.applyTabVisibility();
        });
        document.getElementById('setting-sw-experimental').addEventListener('change', e => {
            localStorage.setItem('pholia_sw_experimental', e.target.checked ? 'true' : 'false');
            this.sendSwConfig();
            document.getElementById('sw-log-section')?.classList.toggle('hidden', !e.target.checked);
            this._renderSwLog();
        });
        document.getElementById('sw-log-copy').addEventListener('click', async (e) => {
            const text = this._swLog.join('\n') || '(empty)';
            const btn = e.currentTarget;
            const orig = btn.textContent;
            try {
                await navigator.clipboard.writeText(text);
                btn.textContent = 'Copied';
            } catch {
                // Fallback: select text in the <pre> so the user can long-press → copy.
                const pre = document.getElementById('sw-log-pre');
                if (pre) {
                    const range = document.createRange();
                    range.selectNodeContents(pre);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
                btn.textContent = 'Select → Copy';
            }
            setTimeout(() => { btn.textContent = orig; }, 2500);
        });
        document.getElementById('sw-log-clear').addEventListener('click', () => {
            this._swLog.length = 0;
            this._renderSwLog();
        });
        document.getElementById('sw-log-send').addEventListener('click', (e) => {
            const btn = e.currentTarget;
            const orig = btn.textContent;
            // Manual sends bypass the throttle so a user can ship twice in a row,
            // and go over fetch so the button can say whether the server took it.
            btn.textContent = 'Sending…';
            const p = this.shipCrashLog('manual', { viaFetch: true, force: true });
            Promise.resolve(p).then(
                r => { btn.textContent = r && r.ok ? 'Sent' : `Failed (${r ? r.status : 'no request'})`; },
                () => { btn.textContent = 'Failed (offline)'; },
            ).then(() => setTimeout(() => { btn.textContent = orig; }, 3000));
        });
        // Apply saved theme
        const savedTheme = localStorage.getItem('pholia_theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);

        // Library selector
        document.getElementById('library-select').addEventListener('change', e => {
            this.currentLibraryId = e.target.value;
            localStorage.setItem('pholia_library', this.currentLibraryId);
            this.updateMediaType();
            this.switchTab('home');
        });

        // Mini player
        document.getElementById('player-bar').addEventListener('click', e => {
            if (!e.target.closest('.pp-controls') && !e.target.closest('.pp-sleep-btn') &&
                !e.target.closest('.pp-sleep-menu') && !e.target.closest('.pp-scrubber')) {
                this.openFullscreen();
            }
        });
        document.getElementById('pp-play').addEventListener('click', e => { e.stopPropagation(); Player.toggle(); });

        // Mini player scrubber
        const ppSeek = document.getElementById('pp-seek');
        ppSeek.addEventListener('mousedown', () => ppSeek.dataset.dragging = 'true');
        ppSeek.addEventListener('touchstart', () => ppSeek.dataset.dragging = 'true');
        ppSeek.addEventListener('change', () => {
            delete ppSeek.dataset.dragging;
            Player.seekToChapterPercent(parseFloat(ppSeek.value));
        });
        ppSeek.addEventListener('click', e => e.stopPropagation());

        // Sleep timer (mini)
        document.getElementById('pp-sleep').addEventListener('click', e => {
            e.stopPropagation();
            document.getElementById('pp-sleep-menu').classList.toggle('open');
        });
        document.querySelectorAll('#pp-sleep-menu button[data-minutes]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const val = btn.dataset.minutes;
                Player.startSleep(val === 'chapter' ? 'chapter' : parseFloat(val));
                document.getElementById('pp-sleep-menu').classList.remove('open');
            });
        });
        document.getElementById('pp-sleep-cancel').addEventListener('click', e => {
            e.stopPropagation();
            Player.clearSleep();
            document.getElementById('pp-sleep-menu').classList.remove('open');
        });

        // Fullscreen player
        document.getElementById('fs-close').addEventListener('click', () => this.closeFullscreen());
        document.getElementById('fs-play').addEventListener('click', () => Player.toggle());
        document.getElementById('fs-rewind').addEventListener('click', () => Player.skip(-Player.skipDuration, 'fs-rewind-btn'));
        document.getElementById('fs-forward').addEventListener('click', () => Player.skip(Player.skipDuration, 'fs-forward-btn'));
        document.getElementById('fs-prev-ch').addEventListener('click', () => Player.prevChapter());
        document.getElementById('fs-next-ch').addEventListener('click', () => Player.nextChapter());

        const fsSeek = document.getElementById('fs-seek');
        fsSeek.addEventListener('mousedown', () => fsSeek.dataset.dragging = 'true');
        fsSeek.addEventListener('touchstart', () => fsSeek.dataset.dragging = 'true');
        fsSeek.addEventListener('input', () => {
            const ch = Player.getCurrentChapter();
            const dur = ch ? (ch.end - ch.start) : Player.getTotalDuration();
            const t = (fsSeek.value / 100) * dur;
            document.getElementById('fs-elapsed').textContent = formatTime(t);
        });
        fsSeek.addEventListener('change', () => {
            delete fsSeek.dataset.dragging;
            Player.seekToChapterPercent(parseFloat(fsSeek.value));
        });

        // FS sleep
        document.getElementById('fs-sleep').addEventListener('click', () => {
            document.getElementById('fs-sleep-menu').classList.toggle('open');
        });
        document.querySelectorAll('#fs-sleep-menu button[data-minutes]').forEach(btn => {
            btn.addEventListener('click', () => {
                const val = btn.dataset.minutes;
                Player.startSleep(val === 'chapter' ? 'chapter' : parseFloat(val));
                document.getElementById('fs-sleep-menu').classList.remove('open');
            });
        });
        document.getElementById('fs-sleep-cancel').addEventListener('click', () => {
            Player.clearSleep();
            document.getElementById('fs-sleep-menu').classList.remove('open');
        });

        // FS author → the author's page. Delegated, because the line is
        // rebuilt whenever the playing book changes.
        document.getElementById('fs-author').addEventListener('click', (e) => {
            const link = e.target.closest('.author-link');
            if (!link) return;
            // A podcast episode's line is its show: open the show's page.
            if (link.dataset.showId) {
                e.preventDefault();
                this.closeFullscreen();
                this.showItem(link.dataset.showId);
                return;
            }
            if (!link.dataset.authorId) return;
            e.preventDefault();
            this.closeFullscreen();
            this.showAuthorDetail(link.dataset.authorId, link.dataset.authorName);
        });

        // FS cover flip — tap cover to show file info on the back
        const coverWrap = document.getElementById('fs-cover-wrap');
        coverWrap.addEventListener('click', () => coverWrap.classList.toggle('is-flipped'));
        coverWrap.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); coverWrap.classList.toggle('is-flipped'); }
        });

        // FS description expand/collapse
        document.getElementById('fs-description-toggle').addEventListener('click', () => {
            const d = document.getElementById('fs-description');
            const btn = document.getElementById('fs-description-toggle');
            const collapsed = d.classList.toggle('is-collapsed');
            btn.textContent = collapsed ? 'Read more' : 'Show less';
        });

        // A podcast episode: its title opens the episode's page, and
        // Transcript opens it on the transcript, which follows the playhead.
        const openPlayingEpisode = (tab) => {
            const it = Player.item;
            if (!it?.episodeId) return;
            this.closeFullscreen();
            this.openEpisodeById(it.id, it.episodeId, { tab });
        };
        document.getElementById('fs-title').addEventListener('click', () => openPlayingEpisode('notes'));
        document.getElementById('fs-open-transcript').addEventListener('click', () => openPlayingEpisode('transcript'));

        // FS chapters (a page to the right — see showFsChapters)
        document.getElementById('fs-toggle-chapters').addEventListener('click', () => {
            this.showFsChapters(!document.getElementById('fs-player').classList.contains('chapters-open'));
        });
        document.getElementById('fs-chapters-back').addEventListener('click', () => this.showFsChapters(false));
        document.getElementById('fs-chapters-back-foot').addEventListener('click', () => this.showFsChapters(false));
        this._wireFsSwipe();
        this._wireContentGestures();
        this._wireInlineSearch();

        // Auto-reconnect when app resumes from background or regains network
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this._offlineMode && ABS.token) {
                this.retryConnect();
            }
            // Cross-device drift: if we were listening on the web while Pholia
            // was backgrounded, the cached currentTime is stale. Refetch the
            // server's progress and reseat the player — only when we're not
            // actively playing (live sync would clobber a server-side bump
            // anyway during playback). Cheap because getProgress is now a
            // single-item endpoint.
            if (document.visibilityState === 'visible' && ABS.token && !this._offlineMode) {
                this._refreshCurrentItemProgress();
                if (Date.now() - (this._librariesCheckedAt || 0) > 5 * 60 * 1000) this._refreshLibraries();
                this._podcastHousekeeping();
            }
        });
        // Podcast downloads kept current, and "played" marks made offline
        // delivered, a little after launch (clear of the cold-launch work).
        setTimeout(() => { if (ABS.token && !this._offlineMode) this._podcastHousekeeping(true); }, 15000);
        window.addEventListener('online', () => {
            if (ABS.token) setTimeout(() => this._podcastHousekeeping(true), 3000);
            if (this._offlineMode && ABS.token) {
                this.retryConnect();
            }
        });

        // Close sleep menu when clicking elsewhere
        document.addEventListener('click', e => {
            if (!e.target.closest('.pp-sleep-btn') && !e.target.closest('.pp-sleep-menu')) {
                document.getElementById('pp-sleep-menu').classList.remove('open');
            }
            if (!e.target.closest('.fs-sleep-btn') && !e.target.closest('.fs-sleep-menu')) {
                document.getElementById('fs-sleep-menu').classList.remove('open');
            }
        });
    },

    // ── Auth ──
    _offlineMode: false,

    // Single sign-on hand-off from the ABS_shim account/admin page. That page
    // opens Pholia with `#connect=<base64url JSON {s:server, u:username, t:token}>`
    // where the token is the member's ABS access token — the shim IS the ABS
    // server Pholia talks to, so its token is exactly our `pholia_token`. We
    // adopt those credentials and strip the fragment immediately so the token
    // doesn't linger in the address bar / history. tryAutoLogin() (called right
    // after) then finds the saved creds and signs in through the normal path,
    // replacing whatever server was previously active. A saved Pholia-account
    // vault, if any, is untouched. Returns true if a hand-off was consumed.
    _consumePholiaHandoff() {
        const m = (location.hash || '').match(/[#&]connect=([^&]+)/);
        if (!m) return false;
        let data = null;
        try {
            let s = m[1].replace(/-/g, '+').replace(/_/g, '/');
            while (s.length % 4) s += '=';
            data = JSON.parse(decodeURIComponent(escape(atob(s))));
        } catch (e) { data = null; }
        // Always clear the fragment, even if the payload was malformed.
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
        if (!data || !data.s || !data.t) return false;
        const server = String(data.s).replace(/\/+$/, '');
        ABS.saveCredentials(server, data.u || '', data.t);
        ABS.init(server, data.t);
        // The user is signed in but has no idea what their "server" is, and
        // the home-screen app they're about to install won't inherit this
        // session (separate storage partition). A passkey is the one thing
        // that crosses that boundary, so offer it now while we hold a token
        // to put in the vault. tryAutoLogin() shows the main UI first.
        this._pendingHandoffOffer = { serverUrl: server, username: data.u || '', token: data.t };
        return true;
    },

    // The installed app launches on the manifest's start_url, which carries
    // the server (and username) the user was signed into in Safari — see
    // functions/manifest.json.js. Adopt it as the login-form prefill unless
    // this partition already knows a server, and strip it from the URL.
    _consumeInstallHint() {
        const qs = new URLSearchParams(location.search || '');
        const server = (qs.get('server') || '').trim();
        if (!server) return;
        const user = (qs.get('u') || '').trim();
        if (/^https?:\/\//i.test(server) && !localStorage.getItem('pholia_server')) {
            localStorage.setItem('pholia_server', server.replace(/\/+$/, ''));
            if (user) localStorage.setItem('pholia_username', user);
        }
        qs.delete('server'); qs.delete('u');
        const rest = qs.toString();
        try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) {}
    },

    async tryAutoLogin() {
        this._consumeInstallHint();
        const savedServer = localStorage.getItem('pholia_server');
        const savedUser = localStorage.getItem('pholia_username');
        if (savedServer) document.getElementById('server-url').value = savedServer;
        if (savedUser) document.getElementById('username').value = savedUser;

        const creds = ABS.loadCredentials();
        if (creds) {
            // Paint from the previous launch's library list first (2026-09-20).
            // The list almost never changes, and awaiting /api/libraries here
            // kept the login screen up for a full round trip on every launch;
            // the home tab then paints from its persisted copy (see
            // _renderTab) so the shelves are up before the network answers.
            const cachedLibs = this._loadCachedLibraries(creds);
            if (cachedLibs) {
                this.libraries = cachedLibs;
                this._offlineMode = false;
                this.setupLibrarySelector();
                this.showMain();
                this._launchMark('shell');
                this.switchTab('home');
            }
            try {
                const libs = await this._fetchLibraries();
                this._launchMark('libraries');
                const changed = JSON.stringify(libs) !== JSON.stringify(this.libraries);
                this.libraries = libs;
                this._offlineMode = false;
                if (!cachedLibs) {
                    this.setupLibrarySelector();
                    this.showMain();
                    this._launchMark('shell');
                    this.switchTab('home');
                } else if (changed) {
                    // A library was added/removed/renamed: rebuild the picker
                    // and, if that moved us to a different library, re-render.
                    const before = this.currentLibraryId;
                    this.setupLibrarySelector();
                    if (this.currentLibraryId !== before) this.switchTab('home');
                }
                const offer = this._pendingHandoffOffer;
                this._pendingHandoffOffer = null;
                if (offer) setTimeout(() => this._maybeOfferSaveToAccount({ ...offer, handoff: true }), 400);
                else this._maybeRotateToken(creds);
                return;
            } catch (e) {
                if (e.status === 401 || e.status === 403) {
                    // Token expired — try silent re-login via the saved Pholia
                    // account credentials before kicking back to login screen.
                    ABS.token = '';
                    localStorage.removeItem('pholia_token');
                    if (await this._silentReloginViaAccount(savedServer, savedUser)) return;
                    // The cached shelves may already be up: back to the login screen.
                    document.getElementById('main-screen').classList.remove('active');
                    document.getElementById('login-screen').classList.add('active');
                    this._offerPasswordReset();
                } else {
                    // Network error or server down — keep credentials, show main UI
                    this._offlineMode = true;
                    // With cached shelves painted there's nothing better to show:
                    // the Downloaded row works, and visibilitychange/online retry.
                    if (cachedLibs) return;
                    this.showMain();
                    const serverLink = ABS.serverUrl || savedServer || '';
                    this.setContent(
                        '<div class="loading">' +
                        'Could not reach server. Your session is saved.' +
                        (serverLink ? `<br><a href="${serverLink}" target="_blank" style="color:var(--accent);font-size:0.85rem">Open server to test connection</a>` : '') +
                        '<br><button id="retry-connect" class="text-btn" style="margin-top:1rem;font-size:1rem">Retry</button>' +
                        '</div>'
                    );
                    document.getElementById('retry-connect')?.addEventListener('click', () => this.retryConnect());
                    return;
                }
            }
        }

        // No ABS creds (or token expired and no silent re-login). If we have
        // a Pholia account session, jump straight into the saved-servers
        // flow. Otherwise show the login screen with a Face ID button if the
        // device supports passkeys.
        if (Account.token()) {
            const me = await Account.whoami();
            if (me) {
                try {
                    const servers = await Account.listServers();
                    if (servers.length === 1) {
                        await this.loginFromAccount(servers[0]);
                        return;
                    }
                    if (servers.length > 1) {
                        this.showServerPicker(servers);
                        return;
                    }
                } catch {}
            }
        }
        await this.setupPasskeyButton();
    },

    // The library list from the last successful /api/libraries, keyed by
    // server + user so another account's libraries can never paint.
    _librariesKey(creds) { return `pholia_libraries:${creds.serverUrl}|${creds.username || ''}`; },
    _loadCachedLibraries(creds) {
        try {
            const v = JSON.parse(localStorage.getItem(this._librariesKey(creds)) || 'null');
            return Array.isArray(v) && v.length && v.every(l => l && l.id) ? v : null;
        } catch { return null; }
    },
    _saveCachedLibraries(creds, libs) {
        try { localStorage.setItem(this._librariesKey(creds), JSON.stringify(libs)); } catch {}
    },
    // Every path that loads the library list goes through here so the next
    // launch has a copy, whichever way this one signed in.
    // Re-read /api/libraries and rebuild the picker if the list changed: a
    // library or a shim library view added in /admin. Launch does the same
    // after painting from cache; this is for an app that stays open (Rescan,
    // and coming back to the foreground at most every 5 minutes).
    async _refreshLibraries() {
        this._librariesCheckedAt = Date.now();
        try {
            const libs = await this._fetchLibraries();
            if (JSON.stringify(libs) === JSON.stringify(this.libraries)) return;
            this.libraries = libs;
            const before = this.currentLibraryId;
            this.setupLibrarySelector();
            if (this.currentLibraryId !== before) this.switchTab('home');
        } catch { /* offline or server down: keep the list we have */ }
    },

    async _fetchLibraries() {
        const libs = await ABS.getLibraries();
        this._saveCachedLibraries({ serverUrl: ABS.serverUrl, username: localStorage.getItem('pholia_username') }, libs);
        return libs;
    },

    // ── Launch timing ──
    // Milestones in ms since navigation start, pushed into the audio event
    // ring buffer as `mark` events so they ship with crash logs and the
    // manual Send: html (index.html downloaded), js (scripts parsed),
    // shell (main screen shown), home-cached (persisted shelves painted),
    // libraries (/api/libraries answered), personalized (/personalized
    // answered), home (fresh shelves painted), scan (the fully-downloaded
    // scan finished; since 2026-09-20 the home paint no longer waits for
    // it, so scan may land well after home).
    // First occurrence only — later tab taps are not launches.
    _launchMarks: {},
    _launchMark(name) {
        if (this._launchMarks[name]) return;
        this._launchMarks[name] = true;
        Player._logMark('launch-' + name, Math.round(performance.now()));
    },

    // Keep a token-based session alive. A token from the ABS_shim hand-off
    // is the only credential a hand-off user has, locally AND in the vault,
    // and both copies expire on the same day — rotating only at vault
    // sign-in (loginFromAccount) would never run before that. So once the
    // local token is inside its last 20 days, trade it for a fresh one via
    // /api/authorize and push the new one into the vault entry too (only
    // where one already exists — a declined "save to account" must stay
    // declined). Tokens without a readable JWT exp are left alone.
    async _maybeRotateToken(creds) {
        const exp = this._tokenExpiry(creds.token);
        if (!exp || exp - Date.now() > 20 * 86400e3) return;
        try {
            await ABS.authorize(creds.serverUrl, creds.token);
        } catch { return; }
        if (!ABS.token || ABS.token === creds.token) return;
        ABS.saveCredentials(creds.serverUrl, creds.username, ABS.token);
        if (!Account.token()) return;
        try {
            const servers = await Account.listServers();
            const saved = servers.find(s => s.server_url === creds.serverUrl && s.username === creds.username);
            if (saved) await Account.saveServer({ server_url: creds.serverUrl, username: creds.username, token: ABS.token });
        } catch { /* vault unreachable — the local rotation still happened */ }
    },

    _tokenExpiry(token) {
        try {
            const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return payload.exp ? payload.exp * 1000 : null;
        } catch { return null; }
    },

    // Try to silently re-login to ABS using a password stored in the Pholia
    // account, without ever bouncing the user to the login screen. Returns
    // true on success.
    async _silentReloginViaAccount(serverUrl, username) {
        if (!Account.token() || !serverUrl || !username) return false;
        try {
            const servers = await Account.listServers();
            const match = servers.find(s => s.server_url === serverUrl && s.username === username)
                || servers.find(s => s.server_url === serverUrl);
            if (!match) return false;
            await this.loginFromAccount(match);
            return true;
        } catch { return false; }
    },

    async loginFromAccount(server) {
        let creds;
        try {
            creds = await Account.getServerCredentials(server.id);
        } catch (e) {
            this._showLoginScreenWithError(e.message || 'Could not load saved credentials');
            return;
        }
        try {
            if (creds.password) {
                await ABS.login(creds.server_url, creds.username, creds.password);
            } else if (creds.token) {
                // Token-only entry (ABS_shim hand-off). /api/authorize hands
                // back a fresh token, so re-save it: each sign-in pushes the
                // entry's expiry out by a full token lifetime.
                await ABS.authorize(creds.server_url, creds.token);
                if (ABS.token && ABS.token !== creds.token) {
                    Account.saveServer({ server_url: creds.server_url, username: creds.username, token: ABS.token }).catch(() => {});
                }
            } else {
                throw new Error('No saved credentials for this server.');
            }
            ABS.saveCredentials(creds.server_url, creds.username, ABS.token);
            this.libraries = await this._fetchLibraries();
            this._offlineMode = false;
            this.setupLibrarySelector();
            this.showMain();
            this.switchTab('home');
        } catch (e) {
            // Pre-fill the manual form with the saved server + username so
            // the user can submit it as a fallback once they've poked the
            // server via the link in the error. Browser password autofill
            // (saved against pholia.pages.dev, not the ABS server URL)
            // handles the password field on focus.
            this._showLoginScreenWithError(e.message || 'Login failed', {
                serverUrl: creds.server_url,
                username: creds.username,
            });
        }
    },

    _showLoginScreenWithError(message, prefill = {}) {
        document.getElementById('server-picker').classList.remove('active');
        document.getElementById('login-screen').classList.add('active');
        if (prefill.serverUrl) document.getElementById('server-url').value = prefill.serverUrl;
        if (prefill.username) document.getElementById('username').value = prefill.username;
        // Render as HTML so the "tap to open server" link from ABS.login
        // is tappable. Messages are constructed by our own code, never
        // user input.
        document.getElementById('login-error').innerHTML = message;
        this.setupPasskeyButton();
        this._offerPasswordReset();
    },

    async setupPasskeyButton() {
        const btn = document.getElementById('passkey-login-btn');
        const divider = document.getElementById('login-divider');
        // Show whenever the device supports platform passkeys — modern
        // passkeys sync via iCloud Keychain / Google Password Manager, so a
        // fresh browser window may still have access to a credential created
        // on another device. The local "registered on this device" flag was
        // hiding the button in exactly that case.
        const available = await Account.isPasskeyAvailable();
        if (available) {
            btn.classList.remove('hidden');
            divider.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
            divider.classList.add('hidden');
        }
    },

    showServerPicker(servers) {
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('server-picker').classList.add('active');
        const list = document.getElementById('server-picker-list');
        list.innerHTML = '';
        for (const s of servers) {
            const row = document.createElement('div');
            row.className = 'server-row';
            const label = s.label || s.username;
            row.innerHTML = `
                <div class="server-label"><span class="server-dot" aria-hidden="true"></span>${esc(label)}</div>
                <div class="server-sub">${esc(s.username)} · ${esc(s.server_url)}</div>
            `;
            row.addEventListener('click', () => this.loginFromAccount(s));
            list.appendChild(row);
            const dot = row.querySelector('.server-dot');
            this._probeServerOnline(s.server_url).then(online => {
                dot.classList.add(online ? 'online' : 'offline');
                row.title = online ? 'Server reachable' : 'Server not reachable';
            });
        }
    },

    // no-cors fetch resolves on any reachable response (opaque) and rejects
    // on DNS/network failure — perfect reachability signal that sidesteps
    // any CORS quirks on /ping.
    async _probeServerOnline(serverUrl) {
        if (!serverUrl) return false;
        const url = serverUrl.replace(/\/+$/, '') + '/ping';
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            await fetch(url, {
                method: 'GET',
                mode: 'no-cors',
                credentials: 'omit',
                cache: 'no-store',
                signal: ctrl.signal,
            });
            clearTimeout(timer);
            return true;
        } catch {
            return false;
        }
    },

    async handlePasskeyLogin() {
        const btn = document.getElementById('passkey-login-btn');
        const errorEl = document.getElementById('login-error');
        errorEl.textContent = '';
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Authenticating…';
        try {
            await Account.authenticateWithPasskey();
            const servers = await Account.listServers();
            if (servers.length === 0) {
                errorEl.textContent = 'No saved servers in your account — log in below to add one.';
            } else if (servers.length === 1) {
                await this.loginFromAccount(servers[0]);
            } else {
                this.showServerPicker(servers);
            }
        } catch (e) {
            const msg = e?.message || '';
            // User-cancelled the prompt — don't shout about it.
            if (!/Cancelled|NotAllowed/i.test(msg)) {
                errorEl.textContent = msg || 'Passkey sign-in failed';
            }
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    },

    // Refetch the loaded item's progress from the server and reseat the
    // playhead. Called from visibilitychange when not playing — handles the
    // "listened on the web while Pholia was backgrounded" drift. Also
    // refreshes the detail view if we're looking at the same item.
    async _refreshCurrentItemProgress() {
        const item = Player.item || this._currentDetailItem;
        // Not while Watch is open: an episode whose own file is the video
        // has its position written by the watching, ahead of the paused
        // player, and reseating here would start the audio under the video.
        if (!item || Player.isPlaying || this._watch) return;
        let progress;
        // An episode's progress is its own (the item id is the show's).
        try { progress = await ABS.getProgress(item.episodeId ? `${item.id}/${item.episodeId}` : item.id); } catch { return; }
        if (!progress) return;
        const serverTime = progress.currentTime || 0;
        // Only reseat the player if the server's time is meaningfully ahead
        // — the forward-only guard. Going backwards is almost always stale
        // data clobbering newer state. 5 s slack covers normal sync jitter.
        if (Player.item?.id === item.id && Player.item?.episodeId === item.episodeId) {
            const localTime = Player.getGlobalTime();
            if (serverTime > localTime + 5) Player.loadTime(serverTime);
        }
        // Re-render the detail view so the resume time / chapter highlight /
        // % complete reflect the new progress.
        if (!item.episodeId && this._currentDetailItem?.id === item.id && document.querySelector('.detail-view')) {
            this.showBookDetail(item);
        }
    },

    async retryConnect() {
        this.setContent('<div class="loading">Connecting...</div>');
        try {
            this.libraries = await this._fetchLibraries();
            this._offlineMode = false;
            this.setupLibrarySelector();
            this.switchTab('home');
        } catch (e) {
            if (e.status === 401 || e.status === 403) {
                // Token expired while offline — need to re-login
                ABS.token = '';
                localStorage.removeItem('pholia_token');
                document.getElementById('main-screen').classList.remove('active');
                document.getElementById('login-screen').classList.add('active');
                document.getElementById('login-error').textContent = 'Session expired. Please log in again.';
                this._offerPasswordReset();
            } else {
                this.setContent(
                    '<div class="loading">' +
                    'Still unable to reach server.' +
                    '<br><button id="retry-connect" class="text-btn" style="margin-top:1rem;font-size:1rem">Retry</button>' +
                    '</div>'
                );
                document.getElementById('retry-connect')?.addEventListener('click', () => this.retryConnect());
            }
        }
    },

    async handleLogin() {
        let serverUrl = document.getElementById('server-url').value.trim();
        if (serverUrl && !/^https?:\/\//i.test(serverUrl)) serverUrl = 'https://' + serverUrl;
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const errorEl = document.getElementById('login-error');
        errorEl.textContent = '';
        try {
            const data = await ABS.login(serverUrl, username, password);
            // Keep the server's own name for the account, not what was typed:
            // an ABS_shim also signs in with an email address here, and the
            // saved Face ID login, the install hint and the per-user caches
            // must all use one name or they split in two.
            const name = data?.user?.username || username;
            ABS.saveCredentials(serverUrl, name, ABS.token);
            this.libraries = await this._fetchLibraries();
            this.setupLibrarySelector();
            this.showMain();
            this.switchTab('home');
            // Defer the save-prompt slightly so the main UI is visible behind it.
            setTimeout(() => this._maybeOfferSaveToAccount({ serverUrl, username: name, password }), 400);
        } catch (e) {
            errorEl.innerHTML = e.message;
            this._offerPasswordReset();
        }
    },

    // "Forgot password?" under the login form, when the server in it is an
    // ABS_shim (its /status names its reset page; stock ABS has none). Opens
    // the shim's own page in the browser with the username filled in; after a
    // reset the shim signs every device out, and this form takes the new
    // password (and updates a saved Face ID entry, _maybeOfferSaveToAccount).
    async _offerPasswordReset() {
        const el = document.getElementById('login-forgot');
        let server = document.getElementById('server-url').value.trim();
        if (server && !/^https?:\/\//i.test(server)) server = 'https://' + server;
        const path = server ? await ABS.passwordResetPath(server) : null;
        if (!path) { el.classList.add('hidden'); return; }
        const u = document.getElementById('username').value.trim();
        document.getElementById('login-forgot-link').href =
            server.replace(/\/+$/, '') + path + (u ? '?u=' + encodeURIComponent(u) : '');
        el.classList.remove('hidden');
    },

    // After a successful manual ABS login, offer to save the credentials to
    // a Pholia account. If the user is already logged into a Pholia account,
    // save silently (they're adding another server). Otherwise show a modal
    // asking if they want to create one with a passkey.
    //
    // `token` instead of `password` is the hand-off case: the shim signed us
    // in with a token and there is no password to save. `handoff` rewords
    // the prompt for someone who arrived from their server's page and is
    // about to add Pholia to their Home Screen.
    async _maybeOfferSaveToAccount({ serverUrl, username, password, token, handoff }) {
        if (Account.token()) {
            try { await Account.saveServer({ server_url: serverUrl, username, password, token }); } catch {}
            return;
        }
        if (!await Account.isPasskeyAvailable()) return;
        this._pendingServerSave = { serverUrl, username, password, token };
        const title = document.getElementById('save-account-title');
        const text = document.getElementById('save-account-text');
        if (!this._saveAccountCopy) this._saveAccountCopy = { title: title.textContent, text: text.textContent };
        if (handoff) {
            title.textContent = 'Sign in with Face ID next time?';
            text.textContent = 'You\u2019re signed in from your server. Set up Face ID now and Pholia will ' +
                'sign you in without a password \u2014 including after you add it to your Home Screen ' +
                '(Share \u2192 Add to Home Screen), which otherwise starts signed out.';
        } else {
            title.textContent = this._saveAccountCopy.title;
            text.textContent = this._saveAccountCopy.text;
        }
        document.getElementById('save-account-modal').classList.remove('hidden');
    },

    async _confirmSaveToAccount() {
        const modal = document.getElementById('save-account-modal');
        const yesBtn = document.getElementById('save-account-yes');
        const orig = yesBtn.textContent;
        yesBtn.disabled = true;
        yesBtn.textContent = 'Setting up…';
        const pending = this._pendingServerSave;
        this._pendingServerSave = null;
        try {
            await Account.registerPasskey({ newAccount: true });
            if (pending) await Account.saveServer({
                server_url: pending.serverUrl,
                username: pending.username,
                password: pending.password,
                token: pending.token,
            });
        } catch (e) {
            const msg = e?.message || '';
            if (!/Cancelled|NotAllowed/i.test(msg)) {
                alert('Could not set up Pholia account: ' + msg);
            }
        } finally {
            yesBtn.disabled = false;
            yesBtn.textContent = orig;
            modal.classList.add('hidden');
        }
    },

    _dismissSaveToAccount() {
        document.getElementById('save-account-modal').classList.add('hidden');
        this._pendingServerSave = null;
    },

    showMain() {
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('server-picker').classList.remove('active');
        document.getElementById('main-screen').classList.add('active');
        // A notification tap waiting for sign-in. Deferred a task: every
        // caller runs switchTab('home') straight after this, which empties
        // the nav stack, and the episode page must land on top of it.
        setTimeout(() => this._maybeOpenPendingEpisode(), 0);
    },

    logout() {
        Player.pause();
        Player.closeCurrentSession();
        const savedServer = localStorage.getItem('pholia_server');
        const savedUser = localStorage.getItem('pholia_username');
        ABS.clearCredentials();
        this._clearPersistedTabs();
        this.hideSettings();
        document.getElementById('main-screen').classList.remove('active');
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('login-form').reset();
        if (savedServer) document.getElementById('server-url').value = savedServer;
        if (savedUser) document.getElementById('username').value = savedUser;
        this.navStack = [];
        // If a Pholia account is still signed in, show the picker — even when
        // there's only one saved server. Auto-logging into the sole server
        // here would be indistinguishable from "logout did nothing"; the user
        // can still pick it from the list, sign out of the account fully, or
        // hit "Add another server" for a manual connect to a different ABS.
        if (Account.token()) {
            Account.listServers().then(servers => {
                if (servers.length >= 1) this.showServerPicker(servers);
                else this.setupPasskeyButton();
            }).catch(() => this.setupPasskeyButton());
        } else {
            this.setupPasskeyButton();
        }
    },

    setupLibrarySelector() {
        const sel = document.getElementById('library-select');
        const container = document.getElementById('library-selector');
        sel.innerHTML = '';
        if (this.libraries.length <= 1) {
            container.classList.add('hidden');
        } else {
            container.classList.remove('hidden');
            this.libraries.forEach(lib => {
                const opt = document.createElement('option');
                opt.value = lib.id; opt.textContent = lib.name;
                sel.appendChild(opt);
            });
        }
        const saved = localStorage.getItem('pholia_library');
        if (saved && this.libraries.find(l => l.id === saved)) {
            this.currentLibraryId = saved;
            sel.value = saved;
        } else if (this.libraries.length) {
            this.currentLibraryId = this.libraries[0].id;
        }
        this.updateMediaType();
    },

    updateMediaType() {
        const lib = this.libraries.find(l => l.id === this.currentLibraryId);
        this.currentMediaType = lib?.mediaType || 'book';
        const isPodcast = this.currentMediaType === 'podcast';
        // Show/hide tabs based on media type
        document.querySelectorAll('[data-tab="series"], [data-tab="collections"], [data-tab="authors"]').forEach(el => {
            el.style.display = isPodcast ? 'none' : '';
        });
        const latestTab = document.querySelector('[data-tab="latest"]');
        if (latestTab) latestTab.style.display = isPodcast ? '' : 'none';
        const playlistsTab = document.querySelector('[data-tab="playlists"]');
        if (playlistsTab) playlistsTab.style.display = isPodcast ? '' : 'none';
        this.checkAbbSupport();
    },

    // ── Add audiobooks (ABS_shim only) ──
    //
    // The shim (github.com/jowtron/abs-shim) exposes /api/admin/abb/* for its
    // AudioBookBay → Real-Debrid → pCloud pipeline. Stock Audiobookshelf
    // 404s there, and a shim without a Real-Debrid token reports
    // rdTokenSet:false — in both cases the tab stays hidden. The flow is
    // browser-driven (resolve → add torrent(s) → poll → pCloud fetch), so
    // the rendered progress lives in a detached element that is re-attached
    // whenever the tab is shown; switching tabs mid-grab doesn't lose it.
    abbAvailable: false,
    isShim: false,     // server answers /api/admin/abb/settings → ABS_shim (enables the rescan setting)
    shimCanDelete: false, // …and says canDelete (tenant owner) → long-press delete-from-pCloud
    abbFolderId: null,
    shimCanAdd: false, // shim says the caller may add (ABB grabs; podcast subscribe on an older shim)
    shimFollows: false, // shim has personal podcast lists: follow / unfollow, hide per person
    shimCanSubscribe: false, // may follow podcasts: canSubscribe, else canGrab
    shimPreview: false, // shim stores a show without following it (canPreview): directory results open
    abbLibraryId: null,
    _abbRoot: null,

    async checkAbbSupport() {
        const btn = document.getElementById('abb-btn');
        let ok = false;
        try {
            const s = await ABS.request('/api/admin/abb/settings');
            this.isShim = !!s;
            // Older shims don't send the flags: treat missing as allowed so a
            // shim from before 2026-09-05 keeps working; the shim 403s anyway.
            this.shimCanDelete = !!s && s.canDelete !== false;
            this.shimCanAdd = !!s && s.canGrab !== false;
            // Personal podcast lists (2026-10-14): each member follows the
            // shows they want, so any member may subscribe, and the shim says
            // so with canSubscribe. Its presence is also the sign that
            // follows and per-person hiding exist; an older shim lacks it,
            // and there subscribing needs canGrab.
            this.shimFollows = !!s && typeof s.canSubscribe === 'boolean';
            this.shimCanSubscribe = this.shimFollows ? s.canSubscribe : this.shimCanAdd;
            this.shimPreview = !!s && s.canPreview === true;
            // A podcast library has no Add screen: its search finds podcasts
            // (_dirSearchOn). The header icon is AudioBookBay's alone.
            if (s && this.currentMediaType === 'podcast') {
                ok = false;
            } else if (s && s.rdTokenSet && s.canGrab !== false) {
                const st = await ABS.request('/api/admin/storage/status');
                const folders = (st?.folders || []).filter(f => f.provider === 'pcloud_oauth');
                const mine = folders.find(f => f.libraryId === this.currentLibraryId) || folders[0];
                if (mine) { ok = true; this.abbFolderId = mine.id; this.abbLibraryId = mine.libraryId; }
            }
        } catch { this.isShim = false; this.shimFollows = false; this.shimCanSubscribe = false; this.shimPreview = false; /* not a shim, or no access */ }
        if (this.isShim) this._pushStart();
        this.abbAvailable = ok;
        btn.classList.toggle('hidden', !ok);
        // A podcast library's empty Library offers the search once the shim
        // says the caller may follow.
        document.querySelectorAll('#content [data-find-podcasts]').forEach(el => el.classList.toggle('hidden', !this._dirSearchOn()));
        if (!ok && this.currentTab === 'add') this.switchTab('home');
    },

    // The Add screen is reached from the header icon rather than a bottom
    // tab, so it keeps 'add' as an internal tab state (cache keys, re-attach
    // of _abbRoot) but shows a back arrow that returns to the tab it was
    // opened from. Tapping the icon again also goes back.
    _addReturnTab: 'home',
    toggleAdd() {
        if (this.currentTab === 'add') { this.switchTab(this._addReturnTab); return; }
        this._addReturnTab = this.currentTab;
        this.switchTab('add');
    },

    // Like ABS.request, but surfaces the shim's JSON {error} message on 4xx/5xx
    // instead of a bare status line.
    async _shimCall(path, options = {}) {
        const headers = {};
        if (options.body) headers['Content-Type'] = 'application/json';
        const res = await fetch(ABS.apiUrl(path), { credentials: 'omit', ...options, headers: { ...headers, ...options.headers } });
        if (res.status === 204) return null;
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok) {
            // The status rides along: a 404 from a route an older shim
            // doesn't have means "hide this", not an error to show.
            const err = new Error((data && data.error) || `HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return data;
    },

    showAdd() {
        // Unreachable since 2026-10-18 (the icon is hidden there); a podcast
        // library finds podcasts through its search.
        if (this.currentMediaType === 'podcast') { this.switchTab(this._addReturnTab); this.showSearch(); return; }
        document.getElementById('header-title').textContent = 'Add audiobook';
        document.getElementById('back-btn').classList.remove('hidden');
        if (!this._abbRoot) {
            const root = document.createElement('div');
            root.className = 'abb-root';
            root.innerHTML =
                '<div class="search-bar abb-search"><span class="search-wrap"><input type="text" id="abb-q" placeholder="Search AudioBookBay…" autocomplete="off"><button type="button" class="search-clear" id="abb-clear" aria-label="Clear search">×</button></span><button id="abb-go" class="abb-go">Search</button></div>' +
                // Browse by category from the shim's AudioBookBay catalogue (a local
                // copy of ABB's listings; hidden until the shim has crawled something).
                '<div id="abb-browse" class="abb-browse hidden">' +
                  '<select id="abb-cat" aria-label="Category"><option value="">Latest</option></select>' +
                  // One language picker for both search and browse — a phone
                  // row can't carry two, and wanting English results in one
                  // but not the other isn't a real case.
                  '<select id="abb-lang" aria-label="Language (search and browse)"><option value="">Any language</option></select>' +
                  '<select id="abb-fmt" aria-label="Format"><option value="">Any format</option></select>' +
                  '<button id="abb-browse-go" class="abb-go">Browse</button>' +
                '</div>' +
                '<div id="abb-active" class="abb-active hidden"><div class="section-title">In progress</div><div id="abb-rd-progress" class="abb-progress"></div></div>' +
                '<div id="abb-results"></div>' +
                '<details id="abb-rd" class="abb-rd"><summary>On Real-Debrid <span id="abb-rd-count" class="text-muted"></span></summary>' +
                  '<p class="text-muted abb-pick-hint">Grabs run in this tab. If the app was closed mid-grab the torrents are still here — Finish collects a completed one, Watch resumes waiting, Delete removes it.</p>' +
                  '<div id="abb-rd-list" class="text-muted">Not loaded.</div>' +
                  '<button class="text-btn" id="abb-rd-refresh">Refresh</button>' +
                '</details>';
            const go = () => this.abbSearch(root.querySelector('#abb-q').value, root.querySelector('#abb-results'));
            root.querySelector('#abb-go').addEventListener('click', go);
            root.querySelector('#abb-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
            this._wireSearchClear(root.querySelector('#abb-q'), root.querySelector('#abb-clear'), () => { root.querySelector('#abb-results').innerHTML = ''; });
            root.querySelector('#abb-rd-refresh').addEventListener('click', () => this.abbLoadRdList());
            root.querySelector('#abb-rd').addEventListener('toggle', (e) => { if (e.target.open) this.abbLoadRdList(); });
            root.querySelector('#abb-browse-go').addEventListener('click', () => this.abbBrowse(1));
            root.querySelector('#abb-cat').addEventListener('change', () => this.abbBrowse(1));
            this._abbRoot = root;
        }
        const content = document.getElementById('content');
        this._topIfNewPage(content);
        content.innerHTML = '';
        content.appendChild(this._abbRoot);
        this.abbLoadRdList();
        this.abbLoadFacets();
    },

    // Category / language / format lists for the browse row. The shim's
    // catalogue endpoint 404s on an older shim — the row just stays hidden.
    async abbLoadFacets() {
        const root = this._abbRoot; if (!root) return;
        let f;
        try { f = await this._shimCall('/api/admin/abb/catalog/categories'); } catch { return; }
        if (!f || !f.total) return;
        const fill = (id, items, label) => {
            const sel = root.querySelector('#' + id);
            const prev = sel.value;
            while (sel.options.length > 1) sel.remove(1);
            for (const it of items) {
                const o = document.createElement('option');
                o.value = it.name;
                o.textContent = label(it.name) + ' (' + it.count.toLocaleString() + ')';
                sel.appendChild(o);
            }
            sel.value = prev;
        };
        fill('abb-cat', f.categories, (n) => n);
        fill('abb-lang', f.languages, (n) => n);
        fill('abb-fmt', f.formats, (n) => n.toUpperCase());
        // Default to English until the user picks something else: nearly
        // everything ABB posts is English, and a Dutch or Spanish re-post of
        // a popular title otherwise outranks the one they were after.
        const lang = root.querySelector('#abb-lang');
        if (!lang.value && !lang.dataset.touched && [...lang.options].some((o) => o.value === 'English')) lang.value = 'English';
        lang.addEventListener('change', () => { lang.dataset.touched = '1'; }, { once: true });
        root.querySelector('#abb-cat').options[0].textContent = 'Latest (' + f.total.toLocaleString() + ')';
        root.querySelector('#abb-browse').classList.remove('hidden');
    },

    // Newest-first page of the catalogue for the selected category. Renders
    // like search results (same Grab flow), with a Load more at the bottom.
    async abbBrowse(page) {
        const root = this._abbRoot; if (!root) return;
        const out = root.querySelector('#abb-results');
        const qs = new URLSearchParams({ page: String(page), limit: '30' });
        const cat = root.querySelector('#abb-cat').value;
        const lang = root.querySelector('#abb-lang').value;
        const fmt = root.querySelector('#abb-fmt').value;
        if (cat) qs.set('cat', cat);
        if (lang) qs.set('language', lang);
        if (fmt) qs.set('format', fmt);
        const more = out.querySelector('.abb-more');
        if (more) more.remove();
        if (page === 1) out.innerHTML = '<div class="loading">Loading…</div>';
        let r;
        try { r = await this._shimCall('/api/admin/abb/catalog/browse?' + qs.toString()); }
        catch (e) { out.innerHTML = `<div class="empty-state">Browse failed: ${esc(e.message)}</div>`; return; }
        if (page === 1) {
            out.innerHTML = '';
            if (!r.results.length) { out.innerHTML = '<div class="empty-state">Nothing in the catalogue for that yet — the shim adds more every few minutes.</div>'; return; }
        }
        this._abbRenderResults(r.results, out);
        this._abbBrowsePage = page;
        if (r.hasMore) {
            const b = document.createElement('button');
            b.className = 'text-btn abb-more';
            b.textContent = 'Load more';
            b.addEventListener('click', () => this.abbBrowse(this._abbBrowsePage + 1));
            out.appendChild(b);
        }
    },

    // '' when the browse row is hidden (an older shim with no catalogue).
    _abbLang() {
        const sel = this._abbRoot && this._abbRoot.querySelector('#abb-lang');
        return sel ? sel.value : '';
    },

    async abbSearch(q, out) {
        q = (q || '').trim();
        if (!q) return;
        out.innerHTML = '<div class="loading">Searching AudioBookBay…</div>';
        let r;
        try {
            // A pasted magnet link becomes a single pseudo-result.
            r = /^magnet:\?/i.test(q)
                ? { results: [{ title: this._magnetTitle(q), url: null, magnet: q, cover: null, format: null, bitrate: null, sizeBytes: null, language: '', posted: null }] }
                : await this._shimCall(`/api/admin/abb/search?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(this._abbLang())}`);
        } catch (e) {
            out.innerHTML = `<div class="empty-state">Search failed: ${esc(e.message)}</div>`;
            return;
        }
        if (!r.results.length) {
            out.innerHTML = r.language
                ? `<div class="empty-state">No ${esc(r.language)} results. Set the language picker to "Any language" to search everything.</div>`
                : '<div class="empty-state">No results</div>';
            return;
        }
        out.innerHTML = '';
        // Both notes can apply at once, so append rather than assign.
        if (r.filteredOut) {
            out.innerHTML += `<div class="text-muted abb-pick-hint">${r.filteredOut} result(s) hidden by the ${esc(r.language)} filter.</div>`;
        }
        if (r.liveError) {
            // The shim answered from its catalogue because AudioBookBay didn't respond.
            out.innerHTML += `<div class="text-muted abb-pick-hint">AudioBookBay didn't answer — showing cached results only.</div>`;
        }
        this._abbRenderResults(r.results, out);
    },

    // Shared by search and browse: appends result rows to the list in `out`
    // (creating it on first use) so browse's Load more can extend it.
    _abbRenderResults(results, out) {
        let ul = out.querySelector('ul.abb-list');
        if (!ul) {
            ul = document.createElement('ul');
            ul.className = 'tracklist abb-list';
            out.appendChild(ul);
        }
        for (const res of results) {
            const li = document.createElement('li');
            li.className = 'tracklist-item abb-item';
            // "⚡" = the magnet is cached on the shim, so Grab skips AudioBookBay.
            const sub = res.magnet ? 'Magnet link' : [res.inLibrary ? '✓ In library' : null, res.format ? res.format.toUpperCase() : null, res.bitrate, res.sizeBytes ? formatBytes(res.sizeBytes) : null, res.language, res.posted ? 'Posted ' + res.posted : null, res.infoHash ? '⚡' : null].filter(Boolean).join(' • ');
            li.innerHTML =
                '<div class="abb-main">' +
                  '<img class="ep-cover abb-cover" alt="" loading="lazy" referrerpolicy="no-referrer">' +
                  '<span class="tracklist-title"><strong></strong><br><span class="text-muted"></span></span>' +
                  '<button class="abb-grab">Grab</button>' +
                '</div>' +
                '<div class="abb-details"></div>' +
                '<div class="abb-progress"></div>';
            const img = li.querySelector('.abb-cover');
            if (res.cover && /^https?:/.test(res.cover)) {
                img.src = res.cover;
                img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
            } else {
                img.style.visibility = 'hidden';
            }
            li.querySelector('strong').textContent = res.title;
            li.querySelector('.text-muted').textContent = sub;
            // Tap the title → blurb + written by / read by (fetched once);
            // tap the cover → the full-size source image in a lightbox.
            const details = li.querySelector('.abb-details');
            if (res.url) li.querySelector('.tracklist-title').addEventListener('click', () => this.abbToggleDetails(res, details));
            if (res.cover) img.addEventListener('click', () => this._abbLightbox(res.coverOrig || res.cover, res.coverCached ? res.cover : null));
            // A dead image host falls back to the shim's cached copy (and vice versa).
            if (res.coverOrig && res.coverCached) img.addEventListener('error', () => { if (img.src !== res.coverOrig) img.src = res.coverOrig; }, { once: true });
            const btn = li.querySelector('.abb-grab');
            if (res.inLibrary) { btn.textContent = 'Again'; btn.title = 'Already in your library — grab again anyway'; btn.classList.add('abb-grab-again'); }
            const prog = li.querySelector('.abb-progress');
            btn.addEventListener('click', () => {
                btn.disabled = true;
                btn.innerHTML = '<span class="abb-spinner"></span>Grabbing…';
                this.abbGrab(res, prog).then((ok) => {
                    btn.textContent = ok ? 'Added ✓' : 'Retry';
                    btn.disabled = !!ok;
                    this.abbLoadRdList();
                    if (ok) { this._invalidateTabCache(); }  // library/home tabs re-fetch to show the new book
                });
            });
            ul.appendChild(li);
        }
    },

    async abbLoadRdList() {
        const root = this._abbRoot; if (!root) return;
        const box = root.querySelector('#abb-rd-list');
        const count = root.querySelector('#abb-rd-count');
        box.textContent = 'Loading…';
        let r;
        try { r = await this._shimCall('/api/admin/abb/torrents'); }
        catch (e) { box.textContent = "Couldn't list: " + e.message; return; }
        // One row per release — the grab flow adds one RD torrent per file.
        const all = this._abbGroupTorrents(r.torrents || []);
        const hidden = this._abbRdShowAll ? [] : all.filter(g => this._abbLooksVideo(g.filename));
        const groups = this._abbRdShowAll ? all : all.filter(g => !this._abbLooksVideo(g.filename));
        count.textContent = all.length ? `(${groups.length}${hidden.length ? ' + ' + hidden.length + ' video' : ''})` : '';
        box.innerHTML = '';
        if (!groups.length) box.innerHTML = `<div class="text-muted">${all.length ? 'Nothing audiobook-looking on Real-Debrid.' : 'Nothing on Real-Debrid.'}</div>`;
        if (hidden.length || this._abbRdShowAll) {
            const t = document.createElement('button');
            t.className = 'text-btn';
            t.textContent = this._abbRdShowAll ? 'Hide video torrents' : `Show ${hidden.length} hidden video torrent${hidden.length === 1 ? '' : 's'}`;
            t.addEventListener('click', () => { this._abbRdShowAll = !this._abbRdShowAll; this.abbLoadRdList(); });
            box.appendChild(t);
        }
        if (!groups.length) return;
        const listEl = root.querySelector('#abb-rd-progress');
        for (const g of groups) {
            const el = document.createElement('div');
            el.className = 'abb-row abb-rd-item';
            el.innerHTML = '<div class="abb-row-text"><span class="abb-row-name"></span><span class="abb-row-status text-muted"></span></div><div class="abb-rd-actions"></div>';
            el.querySelector('.abb-row-name').textContent = `${g.filename} · ${g.torrents.length} torrent${g.torrents.length === 1 ? '' : 's'}${g.bytes ? ' · ' + formatBytes(g.bytes) : ''}`;
            el.querySelector('.abb-row-status').textContent = ' · ' + g.summary;
            const acts = el.querySelector('.abb-rd-actions');
            const act = (label, fn) => { const b = document.createElement('button'); b.className = 'abb-row-btn'; b.textContent = label; b.addEventListener('click', async () => { b.disabled = true; await fn(); this.abbLoadRdList(); }); acts.appendChild(b); };
            if (g.live.length) {
                act('Choose files…', () => this.abbResumeGroup(g, listEl, true));
                act(g.allDone ? 'Finish' : 'Watch', () => this.abbResumeGroup(g, listEl, false));
            }
            act('Delete', () => Promise.all(g.torrents.map(t => this._shimCall('/api/admin/abb/torrents/' + encodeURIComponent(t.id), { method: 'DELETE' }).catch(() => {}))));
            box.appendChild(el);
        }
    },

    // Hide TV/film torrents by name unless asked (see shim /admin).
    _abbVideoRe: /\b(2160p|1080[pi]|720p|480p|4k|uhd|x26[45]|h\.?26[45]|hevc|av1|xvid|divx|blu-?ray|bdrip|brrip|web-?dl|webrip|hdtv|hdrip|dvdrip|remux|hdr(10\+?)?|dolby[\s.]?vision|sdr|s\d{1,2}e\d{1,3}|season\s?\d+|complete series|yify|yts|rarbg|dts(-hd)?|truehd|atmos|ddp?\s?[57]\.1|aac\s?[57]\.1)\b|\.(mkv|mp4|avi|m2ts|ts)$/i,
    _abbAudioRe: /\b(audiobook|unabridged|abridged|narrated|m4b|mp3)\b/i,
    _abbLooksVideo(name) { return this._abbVideoRe.test(name) && !this._abbAudioRe.test(name); },
    _abbRdShowAll: false,

    _abbGroupTorrents(torrents) {
        const byHash = new Map();
        for (const t of torrents) {
            const key = t.hash || t.id;
            if (!byHash.has(key)) byHash.set(key, { hash: t.hash, filename: t.filename, torrents: [], bytes: 0 });
            const g = byHash.get(key);
            g.torrents.push(t); g.bytes += t.bytes || 0;
        }
        return [...byHash.values()].map(g => {
            g.live = g.torrents.filter(t => !t.error);
            g.allDone = g.live.length > 0 && g.live.every(t => t.status === 'downloaded');
            const done = g.live.filter(t => t.status === 'downloaded').length;
            const errs = g.torrents.length - g.live.length;
            const dl = g.live.filter(t => t.status !== 'downloaded');
            const pct = dl.length ? Math.round(dl.reduce((s, t) => s + (t.progress || 0), 0) / dl.length) : null;
            const seeders = dl.length ? Math.max(...dl.map(t => t.seeders || 0)) : null;
            g.summary = [`${done} / ${g.torrents.length} ready`, pct != null ? `downloading ${pct}%` : null, seeders != null ? `${seeders} seeders` : null, errs ? `${errs} failed` : null].filter(Boolean).join(' · ');
            return g;
        });
    },

    // Resume a release this tab didn't start; with `pick`, re-offer the file
    // picker (currently selected files pre-ticked), deleting torrents for
    // unticked files and adding torrents for newly ticked ones from the hash.
    async abbResumeGroup(g, listEl, pick) {
        const active = this._abbRoot.querySelector('#abb-active');
        active.classList.remove('hidden');
        active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const row = this._abbRow(listEl, g.filename, 'Checking on Real-Debrid…');
        try {
            const infos = [];
            for (const t of g.live) {
                const st = await this._shimCall('/api/admin/abb/torrents/' + encodeURIComponent(t.id));
                if (st.error && !st.downloads) { this._abbRow(listEl, 'RD ' + t.id, '').fail(st.error); continue; }
                infos.push(st);
            }
            if (!infos.length) throw new Error('No usable torrents in this group');
            const allFiles = infos[0].files || [];
            const byFile = new Map();
            for (const st of infos) for (const f of st.selectedFiles || []) byFile.set(f.id, st.id);
            let chosen = allFiles.filter(f => byFile.has(f.id));
            if (pick) {
                const candidates = allFiles.filter(f => f.isAudio || f.isArchive).map(f => ({ ...f, selected: byFile.has(f.id) }));
                if (!candidates.length) throw new Error('Torrent contains no audio files');
                row.setStatus('Choose which files to keep…');
                chosen = await this.abbPickFiles(g.filename, candidates, true);
                if (!chosen) { row.fail('Cancelled'); return; }
            }
            if (!chosen.length) throw new Error('Nothing selected');
            const want = new Set(chosen.map(f => f.id));
            const hash = infos[0].hash || g.hash;
            for (const st of infos) {
                const covers = (st.selectedFiles || []).map(f => f.id);
                if (covers.length && !covers.some(id => want.has(id))) {
                    await this._shimCall('/api/admin/abb/torrents/' + encodeURIComponent(st.id), { method: 'DELETE' }).catch(() => {});
                    covers.forEach(id => byFile.delete(id));
                }
            }
            const missing = chosen.filter(f => !byFile.has(f.id));
            if (missing.length) {
                row.setStatus(`Adding ${missing.length} torrent(s) to Real-Debrid…`);
                const magnet = 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(g.filename);
                for (const f of missing) {
                    try { const a = await this._abbAddPaced(magnet, f.id, row, `Adding ${missing.indexOf(f) + 1} / ${missing.length}`); byFile.set(f.id, a.id); }
                    catch (e) { this._abbRow(listEl, f.path, '').fail('Add failed: ' + e.message); }
                    await this._sleep(this._RD_ADD_PACE_MS);
                }
            }
            const san = s => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'audiobook';
            // RD renames a torrent to its selected file, so a resumed
            // one-file-per-torrent grab reports "Book-Part04.mp3" as the
            // name; using that as the folder scattered one book across three
            // directories. `originalFilename` is the torrent's own name.
            let groupName = san(infos[0].originalFilename || g.filename);
            // Finishing a release from the On Real-Debrid panel because the
            // first pass missed tracks: reuse the folder it went to, so the
            // stragglers join the book instead of starting a second copy.
            const groupHash = (infos[0].hash || g.hash || '').toLowerCase();
            try {
                const prior = await this._shimCall('/api/admin/abb/grabs?hash=' + encodeURIComponent(groupHash));
                if (prior && prior.previous && prior.previous.dest) {
                    groupName = prior.previous.dest;
                    row.setStatus(`Topping up “${groupName}” — where this release went before`);
                }
            } catch (e) { /* courtesy check only */ }
            const plan = this.abbPlanDest(groupName, chosen.filter(f => byFile.has(f.id)));
            const byTorrent = new Map();
            for (const p of plan) { const tid = byFile.get(p.id); if (!byTorrent.has(tid)) byTorrent.set(tid, p.dest); }
            const torrents = [...byTorrent].map(([id, dest]) => ({ id, dest }));
            if (!torrents.length) throw new Error('Nothing to track');
            row.setStatus(`${torrents.length} torrent(s) — waiting for Real-Debrid`);
            await this.abbTrackTorrents(torrents, this.abbFolderId, listEl, row, { hash: groupHash, title: groupName });
        } catch (e) {
            row.fail(e.message || String(e));
        }
    },

    _magnetTitle(magnet) {
        try { return (new URL(magnet).searchParams.get('dn') || '').replace(/\+/g, ' ').trim() || 'Magnet link'; } catch { return 'Magnet link'; }
    },

    // Full-size linked image first; if that host is gone, the cached webp.
    _abbLightbox(src, fallback) {
        const box = document.createElement('div');
        box.className = 'abb-lightbox';
        const img = document.createElement('img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        if (fallback && fallback !== src) img.addEventListener('error', () => { img.src = fallback; }, { once: true });
        img.src = src;
        box.appendChild(img);
        box.addEventListener('click', () => box.remove());
        document.body.appendChild(box);
    },

    async abbToggleDetails(res, box) {
        if (box.childNodes.length) { box.innerHTML = ''; box._loaded = false; return; }
        box.innerHTML = '<div class="meta"><span class="abb-spinner"></span>Loading description…</div>';
        try {
            const d = await this._shimCall(`/api/admin/abb/details?url=${encodeURIComponent(res.url)}`);
            const meta = [
                d.author ? 'Written by ' + d.author : null,
                d.narrators?.length ? 'Read by ' + d.narrators.join(', ') : null,
                d.format, d.bitrate, d.length,
                d.abridged === true ? 'Abridged' : d.abridged === false ? 'Unabridged' : null,
            ].filter(Boolean).join(' · ');
            const paras = (d.description || '').split(/\n\n+/).filter(Boolean);
            box.innerHTML = `<div class="meta">${esc(meta)}</div>` +
                (paras.length ? paras.map(p => `<p>${esc(p)}</p>`).join('') : '<p class="text-muted">No description on the listing.</p>');
        } catch (e) {
            box.innerHTML = `<div class="meta">Couldn't load details: ${esc(e.message)}</div>`;
        }
    },

    // Long press (≈550 ms, finger not moving) or right-click. Sets a flag so
    // the click that follows the release is swallowed by the tap handler.
    _wireLongPress(el, fn) {
        let timer = null, sx = 0, sy = 0;
        const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            sx = e.clientX; sy = e.clientY;
            clear();
            timer = setTimeout(() => { timer = null; el._longPressed = true; fn(); }, 550);
        });
        el.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clear(); });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, clear));
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); clear(); el._longPressed = true; fn(); });
    },

    confirmDeleteItem(itemId, title, item) {
        const overlay = document.createElement('div');
        overlay.className = 'modal confirm-modal';
        overlay.innerHTML =
            '<div class="modal-content modal-narrow">' +
              '<div class="modal-header"><h3>Delete from pCloud?</h3></div>' +
              '<div class="modal-body"><p class="confirm-title"></p><p class="text-muted confirm-detail">Loading…</p><p class="text-muted confirm-text">Removes the book from the library <b>and permanently deletes its audio file(s) from pCloud</b>. Listening progress is lost. This cannot be undone.</p></div>' +
              '<div class="modal-actions"><button class="text-btn" data-cancel>Cancel</button><button class="danger-btn" data-ok>Delete</button></div>' +
            '</div>';
        overlay.querySelector('.confirm-title').textContent = title;
        // Format / length / file count so "which Secret is this?" is obvious
        // when the same book exists as mp3 and m4b. Cards don't carry it,
        // so fetch the item unless the caller (book page) already has it.
        const detail = overlay.querySelector('.confirm-detail');
        (item ? Promise.resolve(item) : ABS.getItem(itemId)).then(it => {
            const parts = [this._formatLabel(it), it?.media?.duration ? formatTime(it.media.duration) : null, it?.media?.metadata?.authorName].filter(Boolean);
            detail.textContent = parts.join(' · ') || '';
        }).catch(() => { detail.textContent = ''; });
        const close = () => overlay.remove();
        overlay.querySelector('[data-cancel]').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('[data-ok]').addEventListener('click', async () => {
            const ok = overlay.querySelector('[data-ok]');
            ok.disabled = true; ok.textContent = 'Deleting…';
            try {
                const r = await this._shimCall(`/api/admin/items/${encodeURIComponent(itemId)}?deleteFiles=1`, { method: 'DELETE' });
                try { await Offline.deleteBook({ id: itemId, media: { tracks: [] } }); } catch { /* no offline copy */ }
                close();
                this._invalidateTabCache();
                this.switchTab(this.currentTab);
                if (r && r.reason) alert(r.reason);
            } catch (e) {
                ok.disabled = false; ok.textContent = 'Delete';
                overlay.querySelector('.confirm-text').textContent = 'Delete failed: ' + (e.message || e);
            }
        });
        document.body.appendChild(overlay);
    },

    _abbRow(listEl, name, status) {
        const el = document.createElement('div');
        el.className = 'abb-row';
        el.innerHTML = '<div class="abb-row-text"><span class="abb-row-name"></span><span class="abb-row-status text-muted"></span></div><div class="abb-bar"><span></span></div>';
        el.querySelector('.abb-row-name').textContent = name;
        const st = el.querySelector('.abb-row-status');
        const bar = el.querySelector('.abb-bar > span');
        st.textContent = status ? ' · ' + status : '';
        listEl.appendChild(el);
        return {
            setStatus(t) { st.textContent = ' · ' + t; },
            setProgress(done, total) {
                const pct = total ? Math.round(done / total * 100) : 0;
                bar.style.width = pct + '%';
                st.textContent = ` · ${pct}% (${formatBytes(done)} / ${formatBytes(total)})`;
            },
            setPct(pct) { bar.style.width = Math.max(0, Math.min(100, pct)) + '%'; },
            complete(t) { el.classList.add('ok'); bar.style.width = '100%'; st.textContent = ' · ' + (t || 'Done'); },
            fail(t) { el.classList.add('err'); st.textContent = ' · ' + (t || 'Failed'); },
            addButton(label, onClick) {
                const b = document.createElement('button');
                b.className = 'abb-row-btn';
                b.textContent = label;
                b.addEventListener('click', onClick);
                el.querySelector('.abb-row-text').appendChild(b);
                return () => b.remove();
            },
        };
    },

    // Real-Debrid's torrents endpoints allow roughly one request a second
    // per API key and one add spends several of them (addMagnet, info polls,
    // selectFiles). A 29-file release added two at a time lost most of its
    // files to "Real-Debrid 429: too_many_requests" (2026-09-05), each
    // needing a manual Retry tap. So adds go one at a time with a gap, and a
    // 429 waits it out and retries itself — the user is not the retry
    // mechanism. The shim already retries a 429 four times over ~37 s, so
    // this ladder waits in minutes.
    _RD_ADD_PACE_MS: 1200,
    _RD_RETRY_WAITS_MS: [15000, 30000, 60000, 60000, 120000],

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    async _abbAddPaced(magnet, fileId, row, label) {
        const add = () => this._shimCall('/api/admin/abb/torrents', { method: 'POST', body: JSON.stringify({ magnet, fileId }) });
        for (let attempt = 0; ; attempt++) {
            try { return await add(); }
            catch (e) {
                const rate = /429|too_many/i.test(e?.message || '');
                const wait = rate ? this._RD_RETRY_WAITS_MS[attempt] : null;
                if (wait == null) throw e;
                for (let left = Math.round(wait / 1000); left > 0; left--) {
                    row.setStatus(`${label} — Real-Debrid is rate-limiting, retrying in ${left}s`);
                    await this._sleep(1000);
                }
            }
        }
    },

    // The 40-hex info hash from a magnet — how a release is recognised on a
    // later pass, whatever Real-Debrid is calling it by then.
    _abbHash(magnet) {
        const m = /btih:([0-9a-fA-F]{40})/.exec(magnet || '');
        return m ? m[1].toLowerCase() : '';
    },

    async abbGrab(res, listEl) {
        const folderId = this.abbFolderId;
        const row = this._abbRow(listEl, 'Real-Debrid', res.magnet ? 'Reading magnet…' : 'Resolving on AudioBookBay…');
        try {
            const m = await this._shimCall('/api/admin/abb/resolve', { method: 'POST', body: JSON.stringify(res.magnet ? { magnet: res.magnet } : { url: res.url }) });
            row.setStatus('Asking Real-Debrid what’s in it…');
            const peek = await this._shimCall('/api/admin/abb/torrents', { method: 'POST', body: JSON.stringify({ magnet: m.magnet, inspect: true }) });
            const candidates = (peek.files || []).filter(f => f.isAudio || f.isArchive);
            if (!candidates.length) throw new Error('Torrent contains no audio files');
            let chosen = candidates;
            if (candidates.length > 1) {
                row.setStatus('Choose which files to grab…');
                chosen = await this.abbPickFiles(peek.name || m.title, candidates);
                if (!chosen) { row.fail('Cancelled'); return false; }
            }
            // Been here before? A second pass to pick up tracks the first one
            // missed has to go back to the SAME folder, or the library gains a
            // second, differently-incomplete copy of the book.
            const hash = this._abbHash(m.magnet);
            let dest = m.folderName;
            let prior = null;
            try {
                prior = await this._shimCall('/api/admin/abb/grabs?hash=' + encodeURIComponent(hash)
                    + '&title=' + encodeURIComponent(m.title || '')
                    + '&folderName=' + encodeURIComponent(m.folderName || ''));
            } catch (e) { /* courtesy check — never block a grab on it */ }
            if (prior && prior.previous && prior.previous.dest) {
                dest = prior.previous.dest;
                row.setStatus(`Already grabbed before — topping up “${dest}”`);
            } else if (prior && prior.matches && prior.matches.length) {
                const lines = prior.matches.map(mm => `• ${mm.topFolder} (${mm.files} file(s), ${(mm.seconds/3600).toFixed(1)}h) — ${mm.reason}`);
                if (!confirm('This looks like a book you already have:\n\n' + lines.join('\n')
                    + '\n\nGrab it again anyway? It will download a second copy to pCloud.')) {
                    row.fail('Cancelled — already in the library');
                    return false;
                }
            }
            const plan = this.abbPlanDest(dest, chosen);
            row.setStatus(`Adding ${plan.length} torrent(s) to Real-Debrid…`);
            // A manual Retry is still offered once the automatic ladder above
            // gives up, since by then something other than pacing is wrong.
            const torrents = [];
            const retryAdd = (p) => {
                const r = this._abbRow(listEl, p.dest, '');
                const retry = () => {
                    r.setStatus('Adding to Real-Debrid…');
                    this._abbAddPaced(m.magnet, p.id, r, 'Adding')
                        .then((a) => { removeBtn(); return this.abbTrackTorrents([{ id: a.id, dest: p.dest }], folderId, listEl, r, { hash, title: m.title }); })
                        .then((ok) => { this.abbLoadRdList(); if (ok) this._invalidateTabCache(); })
                        .catch((e) => r.fail('Add failed: ' + e.message));
                };
                let removeBtn = r.addButton('Retry', retry);
                return r;
            };
            for (let i = 0; i < plan.length; i++) {
                const p = plan[i];
                const label = `Adding ${i + 1} / ${plan.length}`;
                row.setStatus(label + '…');
                try {
                    const a = await this._abbAddPaced(m.magnet, p.id, row, label);
                    torrents.push({ id: a.id, dest: p.dest });
                } catch (e) {
                    retryAdd(p).fail('Add failed: ' + e.message);
                }
                row.setStatus(`Added ${torrents.length} / ${plan.length} torrent(s)…`);
                if (i + 1 < plan.length) await this._sleep(this._RD_ADD_PACE_MS);
            }
            if (!torrents.length) throw new Error('Nothing could be added to Real-Debrid');
            row.setStatus(`${torrents.length} torrent(s) — waiting for Real-Debrid`);
            return await this.abbTrackTorrents(torrents, folderId, listEl, row, { hash, title: m.title });
        } catch (e) {
            row.fail(e.message || String(e));
            return false;
        }
    },

    // Shared tail of a grab (also used to resume a torrent this tab didn't
    // start): poll, hand finished files to pCloud, delete on RD, scan.
    async abbTrackTorrents(torrents, folderId, listEl, row, source) {
        try {
            // Cancel deletes whatever is still on RD; a torrent whose progress
            // hasn't moved for 20 min (no seeders) is given up on the same way.
            const interval = Math.max(4000, torrents.length * 600);
            const STALL_MS = 20 * 60 * 1000;
            const pending = new Map(torrents.map(t => [t.id, { row: this._abbRow(listEl, t.dest, 'Queued'), dest: t.dest, lastProgress: -1, lastChangeAt: Date.now() }]));
            const fetches = [];
            let needsScan = false;
            let cancelled = false;
            // No automatic torrent deletion anywhere in this flow: Real-Debrid
            // expires old torrents on its own, and auto-deleting on failure
            // destroyed the only way to retry a grab (The Secret, 2026-08-24).
            // Only the explicit Delete button in the On Real-Debrid panel
            // (and deselecting files in the picker) removes torrents.
            const removeCancel = row.addButton('Cancel', () => { cancelled = true; });
            while (pending.size) {
                await new Promise(r => setTimeout(r, interval));
                if (cancelled) {
                    for (const [, p] of pending) p.row.fail('Cancelled');
                    pending.clear();
                    removeCancel();
                    row.fail('Cancelled — torrents left on Real-Debrid (resume from the On Real-Debrid panel)');
                    return false;
                }
                for (const [id, p] of [...pending]) {
                    let st;
                    try { st = await this._shimCall('/api/admin/abb/torrents/' + encodeURIComponent(id)); }
                    catch (e) { p.row.setStatus('Poll error: ' + e.message); continue; }
                    if (st.error && !st.downloads) { p.row.fail(st.error); pending.delete(id); continue; }
                    if (st.progress !== p.lastProgress) { p.lastProgress = st.progress; p.lastChangeAt = Date.now(); }
                    else if (st.status !== 'downloaded' && Date.now() - p.lastChangeAt > STALL_MS) {
                        p.row.fail(`No progress for 20 min (${st.seeders || 0} seeders) — gave up; it's still on Real-Debrid to retry later`);
                        pending.delete(id); continue;
                    }
                    if (st.status === 'downloaded' && st.downloads) {
                        pending.delete(id);
                        p.row.complete('Ready on Real-Debrid');
                        fetches.push((async () => {
                            for (const d of st.downloads) {
                                if (!d.isAudio && !d.isArchive) continue;
                                if (d.ext === 'rar' || d.ext === '7z') {
                                    this._abbRow(listEl, d.filename, '').fail(`Real-Debrid produced a ${d.ext}; extract it via the shim's browser upload`);
                                    continue;
                                }
                                const registered = await this.abbFetchToPcloud(folderId, d.download, p.dest, listEl, source);
                                if (!registered) needsScan = true;
                            }
                        })());
                    } else {
                        p.row.setStatus(`${st.status} ${typeof st.progress === 'number' ? st.progress + '%' : ''}${st.seeders != null ? ' · ' + st.seeders + ' seeders' : ''}${st.speed ? ' · ' + formatBytes(st.speed) + '/s' : ''}`);
                        if (typeof st.progress === 'number') p.row.setPct(st.progress);
                    }
                }
            }
            removeCancel();
            await Promise.all(fetches);
            if (!fetches.length) { row.fail('Nothing downloaded'); return false; }
            // The shim's /fetch-url/finish only registers single m4b/m4a/aac
            // files; mp3 releases are N chapter files that need a library scan
            // once they've all landed. Skipped when every file registered via
            // /finish — a scan racing another grab's registration is how
            // duplicates appeared on 2026-08-23.
            if (this.abbLibraryId && needsScan) {
                row.setStatus('Scanning library…');
                try {
                    const report = await this._shimCall(`/api/admin/libraries/${encodeURIComponent(this.abbLibraryId)}/scan`, { method: 'POST' });
                    row.complete(`Done — scan added ${report.added || 0} new book(s)`);
                } catch (e) {
                    row.complete('Done, but the library scan failed: ' + e.message);
                }
            } else {
                row.complete('Done');
            }
            return true;
        } catch (e) {
            row.fail(e.message || String(e));
            return false;
        }
    },

    // Where each chosen file lands on pCloud (mirrors the shim /admin logic):
    // collapse the dirs every chosen file shares to the deepest one, keep
    // sub-folders below it (one book per folder), and give m4b siblings
    // their own folder so the scanner doesn't read them as one broken book.
    abbPlanDest(folderName, files) {
        const san = s => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
        const split = files.map(f => f.path.split('/').filter(Boolean));
        let depth = 0;
        while (split.every(p => p.length > depth + 1 && p[depth] === split[0][depth])) depth++;
        const top = depth > 0 ? san(split[0][depth - 1]) : san(folderName);
        const rels = split.map(p => [top, ...p.slice(depth)].map(san));
        const dirOf = r => r.slice(0, -1).join('/');
        return files.map((f, i) => {
            const r = rels[i];
            const name = r[r.length - 1];
            const siblings = rels.filter((o, j) => j !== i && dirOf(o) === dirOf(r) && /\.(m4b|m4a|aac|mp3|flac|ogg|opus)$/i.test(o[o.length - 1]));
            const dest = /\.(m4b|m4a|aac)$/i.test(name) && siblings.length
                ? [...r.slice(0, -1), name.replace(/\.[^.]+$/, ''), name].join('/')
                : r.join('/');
            return { id: f.id, dest, bytes: f.bytes };
        });
    },

    // Modal picker for multi-file releases; resolves with the chosen files or
    // null on cancel. Directory checkboxes toggle their files.
    abbPickFiles(name, files, useSelectedFlag) {
        const pre = f => (useSelectedFlag ? !!f.selected : true);
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'modal abb-pick-modal';
            overlay.innerHTML =
                '<div class="modal-content">' +
                  '<div class="modal-header"><h3></h3></div>' +
                  '<div class="modal-body">' +
                    '<p class="text-muted abb-pick-hint">Pick what to grab. Whole folders are one book each; mp3 files in a folder are chapters of that book.</p>' +
                    '<div class="abb-pick-list"></div>' +
                  '</div>' +
                  '<div class="modal-actions"><span class="text-muted abb-pick-summary"></span><button class="text-btn" data-cancel>Cancel</button><button class="abb-grab" data-ok>Grab</button></div>' +
                '</div>';
            overlay.querySelector('h3').textContent = name;
            const list = overlay.querySelector('.abb-pick-list');
            const groups = new Map();
            for (const f of files) {
                const parts = f.path.split('/').filter(Boolean);
                const dir = parts.slice(0, -1).join('/') || '/';
                if (!groups.has(dir)) groups.set(dir, []);
                groups.get(dir).push({ f, name: parts[parts.length - 1] });
            }
            const boxes = [];
            const ok = overlay.querySelector('[data-ok]');
            const summary = overlay.querySelector('.abb-pick-summary');
            const chosen = () => boxes.filter(b => b.checked).map(b => b._file);
            const update = () => {
                const c = chosen();
                ok.disabled = !c.length;
                ok.textContent = `Grab ${c.length} file${c.length === 1 ? '' : 's'}`;
                summary.textContent = c.length ? formatBytes(c.reduce((s, f) => s + (f.bytes || 0), 0)) : 'Nothing selected';
            };
            for (const [dir, entries] of groups) {
                const g = document.createElement('div');
                g.className = 'abb-pick-group';
                const dl = document.createElement('label'); dl.className = 'abb-pick-dir';
                const dcb = document.createElement('input'); dcb.type = 'checkbox';
                dcb.checked = entries.every(e => pre(e.f)); dcb.indeterminate = !dcb.checked && entries.some(e => pre(e.f));
                dl.appendChild(dcb);
                dl.appendChild(document.createTextNode(` ${dir} (${entries.length} file${entries.length === 1 ? '' : 's'}, ${formatBytes(entries.reduce((s, e) => s + (e.f.bytes || 0), 0))})`));
                g.appendChild(dl);
                const fileBoxes = [];
                for (const e of entries) {
                    const l = document.createElement('label'); l.className = 'abb-pick-file';
                    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = pre(e.f); cb._file = e.f;
                    l.appendChild(cb);
                    l.appendChild(document.createTextNode(' ' + e.name + (e.f.bytes ? ' · ' + formatBytes(e.f.bytes) : '') + (e.f.isArchive ? ' · archive' : '')));
                    g.appendChild(l);
                    fileBoxes.push(cb); boxes.push(cb);
                    cb.addEventListener('change', () => { dcb.checked = fileBoxes.every(b => b.checked); dcb.indeterminate = !dcb.checked && fileBoxes.some(b => b.checked); update(); });
                }
                dcb.addEventListener('change', () => { fileBoxes.forEach(b => { b.checked = dcb.checked; }); dcb.indeterminate = false; update(); });
                list.appendChild(g);
            }
            update();
            const close = val => { overlay.remove(); resolve(val); };
            ok.addEventListener('click', () => close(chosen()));
            overlay.querySelector('[data-cancel]').addEventListener('click', () => close(null));
            overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
            document.body.appendChild(overlay);
        });
    },

    // pCloud pulls the file itself; we poll the shim, which stat()s the target.
    async abbFetchToPcloud(folderId, url, relPath, listEl, source) {
        const row = this._abbRow(listEl, relPath.split('/').pop(), 'Queueing on pCloud…');
        try {
            const base = `/api/admin/storage/folder/${encodeURIComponent(folderId)}/fetch-url`;
            // /start can block for a while (pCloud stat of the target hangs
            // 10-60s while pCloud is busy) — tick elapsed time so it doesn't
            // look frozen. Seen: >1 min of silent "Queueing", 2026-08-24.
            const t0q = Date.now();
            const qTimer = setInterval(() => row.setStatus(
                `Queueing on pCloud… ${Math.round((Date.now() - t0q) / 1000)}s (checking for an existing copy — pCloud can be slow here)`), 3000);
            let started;
            try {
                started = await this._shimCall(base + '/start', { method: 'POST', body: JSON.stringify({
                    url, relPath,
                    // Records where this release lands, so a later pass to
                    // collect missing tracks comes back to the same folder.
                    sourceHash: source && source.hash, sourceTitle: source && source.title,
                }) });
            } finally {
                clearInterval(qTimer);
            }
            const t0 = Date.now();
            let lastSize = 0;
            if (started.alreadyComplete) row.setStatus('Already on pCloud (same size) — registering…');
            if (started.resumed) row.setStatus('pCloud already has a partial copy — resuming…');
            // A single failed poll (pCloud's API throws transient errors)
            // must not kill the grab; give up only after several in a row.
            let pollErrors = 0;
            for (; !started.alreadyComplete;) {
                await new Promise(r => setTimeout(r, 3000));
                const qs = new URLSearchParams({ relPath: started.relPath, lastSize: String(lastSize) });
                if (started.expectedSize) qs.set('expectedSize', String(started.expectedSize));
                let p;
                try { p = await this._shimCall(base + '/progress?' + qs.toString()); pollErrors = 0; }
                catch (e) {
                    if (++pollErrors >= 6) throw new Error('Progress check kept failing: ' + e.message);
                    row.setStatus(`Progress check failed (${pollErrors}/6): ${e.message} — retrying`);
                    continue;
                }
                if (p.finished) break;
                const elapsed = Math.round((Date.now() - t0) / 1000);
                if (elapsed > 3600) throw new Error('Gave up after an hour');
                if (p.status === 'pending') row.setStatus(`pCloud fetching… ${elapsed}s` + (started.expectedSize ? ` (${formatBytes(started.expectedSize)})` : ''));
                else if (p.size) row.setProgress(p.downloaded, p.size);
                else row.setStatus(`Downloading… ${formatBytes(p.downloaded)}`);
                lastSize = p.downloaded || 0;
            }
            row.setStatus('Registering…');
            const saved = await this._shimCall(base + '/finish', { method: 'POST', body: JSON.stringify({ relPath: started.relPath, registerAsBook: true }) });
            if (saved.alreadyInLibrary) { row.complete('Already in your library — nothing new'); return true; }
            else if (saved.itemId) { row.complete('In your library'); return true; }
            else if (saved.registerError) row.complete('Saved but not registered: ' + saved.registerError);
            else if (/\.zip$/i.test(started.relPath)) {
                row.complete('Saved — extracting…');
                await this.abbExtractZip(folderId, started.relPath, listEl);
            } else row.complete('Saved');
        } catch (e) {
            row.fail(e.message || String(e));
        }
        return false;
    },

    async abbExtractZip(folderId, relPath, listEl) {
        const head = this._abbRow(listEl, 'Extracting ' + relPath.split('/').pop(), 'Reading archive…');
        const rows = {};
        try {
            const base = `/api/admin/storage/folder/${encodeURIComponent(folderId)}/extract`;
            await this._shimCall(base + '/start', { method: 'POST', body: JSON.stringify({ relPath, deleteArchive: true }) });
            for (;;) {
                await new Promise(r => setTimeout(r, 2500));
                const job = await this._shimCall(base + '/status?relPath=' + encodeURIComponent(relPath));
                for (const e of job.entries || []) {
                    if (!rows[e.outRelPath]) rows[e.outRelPath] = this._abbRow(listEl, e.outRelPath.split('/').pop(), 'Queued');
                    const r = rows[e.outRelPath];
                    if (e.status === 'running') r.setProgress(e.uploaded, e.size);
                    else if (e.status === 'done') r.complete(e.itemId ? 'In your library' : (e.error || 'Extracted'));
                    else if (e.status === 'error') r.fail(e.error || 'Failed');
                }
                if (job.status === 'running') head.setStatus(`${job.next || 0} / ${job.entries.length} files`);
                else if (job.status === 'done') { head.complete(`${job.entries.length} file(s)` + (job.error ? ' — ' + job.error : '')); return; }
                else if (job.status === 'error') { head.fail(job.error || 'Extraction failed'); return; }
            }
        } catch (e) {
            head.fail(e.message || String(e));
        }
    },

    // ── Navigation ──
    _lastSwCheck: 0,
    _updateChecksArmed: false,
    checkForSwUpdate() {
        if (!('serviceWorker' in navigator) || !this._updateChecksArmed) return;
        // Debounce: at most one update check per 10s.
        const now = Date.now();
        if (now - this._lastSwCheck < 10000) return;
        this._lastSwCheck = now;
        this._pollForUpdate();
        this._checkBuildVersion();
    },

    // Fallback path for iOS PWA: reg.update() doesn't always detect a new
    // sw.js byte-by-byte even with no-cache headers, so the SW poll can miss
    // updates. Compare the deployed index.html's build hash to the one this
    // page started with — a mismatch means a new build is live and we can
    // show the update banner regardless of SW state. The banner's 12 s
    // failsafe handles the no-waiting-SW case via window.location.reload.
    async _checkBuildVersion() {
        if (this._updateBannerShown) return;
        const current = document.getElementById('build-version')?.textContent?.trim();
        if (!current || current === 'dev') return;
        try {
            const res = await fetch('/index.html?_v=' + Date.now(), { cache: 'no-store' });
            if (!res.ok) return;
            const html = await res.text();
            const m = html.match(/<div id="build-version">([^<]+)<\/div>/);
            if (!m) return;
            const remote = m[1].trim();
            if (remote && remote !== 'dev' && remote !== current) {
                const reg = await navigator.serviceWorker.getRegistration();
                this._showUpdateBanner(reg || { waiting: null });
            }
        } catch {}
    },

    switchTab(tab) {
        this.checkForSwUpdate();
        // Another tab, or a tab's root from a page pushed on it: a new page,
        // drawn from the top (setContent). Redrawing the tab on screen keeps
        // its scroll, as before.
        if (tab !== this.currentTab || this.navStack.length) this._pageChange = true;
        this.currentTab = tab;
        this.navStack = [];
        this._searchReopen = null;
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.getElementById('abb-btn').classList.toggle('active', tab === 'add');
        document.getElementById('back-btn').classList.add('hidden');

        switch (tab) {
            case 'home': this.showHome(); break;
            case 'library': this.showLibrary(); break;
            case 'latest': this.showLatest(); break;
            case 'playlists': this.showPlaylists(); break;
            case 'add': this.showAdd(); break;
            case 'series': this.showSeries(); break;
            case 'collections': this.showCollections(); break;
            case 'authors': this.showAuthors(); break;
        }
    },

    // Any pushed view has somewhere to go back to: the tab it was opened
    // from. This used to require a stack of 2+, so a book opened from Home
    // showed no back button and neither the button nor the swipe did
    // anything — the only way out was to tap a bottom tab.
    //
    // Each entry carries HOW to draw itself again, not just its title. The
    // stack was a list of strings until 2026-09-21 and goBack() always ran
    // switchTab(), so going back from an author page — reached from a book,
    // reached from Home — landed on Home instead of the book: every level
    // collapsed to the tab root. `render` is called with _navRestoring set,
    // which turns the view's own pushNav into a title update instead of a
    // second push, so a view needs no "I am being restored" branch of its
    // own. It must call pushNav BEFORE its first await for that to hold.
    pushNav(title, render) {
        this.checkForSwUpdate();
        if (this._navRestoring) { this.setNavTop(title, render); return; }
        this._pageChange = true;
        this.navStack.push({ title, render: render || null });
        document.getElementById('header-title').textContent = title;
        document.getElementById('back-btn').classList.toggle('hidden', this.navStack.length < 1);
    },

    // Retitle the level being shown (a detail view only learns its title
    // after its fetch), and optionally give it a cheaper way to redraw —
    // a book page hands over the item it already holds, so coming back to
    // it costs no round trip.
    setNavTop(title, render) {
        const top = this.navStack[this.navStack.length - 1];
        if (!top) return;
        if (render) top.render = render;
        if (title == null) return;
        top.title = title;
        document.getElementById('header-title').textContent = title;
    },

    goBack() {
        if (this.navStack.length) {
            const reopen = this._searchReopen;
            this._pageChange = true;
            this.navStack.pop();
            const top = this.navStack[this.navStack.length - 1];
            if (top && top.render) {
                document.getElementById('header-title').textContent = top.title;
                this._navRestoring = true;
                try { top.render(); } finally { this._navRestoring = false; }
            } else {
                // Nothing below it: switchTab redraws the tab and clears the stack.
                this.switchTab(this.currentTab);
            }
            // Back out of what a search opened: the search again, as it was.
            if (reopen && this.navStack.length <= reopen.depth) {
                this._searchReopen = null;
                this.showSearch(reopen.query);
            } else if (reopen) {
                this._searchReopen = reopen;
            }
        } else if (this.currentTab === 'add') {
            this.switchTab(this._addReturnTab);
        }
    },

    setContent(html) {
        const content = document.getElementById('content');
        this._topIfNewPage(content);
        content.innerHTML = html;
        this._markShelves();
        this.paintPlayingEpisode();
    },

    // The first paint after a navigation (pushNav, goBack, switchTab to
    // another page) starts at the top, set explicitly. It used to inherit
    // whatever the scroller held, and WebKit pulls an out-of-range offset
    // back after layout only when no user scroll is in progress
    // (RenderLayerScrollableArea::updateScrollInfoAfterLayout), which on iOS
    // includes a flick's momentum. So Back tapped while LINUX Unplugged's
    // 30,000 px list was still gliding left the short Library scrolled
    // thousands of px past its end: blank (Joseph, 2026-10-22). A
    // programmatic scroll reaches the UI process whatever the gesture state.
    // Set before the swap, while the old page's layout is still clean, so it
    // costs no extra layout. Redraws of the same page don't set the flag
    // and keep their scroll.
    _topIfNewPage(content) {
        if (!this._pageChange) return;
        this._pageChange = false;
        content.scrollTop = 0;
    },

    // Mark each .h-scroll with can-scroll / at-end so CSS can fade the right
    // edge only while there's more to the right. Runs after every paint and
    // (via a capturing scroll listener — scroll doesn't bubble) on scroll.
    _markShelves(one) {
        const shelves = one ? [one] : document.querySelectorAll('.h-scroll');
        for (const el of shelves) {
            const can = el.scrollWidth > el.clientWidth + 2;
            el.classList.toggle('can-scroll', can);
            el.classList.toggle('at-end', !can || el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
        }
    },

    // "Book 2" badge text from ABS metadata: expanded items carry
    // series[].sequence, minified ones "Series #2" in seriesName.
    _seqBadge(meta) {
        if (!meta) return '';
        let seq = meta.series?.[0]?.sequence;
        if (seq == null || seq === '') {
            const m = /#\s*([\d.]+[a-z]?)\s*$/i.exec(meta.seriesName || '');
            seq = m ? m[1] : null;
        }
        return seq ? `<span class="seq-badge">Book ${esc(String(seq))}</span>` : '';
    },
    showLoading() { this.setContent('<div class="loading">Loading</div>'); },

    // ── Home ──
    // ── Generic tab cache (stale-while-revalidate) ──
    // Keyed by `${tab}|${libraryId}`. Each entry stores the rendered html
    // and the downloaded items list (only the home tab uses the latter).
    _tabCache: {},
    _tabRevalidating: {},
    _invalidateTabCache(tab) {
        if (!tab) { this._tabCache = {}; this._clearPersistedTabs(); return; }
        for (const k of Object.keys(this._tabCache)) {
            if (k.startsWith(tab + '|')) delete this._tabCache[k];
        }
        this._clearPersistedTabs(tab);
    },

    // The home tab's last render also lives in localStorage (2026-09-20), so
    // a cold launch paints the shelves before /personalized answers and the
    // usual revalidate catches up behind it. Home and Library: the launch
    // tab and the one first tap always went to, a network round trip each.
    // Keyed by server + user + library so another account's shelves can
    // never show, and cleared with the in-memory cache and on logout.
    PERSIST_TABS: ['home', 'library'],
    // The build hash is part of the key: a persisted render is markup, and
    // after an update it must not paint under CSS written for new markup.
    _persistKey(key) { return `pholia_tab:${document.getElementById('build-version')?.textContent?.trim() || 'dev'}|${ABS.serverUrl}|${localStorage.getItem('pholia_username') || ''}|${key}`; },
    _persistTab(key, html) {
        if (!this.PERSIST_TABS.includes(key.split('|')[0])) return;
        try { localStorage.setItem(this._persistKey(key), JSON.stringify({ html, ts: Date.now() })); } catch {}
    },
    _loadPersistedTab(key) {
        if (!this.PERSIST_TABS.includes(key.split('|')[0])) return null;
        try {
            const v = JSON.parse(localStorage.getItem(this._persistKey(key)) || 'null');
            return v && typeof v.html === 'string' && v.html ? v : null;
        } catch { return null; }
    },
    _clearPersistedTabs(tab) {
        try {
            for (const k of Object.keys(localStorage)) {
                if (k.startsWith('pholia_tab:') && (!tab || k.includes('|' + tab + '|'))) localStorage.removeItem(k);
            }
        } catch {}
    },
    // Back-compat for older call sites.
    _invalidateHomeCache() { this._invalidateTabCache('home'); },

    _tabKey(tab) { return `${tab}|${this.currentLibraryId}`; },
    _tabStillActive(key) {
        return this.navStack.length === 0 && key === this._tabKey(this.currentTab);
    },

    // produce: async () => string | { html, bindData? }
    //   Pure fetch + html assembly; no DOM writes. Throws on fetch error.
    //   Return bindData when the bind step needs runtime data; it gets
    //   cached alongside html so the cache-hit path can rebind correctly.
    // bind: (bindData) => void. Called after every paint (cache + fresh +
    //   revalidate). Must re-query the DOM each call.
    // Skip the background revalidate if the cache entry is younger than this.
    // Stops every tab-tap from firing a fresh network request and radio wake.
    TAB_CACHE_FRESH_MS: 30000,

    async _renderTab(tab, produce, bind) {
        const key = this._tabKey(tab);
        const cached = this._tabCache[key];
        if (cached) {
            this.setContent(cached.html);
            bind?.(cached.bindData);
            if (Date.now() - cached.ts > this.TAB_CACHE_FRESH_MS) {
                this._refreshTab(key, produce, bind);
            }
            return;
        }
        const persisted = this._loadPersistedTab(key);
        if (persisted) {
            // Cold launch: paint the last render now and refresh behind it.
            // bind runs without its runtime data (the downloaded items); the
            // handlers that need it look it up on tap instead.
            this.setContent(persisted.html);
            bind?.(undefined);
            this._tabCache[key] = { html: persisted.html, bindData: undefined, ts: 0 };
            if (key.startsWith('home|')) this._launchMark('home-cached');
            this._refreshTab(key, produce, bind);
            return;
        }
        this.showLoading();
        try {
            const out = this._normalizeProduce(await produce());
            this._tabCache[key] = { ...out, ts: Date.now() };
            this._persistTab(key, out.html);
            if (this._tabStillActive(key)) {
                this.setContent(out.html);
                bind?.(out.bindData);
                if (key.startsWith('home|')) this._launchMark('home');
            }
        } catch (e) {
            if (this._tabStillActive(key)) {
                this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
            }
        }
    },

    async _refreshTab(key, produce, bind) {
        if (this._tabRevalidating[key]) return;
        this._tabRevalidating[key] = true;
        try {
            const out = this._normalizeProduce(await produce());
            const prev = this._tabCache[key]?.html;
            this._tabCache[key] = { ...out, ts: Date.now() };
            this._persistTab(key, out.html);
            if (this._tabStillActive(key) && prev !== out.html) {
                if (this._patchProgressInPlace(prev, out.html)) {
                    // Only progress bars moved: the tab keeps its DOM, its
                    // scroll positions and its click handlers.
                    this.markDownloadedCards();
                } else {
                    this.setContent(out.html);
                    bind?.(out.bindData);
                }
            }
            if (key.startsWith('home|')) this._launchMark('home');
        } catch { /* keep cached render on background failure */ }
        finally { this._tabRevalidating[key] = false; }
    },

    _normalizeProduce(v) {
        return typeof v === 'string' ? { html: v, bindData: undefined } : v;
    },

    // Progress bars are always in the markup (hidden at zero) so that a
    // book going from unstarted to started changes an attribute, not the
    // shape of the DOM. That is what lets a refresh patch them in place.
    _progressBarHtml(kind, progress) {
        const pct = progress > 0 ? progress * 100 : 0;
        return `<div class="${kind}-progress"${pct > 0 ? '' : ' hidden'}><div class="${kind}-progress-fill" style="width:${pct}%"></div></div>`;
    },
    _PROGRESS_RE: /<div class="(card|item)-progress"( hidden)?><div class="\1-progress-fill" style="width:[^"]*">/g,
    _progressNeutral(html) {
        return html.replace(this._PROGRESS_RE, '<div class="$1-progress"><div class="$1-progress-fill" style="width:">');
    },
    // A refresh whose only change is progress (you listened since the last
    // paint, which is nearly every refresh) used to swap the whole tab's
    // innerHTML a second or so after it painted: shelves jumped, a row you
    // had scrolled snapped back, and a tap could land on a card that was
    // being replaced. When the markup is identical once widths are ignored,
    // copy the widths onto the live bars instead. Returns false when a real
    // repaint is needed (a book added, removed, reordered, retitled).
    _patchProgressInPlace(prevHtml, nextHtml) {
        if (typeof prevHtml !== 'string') return false;
        if (this._progressNeutral(prevHtml) !== this._progressNeutral(nextHtml)) return false;
        const tpl = document.createElement('template');
        tpl.innerHTML = nextHtml;
        const sel = '.card-progress, .item-progress';
        const next = tpl.content.querySelectorAll(sel);
        const live = document.getElementById('content').querySelectorAll(sel);
        if (next.length !== live.length) return false;
        next.forEach((bar, i) => {
            const target = live[i];
            target.hidden = bar.hidden;
            const fill = target.firstElementChild;
            const want = bar.firstElementChild?.style.width || '0%';
            if (fill && fill.style.width !== want) fill.style.width = want;
        });
        return true;
    },

    async showHome() {
        document.getElementById('header-title').textContent = 'Home';
        if (!this.currentLibraryId) { this.showLoading(); return; }
        const targetLib = this.currentLibraryId;
        return this._renderTab('home', async () => {
            // Start the offline-cache scan alongside /personalized, but the
            // paint waits only for the server. On a cold launch the scan is
            // the slowest thing on the page (3.4–4.9 s on an iPhone against
            // ~1 s for the server, 2026-09-20), so the Downloaded row is
            // painted from the previous session's answer and
            // _settleHomeOffline corrects it when the scan lands. Once a
            // scan has completed in this page load it is the truth: fresh
            // answers cost nothing (memoised) and a re-scan after a
            // download/delete is waited for, because that row is exactly
            // what the user came back to look at.
            const personalizedP = ABS.request(`/api/libraries/${targetLib}/personalized`);
            const scanP = Offline.fullyDownloaded();
            const sections = await personalizedP;
            this._launchMark('personalized');
            if (targetLib !== this.currentLibraryId) throw new Error('library switched');
            let downloadedItems;
            const known = Offline.fullyDownloadedKnown();
            if (known && known.sameVersion) {
                downloadedItems = known.items;
            } else if (known) {
                downloadedItems = await scanP;
                this._launchMark('scan');
            } else {
                downloadedItems = null;  // cold: the row below is last session's
            }
            let html = '';
            for (const section of sections) {
                if (!section.entities?.length) continue;
                html += `<div class="section-title">${esc(section.label)}</div>`;
                html += '<div class="h-scroll">';
                for (const entity of section.entities) {
                    const isEpisode = section.type === 'episode';
                    const itemId = entity.id || entity.libraryItemId;
                    const ep = entity.recentEpisode;
                    const meta = entity.media?.metadata || entity.metadata || {};
                    // Series/author entities use entity.name, not meta.title.
                    let title, subtitle;
                    if (isEpisode && ep) {
                        title = ep.title; subtitle = meta.title || '';
                    } else if (section.type === 'series') {
                        title = entity.name || 'Unknown';
                        subtitle = entity.numBooks != null
                            ? `${entity.numBooks} book${entity.numBooks === 1 ? '' : 's'}`
                            : (entity.books?.length ? `${entity.books.length} books` : '');
                    } else if (section.type === 'authors') {
                        title = entity.name || 'Unknown';
                        subtitle = entity.numBooks != null
                            ? `${entity.numBooks} book${entity.numBooks === 1 ? '' : 's'}`
                            : '';
                    } else {
                        title = meta.title || entity.title || 'Unknown';
                        // A podcast's metadata says `author`, a book's `authorName`.
                        subtitle = meta.authorName || meta.author || '';
                    }
                    const progress = entity.mediaProgress?.progress || entity.progress?.progress || 0;
                    const episodeId = isEpisode && ep ? ep.id : '';
                    // /personalized returns different shapes per section.type:
                    //   book/episode \u2192 entity.id is a library item id \u2192 coverUrl
                    //   series       \u2192 entity is a series; cover comes from its first book
                    //   authors      \u2192 entity is an author; image is at /api/authors/:id/image
                    // Using coverUrl(entity.id) blindly produces 404s for the
                    // non-book sections.
                    let coverSrc = '';
                    if (section.type === 'series') {
                        const bookId = entity.books?.[0]?.id;
                        if (bookId) coverSrc = ABS.coverUrl(bookId);
                        // Cache books so the click handler can show the
                        // detail view without re-fetching the series list.
                        this._seriesCache[entity.id] = entity.books || [];
                    } else if (section.type === 'authors') {
                        coverSrc = ABS.authorImageUrl(entity.id);
                    } else if (itemId) {
                        coverSrc = ABS.coverUrl(itemId);
                    }
                    const titleAttr = ` data-title="${esc(entity.name || title)}"`;
                    // Continue Listening: a tap resumes playback (the play
                    // overlay is small; the whole tile is the obvious target).
                    const resumeAttr = section.id === 'continue-listening' && section.type === 'book' ? ' data-resume="1"' : '';
                    html += `<div class="card" data-id="${itemId}" data-type="${section.type}"${titleAttr}${resumeAttr}${episodeId ? ` data-episode-id="${episodeId}"` : ''}>`;
                    html += '<div class="cover-box">';
                    if (section.type === 'book') html += this._seqBadge(meta);
                    if (coverSrc) {
                        html += `<img src="${coverSrc}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
                    }
                    html += `<button class="play-overlay" data-play-id="${itemId}"${episodeId ? ` data-play-episode="${episodeId}"` : ''}>\u25B6</button>`;
                    html += '</div>';
                    html += `<div class="card-title">${esc(title)}</div>`;
                    html += `<div class="card-sub">${esc(subtitle)}</div>`;
                    html += this._progressBarHtml('card', progress);
                    html += '</div>';
                }
                html += '</div>';
            }
            const rowItems = downloadedItems || this._loadKnownOffline();
            if (!html && !rowItems.length) html = '<div class="empty-state">No items yet</div>';
            return { html: this._homeHtml(rowItems, html), bindData: { items: downloadedItems, shelves: html } };
        }, (bindData) => {
            this.bindCardClicks();
            // No items when the row came from last session (or the persisted
            // render): the tap handlers look the book up on tap instead.
            this.bindOfflineCardClicks(bindData?.items || []);
            this._settleHomeOffline(this._tabKey('home'));
        });
    },

    // The Downloaded row sits in its own box so the settle below can swap
    // it without touching the shelves, their scroll positions or their
    // click handlers.
    _homeHtml(offlineItems, shelvesHtml) {
        return `<div class="home-offline">${this.renderOfflineSection(offlineItems)}</div>${shelvesHtml}`;
    },

    // Last session's Downloaded row, as much of each item as the row needs.
    // Per server + user (not per build: the downloads outlive an update).
    _knownOfflineKey() { return `pholia_offline:${ABS.serverUrl}|${localStorage.getItem('pholia_username') || ''}`; },
    _loadKnownOffline() {
        try {
            const v = JSON.parse(localStorage.getItem(this._knownOfflineKey()) || '[]');
            return Array.isArray(v) ? v.filter(x => x && x.id).map(x => ({ id: x.id, ...(x.ep ? { episodeId: x.ep } : {}), media: { metadata: { title: x.title, authorName: x.author } } })) : [];
        } catch { return []; }
    },
    _saveKnownOffline(items) {
        try {
            const v = items.map(i => ({ id: i.id, ...(i.episodeId ? { ep: i.episodeId } : {}), title: i.media?.metadata?.title || '', author: i.media?.metadata?.authorName || '' }));
            localStorage.setItem(this._knownOfflineKey(), JSON.stringify(v));
        } catch {}
    },

    // Runs after every home paint. Waits for the fully-downloaded scan (a
    // memo hit when it has already run) and, if the row on screen shows a
    // different set of books, replaces just that row and fixes the cached
    // and persisted html so the next refresh still patches in place rather
    // than repainting. Idempotent: two overlapping settles both read the
    // live DOM, so the second finds nothing to do.
    async _settleHomeOffline(key) {
        let items;
        try { items = await Offline.fullyDownloaded(); } catch { return; }
        this._launchMark('scan');
        this._saveKnownOffline(items);
        if (!this._tabStillActive(key)) return;
        const box = document.querySelector('#content .home-offline');
        if (!box) return;
        const entry = this._tabCache[key];
        if (entry?.bindData && typeof entry.bindData === 'object') entry.bindData.items = items;
        const live = [...box.querySelectorAll('.offline-card')].map(el => el.dataset.offlineId);
        const shown = this._offlineForLibrary(items);
        if (live.length === shown.length && live.every((id, i) => id === Offline.oid(shown[i]))) return;
        box.innerHTML = this.renderOfflineSection(items);
        this.bindOfflineCardClicks(items);
        this._markShelves();
        if (entry && typeof entry.bindData?.shelves === 'string') {
            entry.html = this._homeHtml(items, entry.bindData.shelves);
            this._persistTab(key, entry.html);
        }
    },

    // A podcast library's Downloaded row shows its episodes, a book
    // library's its books: one offline store holds both.
    _offlineForLibrary(items) {
        const pod = this.currentMediaType === 'podcast';
        return items.filter(i => pod ? !!i.episodeId : !i.episodeId);
    },

    renderOfflineSection(items) {
        items = this._offlineForLibrary(items);
        if (!items.length) return '';
        let html = `<div class="section-title">Downloaded</div><div class="h-scroll">`;
        for (const item of items) {
            const meta = item.media?.metadata || {};
            const title = meta.title || 'Unknown';
            const subtitle = meta.authorName || '';
            const oid = Offline.oid(item);
            html += `<div class="card offline-card" data-offline-id="${esc(oid)}">`;
            html += '<div class="cover-box">';
            html += `<img src="${ABS.coverUrl(item.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
            html += `<button class="play-overlay" data-offline-play="${esc(oid)}">▶</button>`;
            html += '</div>';
            html += `<div class="card-title">${esc(title)}</div>`;
            html += `<div class="card-sub">${esc(subtitle)}</div>`;
            html += '</div>';
        }
        html += '</div>';
        return html;
    },

    bindOfflineCardClicks(items) {
        const byId = Object.fromEntries(items.map(i => [Offline.oid(i), i]));
        // No items when the home was painted from its persisted copy: look
        // the tapped one up in the offline store instead.
        const find = async (oid) => byId[oid] || (await Offline.listDownloaded().catch(() => [])).find(i => Offline.oid(i) === oid);
        document.querySelectorAll('.offline-card[data-offline-id]').forEach(el => {
            el.addEventListener('click', async (e) => {
                if (e.target.closest('.play-overlay')) return;
                // An episode's id says what to do, so the tap goes straight
                // to playEpisode instead of first reading every downloaded
                // record (listDownloaded) on a persisted paint: play() must
                // come soon after the tap or iOS refuses it.
                const oid = el.dataset.offlineId;
                if (!byId[oid] && oid.includes('~')) {
                    const [itemId, episodeId] = oid.split('~');
                    this.playEpisode(itemId, episodeId);
                    return;
                }
                const item = await find(oid);
                if (!item) return;
                // A downloaded episode has no page of its own: a tap plays
                // it, from the phone.
                if (item.episodeId) this.playEpisode(item.id, item.episodeId);
                else this.showBookDetail(item);
            });
        });
        // Funnel through quickPlay so the cache-first lookup is consistent
        // with Continue Listening — both end up using the cached META.
        document.querySelectorAll('.play-overlay[data-offline-play]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const oid = btn.dataset.offlinePlay;
                if (oid.includes('~')) {
                    const [itemId, episodeId] = oid.split('~');
                    this.playEpisode(itemId, episodeId);
                } else {
                    this.quickPlay(oid);
                }
            });
        });
    },

    // ── Library ──
    async showLibrary() {
        document.getElementById('header-title').textContent = 'Library';
        return this._renderTab('library', async () => {
            const data = await ABS.getLibraryItems(this.currentLibraryId, 0, 200);
            if (this.currentMediaType !== 'podcast') return this.gridHtml(data.results);
            if (data.results.length) return this.gridHtml(data.results);
            // With personal lists the shim answers only the caller's shows, so
            // empty means "follows nothing yet", not "the server has none".
            // Podcasts are found with the search (the "+" Add screen went
            // 2026-10-18); the button shows where that search can follow.
            const none = this.shimFollows ? 'You don\'t follow any podcasts yet' : 'No podcasts yet';
            return `<div class="empty-state">${none}<div><button class="text-btn${this._dirSearchOn() ? '' : ' hidden'}" data-find-podcasts>Find podcasts</button></div></div>`;
        }, () => {
            this.bindCardClicks();
            document.querySelector('#content [data-find-podcasts]')?.classList.toggle('hidden', !this._dirSearchOn());
            document.querySelector('#content [data-find-podcasts]')?.addEventListener('click', () => this.showSearch());
        });
    },

    // ── Latest (podcasts) ──
    // Unplayed episodes across every show, newest first.
    async showLatest() {
        document.getElementById('header-title').textContent = 'Latest';
        return this._renderTab('latest', async () => {
            const [data, progress, dl] = await Promise.all([
                ABS.request(`/api/libraries/${this.currentLibraryId}/recent-episodes?limit=50`),
                this._episodeProgress(),
                Offline.fullyDownloadedIds(),
            ]);
            const episodes = data.episodes || [];
            if (!episodes.length) return '<div class="empty-state">No recent episodes</div>';
            this._overlayProgress(progress, episodes);
            for (const ep of episodes) if (progress.has(ep.id)) ep.mediaProgress = progress.get(ep.id);
            const html = '<ul class="tracklist">' + episodes.map(ep => this._episodeRowHtml(ep.libraryItemId, ep, ep.mediaProgress,
                { cover: true, show: ep.podcast?.metadata?.title || '', dl })).join('') + '</ul>';
            return { html, bindData: episodes };
        }, (episodes) => {
            const content = document.getElementById('content');
            // A cold-launch paint of last session's render comes without the
            // episodes: rows still play, the lookup happens on tap.
            if (!episodes) {
                content.querySelectorAll('.episode-row').forEach(li => {
                    li.querySelector('.episode-open')?.addEventListener('click', () => this.openEpisodeById(li.dataset.itemId, li.dataset.episodeId));
                    li.querySelector('.episode-playbtn')?.addEventListener('click', () => {
                        if (this._isLoadedEpisode(li.dataset.itemId, li.dataset.episodeId) && Player.isPlaying) Player.pause();
                        else this.playEpisode(li.dataset.itemId, li.dataset.episodeId);
                    });
                });
                return;
            }
            const progress = new Map(episodes.filter(e => e.mediaProgress).map(e => [e.id, e.mediaProgress]));
            // Each row belongs to its own show; bind per show.
            const byShow = new Map();
            for (const ep of episodes) {
                (byShow.get(ep.libraryItemId) || byShow.set(ep.libraryItemId, []).get(ep.libraryItemId)).push(ep);
            }
            for (const [itemId, eps] of byShow) {
                // The minified show carries the shim's skip setting (ABS_shim
                // buildPodcastOld), so Latest skips intros like the show page.
                const pod = eps[0].podcast || {};
                const show = { id: itemId, media: { metadata: pod.metadata || {}, episodes: eps, canArchive: false, ...(pod.skip !== undefined ? { skip: pod.skip } : {}) } };
                const rows = [...content.querySelectorAll(`.episode-row[data-item-id="${CSS.escape(itemId)}"]`)];
                this._bindEpisodeRows(content, show, eps, progress, rows);
            }
        });
    },

    // ── Playlists (podcast libraries) ──
    // ABS playlists, plus ABS_shim's smart ones: a playlist with `rules`
    // ({podcastIds, include, sort}) is recomputed by the server on every read
    // ("every unplayed episode of these shows, newest first"; ABS issue
    // #1477). Playing from a playlist queues the rest of it: when an episode
    // ends the next one starts (onEpisodeFinished).
    async showPlaylists() {
        document.getElementById('header-title').textContent = 'Playlists';
        return this._renderTab('playlists', async () => {
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/playlists`);
            const lists = data.results || [];
            for (const pl of lists) this._playlistData.set(pl.id, pl);
            let html = '<div class="podcast-add-bar"><button class="text-btn" data-new-playlist>+ New playlist</button></div>';
            html += '<div class="list-view">';
            for (const pl of lists) {
                const n = (pl.items || []).length;
                const kind = pl.rules ? this._rulesSummary(pl.rules) : 'Playlist';
                html += `<div class="list-item" data-playlist-id="${esc(pl.id)}">`;
                html += `<div class="list-placeholder">${pl.rules ? '✦' : '≡'}</div>`;
                html += `<div class="playlist-info"><div class="list-name">${esc(pl.name)}</div><div class="list-count">${n} episode${n !== 1 ? 's' : ''} · ${esc(kind)}</div></div>`;
                if (n) html += `<button class="playlist-play" data-play-playlist="${esc(pl.id)}" aria-label="Play">▶</button>`;
                html += '</div>';
            }
            if (!lists.length) html += `<div class="empty-state">No playlists yet. ${this.isShim
                ? 'A smart playlist gathers the unplayed episodes of the shows you pick, so one tap plays the lot.'
                : 'Make one here, then add episodes to it from their pages.'}</div>`;
            html += '</div>';
            return html;
        }, () => {
            const content = document.getElementById('content');
            content.querySelector('[data-new-playlist]')?.addEventListener('click', () => {
                this.pushNav('New playlist', () => this.showPlaylistEditor(null));
                this.showPlaylistEditor(null);
            });
            content.querySelectorAll('.list-item[data-playlist-id]').forEach(el => el.addEventListener('click', (e) => {
                if (e.target.closest('[data-play-playlist]')) return;
                this.showPlaylist(el.dataset.playlistId);
            }));
            content.querySelectorAll('[data-play-playlist]').forEach(btn => btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try { this._playFromPlaylist(await ABS.request(`/api/playlists/${btn.dataset.playPlaylist}`), null); }
                catch (err) { alert('Could not load the playlist: ' + err.message); }
            }));
        });
    },

    _rulesSummary(r) {
        const shows = (r.podcastIds || []).length;
        const what = r.include === 'inProgress' ? 'In progress' : r.include === 'all' ? 'Every episode' : 'Unplayed';
        return `${what} from ${shows} show${shows === 1 ? '' : 's'}, ${r.sort === 'oldest' ? 'oldest' : 'newest'} first`;
    },

    // Opening a playlist paints at once from what the Playlists tab (or the
    // last visit) already fetched, then redraws if the fresh copy differs.
    // It used to wait for the playlist (a 160 KB expansion of up to 500
    // episodes), then for /api/me and the downloads scan one after the
    // other, and that scan is seconds on an iPhone once its memo is a
    // minute old.
    _playlistData: new Map(),
    _playlistSaves: 0,
    _epProgressLast: null,
    async showPlaylist(id) {
        this.pushNav('Playlist', () => this.showPlaylist(id));
        const top = this.navStack[this.navStack.length - 1];
        const content = document.getElementById('content');
        const cached = this._playlistData.get(id);
        let drawn = '';
        if (cached) {
            this.setNavTop(cached.name);
            drawn = this._drawPlaylist(cached, this._epProgressLast || new Map(), Offline._fullyLast?.ids || new Set());
        } else this.showLoading();
        const gen = this._playlistSaves;
        let pl, progress, dl;
        try {
            [pl, progress, dl] = await Promise.all([ABS.request(`/api/playlists/${id}`), this._episodeProgress(), Offline.fullyDownloadedIds()]);
        } catch (e) {
            if (!cached && this.navStack[this.navStack.length - 1] === top) this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
            return;
        }
        // A Hide played / order change saved meanwhile is newer than this.
        if (this._playlistSaves !== gen) return;
        this._playlistData.set(id, pl);
        // Left already (another page, another tab): nothing to redraw.
        if (this.navStack[this.navStack.length - 1] !== top) return;
        this.setNavTop(pl.name);
        this._overlayProgress(progress, (pl.items || []).map(i => i.episode));
        const scroll = content.scrollTop;
        if (this._drawPlaylist(pl, progress, dl, drawn) !== drawn && cached) content.scrollTop = scroll;
    },

    // Draws a playlist page; returns its markup, and does nothing when that
    // is `same` (the page as already drawn).
    _drawPlaylist(pl, progress, dl, same) {
        const items = (pl.items || []).filter(i => i.episode);
        const r = pl.rules;
        let html = '<div class="detail-view">';
        html += `<div class="playlist-header"><h3>${esc(pl.name)}</h3>`;
        html += `<div class="text-muted">${items.length} episode${items.length !== 1 ? 's' : ''}${r ? ' · ' + esc(this._rulesSummary(r)) : ''}</div>`;
        html += '<div class="podcast-actions">';
        if (items.length) html += '<button class="abb-go playlist-play-all" data-play-all>▶ Play</button>';
        html += '<button class="text-btn" data-edit>Edit</button><button class="text-btn" data-delete>Delete</button>';
        html += '</div>';
        // A smart playlist's two everyday choices sit on the page itself
        // (the rest is behind Edit): whether played episodes stay listed,
        // and which end comes first. Both are saved in its rules, so they
        // follow the listener to every device.
        if (r) {
            html += '<div class="playlist-controls">';
            if (r.include !== 'inProgress') html += `<label class="podcast-toggle"><input type="checkbox" data-pl-hide-played${r.include === 'unplayed' ? ' checked' : ''}> Hide played</label>`;
            html += `<select data-pl-sort aria-label="Order"><option value="newest"${r.sort !== 'oldest' ? ' selected' : ''}>Newest first</option><option value="oldest"${r.sort === 'oldest' ? ' selected' : ''}>Oldest first</option></select>`;
            html += '<span class="text-muted" data-pl-status></span></div>';
        }
        html += '</div>';
        html += items.length
            ? '<ul class="tracklist">' + items.map(i => this._episodeRowHtml(i.libraryItemId, i.episode, progress.get(i.episodeId),
                { cover: true, show: i.libraryItem?.media?.metadata?.title || '', dl })).join('') + '</ul>'
            : `<div class="empty-state">${r ? 'Nothing matches right now.' : 'Empty. Add episodes with Playlist on their page.'}</div>`;
        html += '</div>';
        if (html === same) return html;
        this.setContent(html);
        const content = document.getElementById('content');
        content.querySelector('[data-play-all]')?.addEventListener('click', () => this._playFromPlaylist(pl, null, progress));
        content.querySelector('[data-edit]').addEventListener('click', () => {
            this.pushNav('Edit playlist', () => this.showPlaylistEditor(pl));
            this.showPlaylistEditor(pl);
        });
        content.querySelector('[data-delete]').addEventListener('click', async () => {
            if (!confirm(`Delete the playlist "${pl.name}"? The episodes themselves stay.`)) return;
            try {
                await ABS.request(`/api/playlists/${pl.id}`, { method: 'DELETE' });
                this._playlistData.delete(pl.id);
                this._invalidateTabCache('playlists');
                this.goBack();
            } catch (e) { alert('Delete failed: ' + e.message); }
        });
        const status = content.querySelector('[data-pl-status]');
        const saveRules = async (change, control) => {
            const top = this.navStack[this.navStack.length - 1];
            content.querySelectorAll('[data-pl-hide-played], [data-pl-sort]').forEach(el => { el.disabled = true; });
            status.textContent = 'Saving…';
            this._playlistSaves++;
            try {
                // Progress fetched again: this page may still be the instant
                // paint, drawn with last visit's (or none), and showing played
                // episodes needs the real thing.
                const [saved, fresh] = await Promise.all([
                    ABS.request(`/api/playlists/${pl.id}`, { method: 'PATCH', body: JSON.stringify({ rules: { ...r, ...change } }) }),
                    this._episodeProgress(),
                ]);
                this._playlistData.set(pl.id, saved);
                this._invalidateTabCache('playlists');
                this._overlayProgress(fresh, (saved.items || []).map(i => i.episode));
                if (this.navStack[this.navStack.length - 1] === top) this._drawPlaylist(saved, fresh, Offline._fullyLast?.ids || dl);
            } catch (e) {
                control.revert();
                content.querySelectorAll('[data-pl-hide-played], [data-pl-sort]').forEach(el => { el.disabled = false; });
                status.textContent = 'Change failed: ' + e.message;
            }
        };
        const hide = content.querySelector('[data-pl-hide-played]');
        hide?.addEventListener('change', () => saveRules({ include: hide.checked ? 'unplayed' : 'all' },
            { revert: () => { hide.checked = !hide.checked; } }));
        const sort = content.querySelector('[data-pl-sort]');
        sort?.addEventListener('change', () => saveRules({ sort: sort.value },
            { revert: () => { sort.value = sort.value === 'oldest' ? 'newest' : 'oldest'; } }));
        // Rows: each belongs to its own show; tapping one plays the playlist
        // from there.
        const rows = [...content.querySelectorAll('.episode-row')];
        rows.forEach((li, idx) => {
            const it = items[idx];
            const show = { id: it.libraryItemId, libraryId: it.libraryItem?.libraryId, media: { ...(it.libraryItem?.media || {}), episodes: [it.episode] } };
            if (!r) li.dataset.playlistId = pl.id;
            this._bindEpisodeRows(li.parentElement, show, [it.episode], progress, [li], {
                queue: () => this._playlistQueue(pl, items, idx, progress),
            });
        });
        return html;
    },

    // What plays from row `index` on: that episode, then the ones after it
    // that aren't played (a playlist showing played ones mustn't replay
    // them), each resuming where it was left, as the show page's play-on
    // does.
    _playlistQueue(pl, items, index, progress) {
        const entry = (it) => {
            const p = progress?.get(it.episodeId);
            return { ...it, startAt: p && !p.isFinished ? p.currentTime || 0 : 0 };
        };
        const rest = items.slice(index + 1).filter(it => !progress?.get(it.episodeId)?.isFinished).map(entry);
        return { playlistId: pl.id, name: pl.name, items: [items[index], ...rest], index: 0 };
    },

    // Play a playlist's episodes in order from `index`, queueing the rest.
    // `index` null: from the first episode not played yet.
    async _playFromPlaylist(pl, index, progress) {
        const items = (pl.items || []).filter(i => i.episode);
        progress = progress || this._overlayProgress(await this._episodeProgress(), items.map(i => i.episode));
        if (index == null) index = Math.max(0, items.findIndex(it => !progress.get(it.episodeId)?.isFinished));
        if (!items[index]) return;
        const queue = this._playlistQueue(pl, items, index, progress);
        const it = items[index];
        const show = { id: it.libraryItemId, libraryId: it.libraryItem?.libraryId, media: it.libraryItem?.media || {} };
        this.playEpisode(it.libraryItemId, it.episodeId, it.episode, show, { queue });
    },

    // New (pl = null) or edit. Smart: name the shows and the rule. Ordinary:
    // just a name, filled from episodes' ⋯ "Add to playlist".
    async showPlaylistEditor(pl) {
        this.setNavTop(pl ? 'Edit playlist' : 'New playlist', () => this.showPlaylistEditor(pl));
        this.showLoading();
        // Smart playlists are ABS_shim's: stock ABS stores the playlist and
        // drops `rules`, so offering one there made an empty playlist that
        // never filled. Off a shim the editor only names a hand-picked one.
        const canSmart = !!(pl?.rules || this.isShim);
        let shows = [];
        if (canSmart) try { shows = (await ABS.getLibraryItems(this.currentLibraryId, 0, 500)).results || []; } catch {}
        const r = pl?.rules || { podcastIds: [], include: 'unplayed', sort: 'newest' };
        const smart = pl ? !!pl.rules : canSmart;
        const picked = new Set(r.podcastIds || []);
        let html = '<div class="detail-view playlist-editor">';
        html += `<label class="editor-row">Name <input type="text" id="pl-name" value="${esc(pl?.name || '')}" placeholder="e.g. Tech" autocomplete="off"></label>`;
        if (!pl && canSmart) {
            html += '<div class="editor-row editor-kind">'
                + '<label><input type="radio" name="pl-kind" value="smart" checked> Smart: the shows you pick, kept up to date</label>'
                + '<label><input type="radio" name="pl-kind" value="manual"> Hand-picked episodes</label></div>';
        }
        html += `<div id="pl-smart"${smart ? '' : ' class="hidden"'}>`;
        html += '<div class="editor-row"><select id="pl-include">'
            + `<option value="unplayed"${r.include === 'unplayed' ? ' selected' : ''}>Unplayed episodes</option>`
            + `<option value="inProgress"${r.include === 'inProgress' ? ' selected' : ''}>Episodes in progress</option>`
            + `<option value="all"${r.include === 'all' ? ' selected' : ''}>Every episode</option></select>`
            + ' <select id="pl-sort">'
            + `<option value="newest"${r.sort !== 'oldest' ? ' selected' : ''}>Newest first</option>`
            + `<option value="oldest"${r.sort === 'oldest' ? ' selected' : ''}>Oldest first</option></select>`
            // How many it holds (ABS_shim caps a smart playlist at 500; 100
            // is its default, the size every playlist had before 2026-10-12).
            + ` <select id="pl-limit" aria-label="How many">${[50, 100, 250, 500]
                .map(n => `<option value="${n}"${n === (r.limit || 100) ? ' selected' : ''}>Up to ${n}</option>`).join('')}</select></div>`;
        html += '<div class="section-title">From these shows</div><div class="playlist-shows">';
        for (const sh of shows.sort((a, b) => (a.media?.metadata?.title || '').localeCompare(b.media?.metadata?.title || ''))) {
            html += `<label class="playlist-show"><input type="checkbox" value="${esc(sh.id)}"${picked.has(sh.id) ? ' checked' : ''}>`
                + `<img class="ep-cover" src="${ABS.coverUrl(sh.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
                + `<span>${esc(sh.media?.metadata?.title || 'Untitled')}</span></label>`;
        }
        if (!shows.length) html += '<div class="empty-state">No podcasts in this library yet</div>';
        html += '</div></div>';
        html += '<div class="podcast-actions"><button class="abb-go" id="pl-save">Save</button><span class="text-muted" id="pl-status"></span></div>';
        html += '</div>';
        this.setContent(html);
        const content = document.getElementById('content');
        content.querySelectorAll('input[name="pl-kind"]').forEach(el => el.addEventListener('change', () => {
            content.querySelector('#pl-smart').classList.toggle('hidden', content.querySelector('input[name="pl-kind"]:checked').value !== 'smart');
        }));
        content.querySelector('#pl-save').addEventListener('click', async () => {
            const name = content.querySelector('#pl-name').value.trim();
            const status = content.querySelector('#pl-status');
            if (!name) { status.textContent = 'Give it a name'; return; }
            const isSmart = pl ? !!pl.rules : canSmart && content.querySelector('input[name="pl-kind"]:checked').value === 'smart';
            const body = { name };
            if (isSmart) {
                const ids = [...content.querySelectorAll('.playlist-show input:checked')].map(i => i.value);
                if (!ids.length) { status.textContent = 'Pick at least one show'; return; }
                body.rules = { podcastIds: ids, include: content.querySelector('#pl-include').value, sort: content.querySelector('#pl-sort').value,
                    limit: Number(content.querySelector('#pl-limit').value) || 100, days: r.days ?? null };
            }
            try {
                const saved = pl
                    ? await ABS.request(`/api/playlists/${pl.id}`, { method: 'PATCH', body: JSON.stringify(body) })
                    : await ABS.request('/api/playlists', { method: 'POST', body: JSON.stringify({ ...body, libraryId: this.currentLibraryId }) });
                this._invalidateTabCache('playlists');
                this._playlistData.set(saved.id, saved);
                this._playlistSaves++;
                // Replace the editor level with the playlist itself.
                this.navStack.pop();
                if (pl) this.navStack.pop();
                this.showPlaylist(saved.id);
            } catch (e) { status.textContent = 'Save failed: ' + e.message; }
        });
    },

    // An episode page's Playlist: ordinary playlists only (a smart
    // one's contents come from its rules), or a new one named on the spot.
    async _addToPlaylistUi(box, itemId, ep) {
        let lists = [];
        try { lists = ((await ABS.request(`/api/libraries/${this.currentLibraryId}/playlists`)).results || []).filter(p => !p.rules); } catch {}
        const row = document.createElement('div');
        row.className = 'episode-actions';
        row.innerHTML = '<select data-pl-pick>' + lists.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
            + '<option value="__new">New playlist…</option></select> <button class="text-btn" data-pl-add>Add</button><span class="text-muted" data-pl-msg></span>';
        box.appendChild(row);
        row.querySelector('[data-pl-add]').addEventListener('click', async () => {
            const msg = row.querySelector('[data-pl-msg]');
            let id = row.querySelector('[data-pl-pick]').value;
            try {
                if (id === '__new') {
                    const name = prompt('Name for the new playlist');
                    if (!name || !name.trim()) return;
                    const created = await ABS.request('/api/playlists', { method: 'POST', body: JSON.stringify({ libraryId: this.currentLibraryId, name: name.trim(), items: [{ libraryItemId: itemId, episodeId: ep.id }] }) });
                    id = created.id;
                } else {
                    await ABS.request(`/api/playlists/${id}/item`, { method: 'POST', body: JSON.stringify({ libraryItemId: itemId, episodeId: ep.id }) });
                }
                msg.textContent = ' Added';
                this._invalidateTabCache('playlists');
            } catch (e) { msg.textContent = ' Failed: ' + e.message; }
        });
    },

    // A podcast episode as the player and the offline store take it: a
    // one-file "book" under the show's item id, carrying its episodeId. The
    // show's title stands in for the author (mini player, lock screen,
    // Downloaded row), and the notes are plain text (the fullscreen player
    // sets them with textContent).
    _episodeItem(show, ep) {
        const smeta = show.media?.metadata || {};
        const af = ep.audioFile || {};
        const duration = ep.duration || af.duration || 0;
        return {
            id: show.id,
            episodeId: ep.id,
            libraryId: show.libraryId,
            mediaType: 'podcast',
            media: {
                metadata: {
                    title: ep.title || 'Episode',
                    authorName: smeta.title || '',
                    podcastTitle: smeta.title || '',
                    description: this._plainText(ep.description || ep.subtitle || ''),
                    // ABS_shim sent a snippet: the fullscreen player asks for the rest.
                    descriptionTrimmed: !!ep.descriptionTrimmed,
                    publishedAt: ep.publishedAt || null,
                },
                duration,
                chapters: ep.chapters || [],
                audioFiles: af.ino ? [{ ...af, duration: af.duration || duration }] : [],
                // Unknown stays unknown: a show object without `skip` (until
                // 2026-10-21 the shim's Latest list sent none) said nothing,
                // and `null` here read as "skip nothing".
                ...(show.media?.skip !== undefined ? { skip: show.media.skip } : {}),
                transcripts: ep.transcripts || [],
                // ABS_shim's episode analysis of the file it serves now (ad
                // ranges for the player, where chapters/transcript come from).
                analysis: ep.analysis || null,
                dynamicAds: !!ep.dynamicAds,
            },
        };
    },

    // An analysis describes one file (one stitch of an ad-inserting host's
    // episode, by its size). A copy on this phone of another size (the host
    // restitched after it was downloaded) has its ads and times elsewhere,
    // so it gets none: the note is shown and nothing is skipped, as before
    // analyses existed.
    async _analysisFor(epItem, a) {
        if (!a) return null;
        try {
            const cov = (await Offline.chunkCoverage(epItem))?.[0];
            if (cov && !cov.legacy && cov.totalSize && cov.totalSize !== a.size) return null;
        } catch {}
        return a;
    },

    // A show's intro/outro skipping (ABS_shim's media.skip), remembered per
    // show on this phone: a downloaded episode carries the setting from the
    // day it was downloaded, and may play with no network to ask.
    _skipKey() { return `pholia_show_skip:${ABS.serverUrl}`; },
    _skipMap() {
        const key = this._skipKey();
        if (this._skipCache?.key !== key) {
            let map = {};
            try { map = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
            this._skipCache = { key, map };
        }
        return this._skipCache.map;
    },
    _skipFor(item) {
        if (!item?.id) return null;
        // The newest setting this phone has seen for the show wins: the map
        // is written from the server's answers (_rememberSkip: the show
        // page, a change made there, and every episode playEpisode fetches,
        // Latest's included), never from a copy on the phone, so it is never
        // older than the copy inside an item. An item's own copy can be: a
        // download keeps the setting of the day it was downloaded. Until 2026-10-21 the item's copy won, and a
        // missing one counted as "skip nothing", so LNL 408 started from
        // Latest played its intro and only offered to skip a promo the show
        // was set to skip (all ads).
        const map = this._skipMap();
        if (item.id in map) return map[item.id];
        return item.media?.skip ?? null;
    },
    _rememberSkip(show) {
        if (!show?.id || show.media?.skip === undefined) return;
        const map = this._skipMap();
        if (JSON.stringify(map[show.id] ?? null) === JSON.stringify(show.media.skip)) return;
        map[show.id] = show.media.skip;
        try { localStorage.setItem(this._skipKey(), JSON.stringify(map)); } catch {}
    },

    // Playing from a show's page carries on down the list: the episodes
    // below the one tapped, as the list shows them (its filter applied),
    // leaving out the played ones. Settings can turn it off.
    _showQueue(li, item, ep, progress) {
        const list = li.closest('[data-episode-list]');
        if (!list) return null;
        try { if (localStorage.getItem('pholia_autoplay_next') === 'false') return null; } catch {}
        const byId = new Map((item.media?.episodes || []).map(e => [e.id, e]));
        const hidden = { 'filter-unplayed': '.is-played', 'filter-downloaded': ':not(.is-downloaded)', 'filter-archived': ':not(.is-archived)' }[
            [...list.classList].find(c => c.startsWith('filter-'))];
        const rows = [...list.querySelectorAll('.episode-row')];
        const items = [{ libraryItemId: item.id, episodeId: ep.id, episode: ep, libraryItem: item }];
        for (const r of rows.slice(rows.indexOf(li) + 1)) {
            const e = byId.get(r.dataset.episodeId);
            if (!e || r.classList.contains('is-played') || (hidden && r.matches(hidden))) continue;
            const p = progress?.get(e.id);
            items.push({ libraryItemId: item.id, episodeId: e.id, episode: e, libraryItem: item, startAt: p && !p.isFinished ? p.currentTime || 0 : 0 });
            if (items.length > 50) break;
        }
        return items.length > 1 ? { showId: item.id, items, index: 0 } : null;
    },

    // The entry a finished episode hands over to: the next in the queue not
    // played on this phone since. None while the sleep timer is set to stop
    // at the end of a chapter, since the end of an episode is one.
    _nextQueued(item) {
        const q = this._queue;
        if (!q || !item?.episodeId || Player.sleepEndOfChapter) return null;
        if (q.items[q.index]?.episodeId !== item.episodeId) return null;
        for (let i = q.index + 1; i < q.items.length; i++) {
            if (!this._playedHere?.has(q.items[i].episodeId)) return { ...q.items[i], index: i };
        }
        return null;
    },

    // `episodeHint` / `itemHint`: callers that already hold them (the show
    // page, the feed browser, whose episodes aren't on the show) skip the
    // lookup. A downloaded episode plays from the phone with no network at
    // all; otherwise it goes through Player.startItem like a book, which
    // brings resume, the sessionless offline fallback and auto-cache.
    async playEpisode(itemId, episodeId, episodeHint = null, itemHint = null, opts = {}) {
        const loaded = Player.item?.id === itemId && Player.item?.episodeId === episodeId;
        // Started from a playlist: the rest of it follows (onEpisodeFinished).
        // Anything else ends the queue, except resuming the episode already
        // in the player from another list (Latest, search), which keeps it.
        if (opts.queue || !loaded) this._queue = opts.queue || null;
        try {
            // Tapping the episode that's already playing resumes it rather
            // than restarting it (the same rule as Continue Listening).
            if (loaded) {
                if (opts.startAt != null) Player.loadTime(opts.startAt, 'episode-page');
                else if (Player.audio.paused) Player.play();
                return;
            }
            const oid = `${itemId}~${episodeId}`;
            let epItem = null;
            // The show and episode from the caller's hints or the network
            // (ep null when the show doesn't list it).
            const fromNet = async () => {
                const show = itemHint || await ABS.getItem(itemId);
                return { show, ep: show.media?.episodes?.find(e => e.id === episodeId) || episodeHint || null };
            };
            let net = null;
            if (opts.auto) {
                // The next of a queue must reach the player without waiting
                // on the downloads scan (seconds on an iPhone once its memo
                // is a minute old, and a locked phone gives a page little
                // time once its audio stops): the last scan's answer will do.
                const known = Offline.fullyDownloadedKnown();
                epItem = known?.items.find(i => Offline.oid(i) === oid) || null;
            } else {
                // A tap: never behind the downloads scan when the network (or
                // the caller's hints) can answer (_itemForTap). A network
                // failure is kept and thrown below if the scan has nothing
                // either, for the same alert as before. A show that doesn't
                // list the episode is no answer: a downloaded copy may still
                // play.
                let netErr = null, unlisted = null;
                const netP = fromNet().then(v => (v.ep ? v : (unlisted = v, null)), e => { netErr = e; return null; });
                const got = await this._itemForTap(oid, netP);
                if (got?.cached) epItem = got.cached;
                else if (got?.net || unlisted) net = got?.net || unlisted;
                else if (netErr) throw netErr;
            }
            if (!epItem) {
                const { show, ep } = net || await fromNet();
                this._rememberSkip(show);
                if (!ep) { console.warn('Episode not found'); return; }
                epItem = this._episodeItem(show, ep);
            }
            // The next of a queue starts without waiting on the network
            // (Player._startItemFast), at the position the queue knew.
            // `startAt` from the episode page: a chapter, a transcript line or
            // a time in the notes, which `exact` keeps clear of the intro skip.
            if (opts.auto) await Player.startItem(epItem, opts.startAt || 0, null, { fast: true });
            else if (opts.startAt != null) await Player.startItem(epItem, opts.startAt, null, { exact: !!opts.exact });
            else await Player.startItem(epItem);
        } catch (e) {
            console.error('Play episode failed', e);
            if (!opts.auto) alert(!navigator.onLine ? "You're offline and this episode isn't downloaded." : "Couldn't play this episode: " + e.message);
        }
    },

    // ── Podcast downloads ──
    // Downloads are per phone, in the same Cache Storage chunks as books
    // (Offline.downloadBook works on any item with audioFiles). `autoKept`
    // marks a copy fetched by a show's "keep newest N" rule, which that rule
    // may delete again; a copy you asked for is yours until you remove it or
    // finish it.

    async downloadEpisode(show, ep, onProgress) {
        // The copy is what the episode page shows offline: the whole notes.
        await this._fullNotes(show.id, ep);
        const item = this._episodeItem(show, ep);
        item.downloadedAt = Date.now();
        await Offline.downloadBook(item, (i, n, received, total) => onProgress?.(received, total));
        if (this.isShim && ep.transcripts?.length) this._fetchTranscript(show.id, ep.id).catch(() => {});
        this._invalidateHomeCache?.();
    },

    _keepKey(showId) { return `pholia_pod_keep:${ABS.serverUrl}|${showId}`; },
    _keepCount(showId) {
        try { return Number(localStorage.getItem(this._keepKey(showId))) || 0; } catch { return 0; }
    },
    _setKeepCount(showId, n) {
        try {
            if (n > 0) localStorage.setItem(this._keepKey(showId), String(n));
            else localStorage.removeItem(this._keepKey(showId));
        } catch {}
    },
    _keepRules() {
        const prefix = `pholia_pod_keep:${ABS.serverUrl}|`;
        const out = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(prefix)) out.push({ showId: k.slice(prefix.length), n: Number(localStorage.getItem(k)) || 0 });
            }
        } catch {}
        return out;
    },

    // Bring every "keep newest N" show up to date: download its newest N
    // unplayed episodes that aren't here yet, and delete copies the rule
    // fetched that have fallen out of that set. Runs at launch, on
    // returning to the app (at most every 20 minutes), when a rule changes
    // and when an episode finishes. iOS only runs it while Pholia is open.
    _keepSyncRunning: false,
    _keepSyncAt: 0,
    async syncKeptDownloads(onlyShowId = null) {
        if (this._keepSyncRunning || !navigator.onLine) return;
        this._keepSyncRunning = true;
        this._keepSyncAt = Date.now();
        let changed = false;
        try {
            const rules = this._keepRules().filter(r => !onlyShowId || r.showId === onlyShowId);
            // A show whose rule was just switched off still needs its
            // auto-fetched copies cleared.
            if (onlyShowId && !rules.length) rules.push({ showId: onlyShowId, n: 0 });
            if (!rules.length) return;
            const progress = await this._episodeProgress();
            for (const rule of rules) {
                const downloaded = (await Offline.listDownloaded()).filter(i => i.id === rule.showId && i.episodeId);
                let show = null;
                if (rule.n > 0) {
                    try { show = await ABS.getItem(rule.showId); } catch { continue; }
                }
                this._overlayProgress(progress, show?.media?.episodes);
                const want = (show?.media?.episodes || [])
                    .filter(e => !progress.get(e.id)?.isFinished)
                    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
                    .slice(0, rule.n);
                const wantIds = new Set(want.map(e => e.id));
                for (const it of downloaded) {
                    if (it.autoKept && !wantIds.has(it.episodeId) && Player.item?.episodeId !== it.episodeId) {
                        await Offline.deleteBook(it);
                        changed = true;
                    }
                }
                const have = await Offline.fullyDownloadedIds();
                for (const ep of want) {
                    if (have.has(`${rule.showId}~${ep.id}`)) continue;
                    await this._fullNotes(show.id, ep);
                    const item = this._episodeItem(show, ep);
                    item.autoKept = true;
                    item.downloadedAt = Date.now();
                    try { await Offline.downloadBook(item); changed = true; }
                    catch (e) { console.warn('Keep-downloaded fetch failed', e); break; }
                }
            }
        } finally {
            this._keepSyncRunning = false;
            if (changed) this._invalidateHomeCache?.();
        }
    },

    // Called by the player when an episode plays to its end. Unless kept
    // on purpose (Settings), its offline copy goes: a played episode is the
    // one thing nobody downloads twice. Then the show's rule tops up.
    // Also called when a show's outro is skipped (Player._skipOutro), which
    // counts as the end. The sleep timer stops a queue: a timed one by
    // pausing (nothing ends then), "end of chapter" here, because an
    // episode's end is its last chapter's.
    async onEpisodeFinished(item) {
        (this._playedHere ||= new Set()).add(item.episodeId);
        const next = this._nextQueued(item);
        if (Player.sleepEndOfChapter) Player.clearSleep();
        if (next) {
            const show = { id: next.libraryItemId, libraryId: next.libraryItem?.libraryId, media: next.libraryItem?.media || {} };
            this.playEpisode(next.libraryItemId, next.episodeId, next.episode, show,
                { queue: { ...this._queue, index: next.index }, auto: true, startAt: next.startAt || 0 });
        }
        // The "finished" write is the player's; when it fails (offline, or a
        // network iOS still calls online) the player queues it for the next
        // time the server answers (_queueEpisodeFinished), or the episode
        // would come back as unplayed.
        const keep = localStorage.getItem('pholia_keep_played_episodes') === 'true';
        try {
            const oid = Offline.oid(item);
            const stored = (await Offline.listDownloaded()).find(i => Offline.oid(i) === oid);
            if (stored && !keep) { await Offline.deleteBook(stored); this._invalidateHomeCache?.(); }
        } catch {}
        if (this._keepCount(item.id) > 0) setTimeout(() => this.syncKeptDownloads(item.id), 3000);
    },

    async _podcastHousekeeping(force = false) {
        await this.flushEpisodeOutbox();
        if (force || Date.now() - this._keepSyncAt > 20 * 60 * 1000) this.syncKeptDownloads();
    },

    _outboxKey() { return `pholia_ep_outbox:${ABS.serverUrl}`; },
    _queueEpisodeFinished(item) {
        try {
            const q = JSON.parse(localStorage.getItem(this._outboxKey()) || '[]');
            q.push({ itemId: item.id, episodeId: item.episodeId, duration: item.media?.duration || 0 });
            localStorage.setItem(this._outboxKey(), JSON.stringify(q.slice(-200)));
        } catch {}
    },
    async flushEpisodeOutbox() {
        let q;
        try { q = JSON.parse(localStorage.getItem(this._outboxKey()) || '[]'); } catch { return; }
        if (!q.length || !navigator.onLine) return;
        const left = [];
        for (const e of q) {
            try {
                await ABS.updateProgress(`${e.itemId}/${e.episodeId}`, { isFinished: true, progress: 1, currentTime: e.duration, duration: e.duration });
            } catch { left.push(e); }
        }
        try { localStorage.setItem(this._outboxKey(), JSON.stringify(left)); } catch {}
    },

    // ── Series ──
    _seriesCache: {},

    async showSeries() {
        document.getElementById('header-title').textContent = 'Series';
        return this._renderTab('series', async () => {
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/series?limit=200&sort=name`);
            const series = data.results || [];
            const seriesCache = {};
            let html = '<div class="list-view">';
            for (const s of series) {
                const books = s.books || [];
                seriesCache[s.id] = books;
                const count = books.length || s.numBooks || 0;
                const bookIds = books.slice(0, 4).map(b => (b.libraryItemId || b.id));
                html += `<div class="list-item" data-series-id="${s.id}" data-series-name="${esc(s.name)}">`;
                html += this.renderSeriesMosaic(bookIds);
                html += `<div><div class="list-name">${esc(s.name)}</div><div class="list-count">${count} book${count !== 1 ? 's' : ''}</div></div>`;
                html += '</div>';
            }
            html += '</div>';
            return { html, bindData: seriesCache };
        }, (seriesCache) => {
            // Re-prime the series-id → books map so detail clicks work without
            // re-fetching. Merge instead of replace so home-tab series entries
            // (also stored in _seriesCache) aren't lost.
            Object.assign(this._seriesCache, seriesCache || {});
            document.querySelectorAll('.list-item[data-series-id]').forEach(el => {
                el.addEventListener('click', () => this.showSeriesDetail(el.dataset.seriesId, el.dataset.seriesName));
            });
        });
    },

    async showSeriesDetail(seriesId, seriesName) {
        this.pushNav(seriesName, () => this.showSeriesDetail(seriesId, seriesName));
        let books = this._seriesCache[seriesId];
        if (!books) {
            // A home painted from its persisted copy has not primed the
            // series map yet: fetch the series list once, like the Series tab.
            this.showLoading();
            try {
                const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/series?limit=200&sort=name`);
                for (const s of (data.results || [])) this._seriesCache[s.id] = s.books || [];
            } catch {}
            if (this.navStack.length === 0) return;   // navigated away meanwhile
            books = this._seriesCache[seriesId] || [];
        }
        this.renderGrid(books);
    },

    // ── Collections ──
    async showCollections() {
        document.getElementById('header-title').textContent = 'Collections';
        return this._renderTab('collections', async () => {
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/collections`);
            const collections = data.results || data.collections || data || [];
            let html = '<div class="list-view">';
            for (const c of collections) {
                const count = c.books?.length || 0;
                html += `<div class="list-item" data-collection-id="${c.id}">`;
                html += `<div class="list-placeholder">C</div>`;
                html += `<div><div class="list-name">${esc(c.name)}</div><div class="list-count">${count} book${count !== 1 ? 's' : ''}</div></div>`;
                html += '</div>';
            }
            if (!collections.length) html += '<div class="empty-state">No collections</div>';
            html += '</div>';
            return html;
        }, () => {
            document.querySelectorAll('.list-item[data-collection-id]').forEach(el => {
                el.addEventListener('click', () => this.showCollectionDetail(el.dataset.collectionId));
            });
        });
    },

    async showCollectionDetail(collectionId) {
        // Pushed before the fetch, like showItem: the back button has to be
        // live while the request is in flight, and pushNav must run before
        // the first await for a restore to update this level in place.
        this.pushNav('Collection', () => this.showCollectionDetail(collectionId));
        this.showLoading();
        try {
            const data = await ABS.request(`/api/collections/${collectionId}`);
            this.setNavTop(data.name || 'Collection');
            const books = data.books || [];
            this.renderGrid(books);
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
    },

    // ── Authors ──
    async showAuthors() {
        document.getElementById('header-title').textContent = 'Authors';
        return this._renderTab('authors', async () => {
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/authors`);
            const authors = data.authors || [];
            authors.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            let html = '<div class="list-view">';
            for (const a of authors) {
                const count = a.numBooks || 0;
                const hasImage = a.imagePath;
                html += `<div class="list-item" data-author-id="${a.id}" data-author-name="${esc(a.name)}">`;
                if (hasImage) {
                    html += `<img src="${ABS.authorImageUrl(a.id)}" alt="" loading="lazy">`;
                } else {
                    html += `<div class="list-placeholder">${esc((a.name || '?')[0])}</div>`;
                }
                html += `<div><div class="list-name">${esc(a.name)}</div><div class="list-count">${count} book${count !== 1 ? 's' : ''}</div></div>`;
                html += '</div>';
            }
            html += '</div>';
            return html;
        }, () => {
            document.querySelectorAll('.list-item[data-author-id]').forEach(el => {
                el.addEventListener('click', () => this.showAuthorDetail(el.dataset.authorId, el.dataset.authorName));
            });
        });
    },

    async showAuthorDetail(authorId, authorName) {
        this.pushNav(authorName, () => this.showAuthorDetail(authorId, authorName));
        this.showLoading();
        try {
            const data = await ABS.request(`/api/authors/${authorId}?include=items`);
            const books = data.libraryItems || [];
            this.setContent(this._authorHeaderHtml(data) + this.gridHtml(books));
            this.bindCardClicks();
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
    },

    // Photo (tap → lightbox at full size) and biography above an author's
    // books. The bio is clamped to a few lines; tapping it expands it.
    _authorHeaderHtml(a) {
        const bio = (a.description || '').trim();
        if (!a.imagePath && !bio) return '';
        let html = '<div class="author-header">';
        if (a.imagePath) {
            html += `<img class="author-photo" src="${ABS.authorImageUrl(a.id)}" data-full="${ABS.authorImageUrl(a.id, true)}" alt="" onerror="this.remove()">`;
        }
        if (bio) html += `<div class="author-bio" onclick="this.classList.toggle('open')">${esc(bio)}</div>`;
        return html + '</div>';
    },

    // ── Listening stats ──
    // /api/me/listening-stats (every session, aggregated server-side) plus
    // this year's review. Charts are inline SVG: no library, and they take
    // the theme's colours from CSS.
    async showStats() {
        this.pushNav('Listening stats', () => this.showStats());
        this.showLoading();
        try {
            const year = new Date().getFullYear();
            const [stats, yr] = await Promise.all([ABS.getListeningStats(), ABS.getYearStats(year).catch(() => null)]);
            this.setContent(this._renderStats(stats, yr, year));
            document.querySelectorAll('#content .stats-item[data-id]').forEach(el => {
                el.addEventListener('click', () => this.showItem(el.dataset.id));
            });
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
    },

    _renderStats(stats, yr, year) {
        const hrs = (s) => {
            s = Math.round(Number(s) || 0);
            if (s < 60) return `${s}s`;
            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
            return h ? `${h}h ${m}m` : `${m}m`;
        };
        const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const days = stats.days || {};
        // Last 30 days, oldest first.
        const series = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
            series.push({ key: dayKey(d), day: d, sec: days[dayKey(d)] || 0 });
        }
        const last7 = series.slice(-7).reduce((a, x) => a + x.sec, 0);
        const last30 = series.reduce((a, x) => a + x.sec, 0);
        const streak = (() => { let n = 0; for (let i = series.length - 1; i >= 0 && series[i].sec > 0; i--) n++; return n; })();

        let html = '<div class="stats-page">';
        html += '<div class="stats-tiles">';
        html += `<div class="stat-tile"><div class="stat-val">${hrs(stats.today)}</div><div class="stat-label">Today</div></div>`;
        html += `<div class="stat-tile"><div class="stat-val">${hrs(last7)}</div><div class="stat-label">Last 7 days</div></div>`;
        html += `<div class="stat-tile"><div class="stat-val">${hrs(last30)}</div><div class="stat-label">Last 30 days</div></div>`;
        html += `<div class="stat-tile"><div class="stat-val">${hrs(stats.totalTime)}</div><div class="stat-label">All time</div></div>`;
        html += '</div>';

        // Daily bars, 30 days.
        const max = Math.max(1, ...series.map(x => x.sec));
        const W = 300, H = 90, gap = 2, bw = (W - gap * 29) / 30;
        let svg = `<svg viewBox="0 0 ${W} ${H + 14}" preserveAspectRatio="none" class="stats-bars" aria-hidden="true">`;
        series.forEach((x, i) => {
            const h = x.sec ? Math.max(2, (x.sec / max) * H) : 1;
            svg += `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1" class="${x.sec ? 'bar' : 'bar bar-empty'}"><title>${x.key}: ${hrs(x.sec)}</title></rect>`;
        });
        svg += '</svg>';
        const fmtD = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        html += `<div class="stats-section"><h3>Last 30 days${streak > 1 ? ` <span class="stats-streak">${streak}-day streak</span>` : ''}</h3>${svg}`;
        html += `<div class="stats-axis"><span>${fmtD(series[0].day)}</span><span>${fmtD(series[29].day)}</span></div></div>`;

        // Day of week.
        const dow = stats.dayOfWeek || {};
        const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const dmax = Math.max(1, ...names.map(n => dow[n] || 0));
        html += '<div class="stats-section"><h3>By weekday</h3><div class="stats-dow">';
        for (const n of names) {
            const v = dow[n] || 0;
            html += `<div class="stats-dow-row"><span class="stats-dow-name">${n.slice(0, 3)}</span><div class="stats-dow-track"><div class="stats-dow-fill" style="width:${(v / dmax * 100).toFixed(1)}%"></div></div><span class="stats-dow-val">${v ? hrs(v) : ''}</span></div>`;
        }
        html += '</div></div>';

        // Year in review.
        if (yr && (yr.totalListeningTime > 0 || yr.numBooksFinished > 0)) {
            const monthName = (m) => new Date(2000, m, 1).toLocaleDateString(undefined, { month: 'long' });
            html += `<div class="stats-section"><h3>${year} so far</h3><div class="stats-year">`;
            html += `<div><b>${hrs(yr.totalListeningTime)}</b> over ${yr.totalListeningSessions} session${yr.totalListeningSessions === 1 ? '' : 's'}</div>`;
            html += `<div><b>${yr.numBooksListened}</b> book${yr.numBooksListened === 1 ? '' : 's'} listened to, <b>${yr.numBooksFinished}</b> finished</div>`;
            if (yr.topAuthors?.length) html += `<div>Most heard: <b>${esc(yr.topAuthors.map(a => a.name).join(', '))}</b></div>`;
            if (yr.mostListenedNarrator?.name) html += `<div>Favourite narrator: <b>${esc(yr.mostListenedNarrator.name)}</b></div>`;
            if (yr.mostListenedMonth) html += `<div>Biggest month: <b>${monthName(yr.mostListenedMonth.month)}</b> (${hrs(yr.mostListenedMonth.time)})</div>`;
            if (yr.longestAudiobookFinished?.title) html += `<div>Longest finished: <b>${esc(yr.longestAudiobookFinished.title)}</b> (${hrs(yr.longestAudiobookFinished.duration)})</div>`;
            html += '</div></div>';
        }

        // Top books.
        const items = Object.values(stats.items || {}).filter(i => i.timeListening > 0).sort((a, b) => b.timeListening - a.timeListening).slice(0, 10);
        if (items.length) {
            html += '<div class="stats-section"><h3>Most listened</h3><div class="stats-list">';
            for (const it of items) {
                const m = it.mediaMetadata || {};
                html += `<div class="stats-item" data-id="${esc(it.id)}"><img src="${ABS.coverUrl(it.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div class="stats-item-text"><div class="stats-item-title">${esc(m.title || 'Untitled')}</div><div class="stats-item-sub">${esc(m.authorName || '')}</div></div><div class="stats-item-time">${hrs(it.timeListening)}</div></div>`;
            }
            html += '</div></div>';
        }

        // Recent sessions.
        const recent = (stats.recentSessions || []).filter(s => s.timeListening > 0);
        if (recent.length) {
            html += '<div class="stats-section"><h3>Recent sessions</h3><div class="stats-list">';
            for (const s of recent) {
                const when = s.startedAt ? new Date(s.startedAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : (s.date || '');
                html += `<div class="stats-item"${s.libraryItemId ? ` data-id="${esc(s.libraryItemId)}"` : ''}><div class="stats-item-text"><div class="stats-item-title">${esc(s.displayTitle || s.mediaMetadata?.title || 'Untitled')}</div><div class="stats-item-sub">${esc(when)}</div></div><div class="stats-item-time">${hrs(s.timeListening)}</div></div>`;
            }
            html += '</div></div>';
        }
        if (!stats.totalTime) html += '<div class="loading">Nothing yet. Stats appear once you have listened for a while.</div>';
        html += '</div>';
        return html;
    },

    // ── Search ──
    // query: reopening a search (Back from something it found), drawn at
    // once and without the keyboard.
    showSearch(query) {
        document.getElementById('search-overlay').classList.remove('hidden');
        const input = document.getElementById('search-input');
        input.placeholder = this._dirSearchOn() ? 'Search podcasts, or paste a feed URL' : 'Search...';
        if (query) {
            input.value = query;
            input.parentElement.classList.toggle('has-value', true);
            this.doSearch(query, null, { now: true });
            return;
        }
        input.focus();
        if (!input.value && this._dirSearchOn()) this._renderServerBrowse(document.getElementById('search-results'));
    },

    hideSearch() {
        document.getElementById('search-overlay').classList.add('hidden');
        document.getElementById('search-input').value = '';
        document.getElementById('search-input').dispatchEvent(new Event('input'));
        document.getElementById('search-results').innerHTML = '';
    },

    // × inside a search field: visible only while there's text; clears the
    // field, runs onClear (so results empty too), and keeps the keyboard up.
    _wireSearchClear(input, btn, onClear) {
        const wrap = input.parentElement;
        const sync = () => wrap.classList.toggle('has-value', input.value.length > 0);
        input.addEventListener('input', sync);
        btn.addEventListener('click', () => {
            input.value = '';
            sync();
            onClear?.();
            input.focus();
        });
        sync();
    },

    // opts.now: Enter, or a reopened search: the podcast directory is asked
    // without waiting for more typing.
    async doSearch(query, target, opts = {}) {
        const resultsEl = target || document.getElementById('search-results');
        query = (query || '').trim();
        const dir = this._dirSearchOn();
        // Each search on an element gets a number; an answer for an older
        // one (slow network, or still typing) draws nothing.
        const token = resultsEl._searchToken = (resultsEl._searchToken || 0) + 1;
        if (!query || query.length < 2) {
            if (dir && !target && !query && !document.getElementById('search-overlay').classList.contains('hidden')) this._renderServerBrowse(resultsEl);
            else resultsEl.innerHTML = '';
            return;
        }
        try {
            // A pasted feed URL is a show to open, not words to find: the
            // directory half answers it with that feed. Searching the library
            // for it found nothing at best, and on a shim from before
            // 2026-10-21 failed with a 500 (D1's 50-byte LIKE limit) that
            // replaced the whole answer, so the feed never appeared.
            const data = /^https?:\/\//i.test(query) ? {} : await ABS.searchLibrary(this.currentLibraryId, query);
            if (resultsEl._searchToken !== token) return;
            let html = '';
            const books = data.book || data.libraryItems || [];
            if (books.length) {
                html += '<div class="section-title">Books</div><div class="grid">';
                for (const b of books) {
                    const item = b.libraryItem || b;
                    const meta = item.media?.metadata || {};
                    html += this.gridItemHtml(item.id, meta.title, meta.authorName, 0, meta);
                }
                html += '</div>';
            }
            // A podcast library answers with shows and episodes instead.
            const shows = data.podcast || [];
            if (shows.length) {
                html += '<div class="section-title">Podcasts</div><div class="grid">';
                for (const p of shows) {
                    const item = p.libraryItem || p;
                    const meta = item.media?.metadata || {};
                    html += this.gridItemHtml(item.id, meta.title, meta.author, 0, meta);
                }
                html += '</div>';
            }
            const episodeHits = (data.episodes || []).filter(e => e.libraryItem?.recentEpisode);
            if (episodeHits.length) {
                html += '<div class="section-title">Episodes</div><ul class="tracklist">';
                for (const e of episodeHits) {
                    const show = e.libraryItem;
                    html += this._episodeRowHtml(show.id, show.recentEpisode, show.mediaProgress, { cover: true, show: show.media?.metadata?.title || '' });
                }
                html += '</ul>';
            }
            const authors = data.authors || [];
            if (authors.length) {
                html += '<div class="section-title">Authors</div><div class="list-view">';
                for (const a of authors) {
                    html += `<div class="list-item" data-author-id="${a.id}" data-author-name="${esc(a.name)}">`;
                    html += `<div class="list-placeholder">${esc((a.name||'?')[0])}</div>`;
                    html += `<div><div class="list-name">${esc(a.name)}</div></div></div>`;
                }
                html += '</div>';
            }
            const series = data.series || [];
            if (series.length) {
                html += '<div class="section-title">Series</div><div class="list-view">';
                for (const s of series) {
                    const sr = s.series || s;
                    html += `<div class="list-item" data-series-id="${sr.id}" data-series-name="${esc(sr.name)}">`;
                    html += `<div class="list-placeholder">S</div>`;
                    html += `<div><div class="list-name">${esc(sr.name)}</div></div></div>`;
                }
                html += '</div>';
            }
            // In a podcast library the directory's answer goes below (it
            // says "No results" itself when there's nothing anywhere).
            if (dir) html += '<div class="pod-dir" data-pod-dir></div>';
            else if (!html) html = '<div class="empty-state">No results</div>';
            resultsEl.innerHTML = html;
            this.bindSearchClicks(resultsEl);
            if (dir) this._podFindSection(query, resultsEl, token, data, opts);
            resultsEl.querySelectorAll('.episode-row').forEach(li => {
                const hit = episodeHits.find(e => e.libraryItem.recentEpisode.id === li.dataset.episodeId);
                li.querySelector('.episode-playbtn').addEventListener('click', () => {
                    this.hideSearch();
                    this.playEpisode(li.dataset.itemId, li.dataset.episodeId, hit?.libraryItem.recentEpisode);
                });
                li.querySelector('.episode-open').addEventListener('click', () => {
                    this._openFromSearch(() => {
                        if (hit) this.showEpisode(hit.libraryItem, hit.libraryItem.recentEpisode);
                        else this.openEpisodeById(li.dataset.itemId, li.dataset.episodeId);
                    });
                });
                li.querySelector('[data-quick-archive]')?.addEventListener('click', async (e) => {
                    const btn = e.currentTarget;
                    btn.disabled = true; btn.classList.add('busy');
                    const show = { id: hit.libraryItem.id, media: hit.libraryItem.media || {} };
                    try { await this._archiveEpisode(show, hit.libraryItem.recentEpisode, li, new Map()); }
                    catch (err) { btn.disabled = false; btn.classList.remove('busy'); alert('Archive failed: ' + err.message); }
                });
            });
        } catch (e) {
            if (resultsEl._searchToken === token) resultsEl.innerHTML = `<div class="loading">Error: ${esc(e.message)}</div>`;
        }
    },

    bindSearchClicks(container) {
        container.querySelectorAll('.grid-item').forEach(el => {
            el.addEventListener('click', () => this._openFromSearch(() => this.showItem(el.dataset.id)));
        });
        container.querySelectorAll('.play-overlay').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideSearch();
                this.quickPlay(btn.dataset.playId);
            });
        });
        container.querySelectorAll('.list-item[data-author-id]').forEach(el => {
            el.addEventListener('click', () => this._openFromSearch(() => this.showAuthorDetail(el.dataset.authorId, el.dataset.authorName)));
        });
        container.querySelectorAll('.list-item[data-series-id]').forEach(el => {
            el.addEventListener('click', () => this._openFromSearch(() => this.showSeriesDetail(el.dataset.seriesId, el.dataset.seriesName)));
        });
    },

    // ── Grid renderer ──
    renderSeriesMosaic(bookIds) {
        if (!bookIds.length) return '<div class="list-placeholder">S</div>';
        if (bookIds.length === 1) {
            return `<img src="${ABS.coverUrl(bookIds[0])}" alt="" onerror="this.outerHTML='<div class=\\'list-placeholder\\'>S</div>'">`;
        }
        const imgs = bookIds.slice(0, 4).map(id =>
            `<img src="${ABS.coverUrl(id)}" alt="" onerror="this.style.visibility='hidden'">`
        ).join('');
        const cls = bookIds.length <= 2 ? 'mosaic-2' : 'mosaic-4';
        return `<div class="series-mosaic ${cls}">${imgs}</div>`;
    },

    gridHtml(items) {
        let html = '<div class="grid">';
        for (const item of items) {
            const meta = item.media?.metadata || {};
            const progress = item.mediaProgress?.progress || 0;
            html += this.gridItemHtml(item.id, meta.title, meta.authorName || meta.author, progress, meta);
        }
        html += '</div>';
        return html;
    },
    renderGrid(items) {
        this.setContent(this.gridHtml(items));
        this.bindCardClicks();
    },

    gridItemHtml(id, title, author, progress, meta) {
        let html = `<div class="grid-item" data-id="${id}">`;
        html += '<div class="cover-box">';
        html += this._seqBadge(meta);
        html += `<img src="${ABS.coverUrl(id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
        html += `<button class="play-overlay" data-play-id="${id}">\u25B6</button>`;
        html += '</div>';
        html += this._progressBarHtml('item', progress);
        html += '<div class="item-info">';
        html += `<div class="item-title">${esc(title || 'Unknown')}</div>`;
        html += `<div class="item-subtitle">${esc(author || '')}</div>`;
        html += '</div></div>';
        return html;
    },

    async markDownloadedCards() {
        const ids = await Offline.fullyDownloadedIds();
        if (!ids.size) return;
        document.querySelectorAll('.grid-item[data-id], .card[data-id]').forEach(el => {
            if (ids.has(el.dataset.id)) el.classList.add('is-downloaded');
        });
    },

    bindCardClicks() {
        this.markDownloadedCards();
        document.querySelectorAll('.grid-item[data-id], .card[data-id]').forEach(el => {
            const type = el.dataset.type;
            // Long-press a book → "delete from pCloud?" (ABS_shim servers only).
            if (!el.dataset.episodeId && type !== 'series' && type !== 'authors') {
                const title = () => el.dataset.title || el.querySelector('.card-title, .item-title')?.textContent;
                const isShow = type === 'podcast' || this.currentMediaType === 'podcast';
                // A show isn't a book. With personal lists, long-press takes
                // it off the caller's own list, for any member (deleting it
                // for everyone stays in /admin). On an older shim it
                // unsubscribes the library, keeping archived episodes unless
                // asked otherwise, for the owner only.
                if (isShow && this.shimFollows) {
                    this._wireLongPress(el, () => this.confirmUnfollow(el.dataset.id, title() || 'this podcast'));
                } else if (this.shimCanDelete) {
                    this._wireLongPress(el, () => isShow
                        ? this.confirmUnsubscribe(el.dataset.id, title() || 'this podcast')
                        : this.confirmDeleteItem(el.dataset.id, title() || 'this book'));
                }
            }
            el.addEventListener('click', () => {
                if (el._longPressed) { el._longPressed = false; return; }
                if (type === 'series') {
                    this.showSeriesDetail(el.dataset.id, el.dataset.title || 'Series');
                } else if (type === 'authors') {
                    this.showAuthorDetail(el.dataset.id, el.dataset.title || 'Author');
                } else if (el.dataset.episodeId) {
                    this.playEpisode(el.dataset.id, el.dataset.episodeId);
                } else if (el.dataset.resume) {
                    this.resumeFromShelf(el.dataset.id);
                } else {
                    this.showItem(el.dataset.id);
                }
            });
        });
        document.querySelectorAll('.play-overlay[data-play-id]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Series/author tiles have no meaningful "play" action — the
                // overlay's container click already routes to the detail view.
                const card = btn.closest('.card,.grid-item');
                if (card && (card.dataset.type === 'series' || card.dataset.type === 'authors')) {
                    if (card.dataset.type === 'series') this.showSeriesDetail(card.dataset.id, card.dataset.title || 'Series');
                    else this.showAuthorDetail(card.dataset.id, card.dataset.title || 'Author');
                    return;
                }
                const epId = btn.dataset.playEpisode;
                if (epId) this.playEpisode(btn.dataset.playId, epId);
                else this.quickPlay(btn.dataset.playId);
            });
        });
    },

    // A Continue Listening tile. This used to open the full-screen player
    // and restart the book from its last synced position even when it was
    // the book already playing, so a tap mid-chapter jumped backwards. Now
    // the playing book is left alone, a paused one resumes, anything else
    // starts — and you land on the book's page, not the player.
    resumeFromShelf(itemId) {
        if (Player.item?.id === itemId) {
            if (Player.audio.paused) Player.play();
        } else {
            this.quickPlay(itemId, false, true);
        }
        this.showItem(itemId);
    },

    // The item a tap plays, for `oid` (Offline.oid: a book's id, or
    // show~episode). A tap must never wait on the downloads scan when the
    // network can answer: the scan can take seconds (6.5 s on a cold launch,
    // crash log 875e31d0, 2026-10-14), and play() issued after that has lost
    // the tap's user activation, so iOS rejects it with NotAllowedError and
    // nothing plays. So: the last completed scan's answer when it already
    // holds the item; otherwise whichever of the network item (`netP`, which
    // resolves null on failure and never rejects) and the scan's answer
    // arrives first with a usable item. A network item plays from the cache
    // too, since the worker serves cached audio by URL. Only when the
    // network fails (offline) is the scan waited for. Returns {cached} (the
    // downloaded copy), {net} (netP's value) or null.
    async _itemForTap(oid, netP, t0 = Date.now()) {
        const done = (from, out) => {
            this._pushLog('page', { ev: 'tap-item', from: out ? from : 'none', ms: Date.now() - t0 });
            return out;
        };
        const known = Offline.fullyDownloadedKnown()?.items.find(i => Offline.oid(i) === oid);
        if (known) return done('known', { cached: known });
        const scanP = Offline.fullyDownloaded()
            .then(items => { const it = items.find(i => Offline.oid(i) === oid); return it ? { cached: it } : null; }, () => null);
        const nP = Promise.resolve(netP).then(v => (v ? { net: v } : null), () => null);
        const out = await Promise.race([nP.then(v => v || scanP), scanP.then(v => v || nP)]);
        return done(out?.cached ? 'scan' : 'net', out || null);
    },

    // Cache-first when it costs nothing: a book whose download the last scan
    // already knows plays from the cached META blob (works offline, immune
    // to server-side ino drift after library rescans). Otherwise the
    // network item and the scan race (_itemForTap), and offline the scan
    // decides.
    async quickPlay(itemId, openPlayer = false, eagerSession = openPlayer) {
        const t0 = Date.now();
        Player._logMark('tap', 0);
        try {
            let item = null;
            // Resume taps come from book tiles, so the /play session can be
            // opened right away instead of after the item fetch.
            const sessionP = eagerSession ? ABS.startSession(itemId) : null;
            const netP = ABS.getItem(itemId).catch(() => null);
            const got = await this._itemForTap(itemId, netP, t0);
            item = got?.cached || got?.net || null;
            if (!item) throw new Error('item unavailable');
            Player._logMark('item', Date.now() - t0);
            if (item.mediaType === 'podcast') {
                this.showItem(itemId);
            } else {
                await Player.startItem(item, null, sessionP);
                Player._logMark('started', Date.now() - t0);
                if (openPlayer) this.openFullscreen();
            }
        } catch (e) {
            console.error('Quick play failed', e);
        }
    },

    // ── Item detail ──
    async showItem(itemId) {
        this.pushNav('Loading...', () => this.showItem(itemId));
        this.showLoading();
        try {
            const item = await ABS.getItem(itemId);
            const isPodcast = item.mediaType === 'podcast';
            if (isPodcast) {
                this.showPodcastDetail(item);
            } else {
                this.showBookDetail(item);
            }
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
    },

    // "M4B" / "MP3 · 12 files · 64 kbps" from the item's audioFiles — the
    // file extension is the honest answer to "is this m4b or mp3", codec
    // alone can't distinguish m4a from m4b.
    _formatLabel(item) {
        const files = item.media?.audioFiles || [];
        if (!files.length) return '';
        const exts = [...new Set(files.map(f => String(f.metadata?.ext || f.ext || '').replace(/^\./, '').toUpperCase()).filter(Boolean))];
        const parts = [exts.join('/') || (files[0].codec || '').toUpperCase()];
        if (files.length > 1) parts.push(`${files.length} files`);
        const br = files[0].bitRate;
        if (br) parts.push(`${Math.round(br / 1000)} kbps`);
        // Which storage backend it's on (ABS_shim only — stock ABS doesn't
        // send `storage`). With several backends attached, the same title can
        // exist twice and nothing else on the page tells them apart.
        const store = this._storageName(files[0]);
        if (store) parts.push(store);
        return parts.filter(Boolean).join(' · ');
    },

    // "pCloud", "dav.example.com", a bucket name. Empty for a stock ABS
    // server, which sends no storage field at all.
    _storageName(file) {
        const s = file && file.storage;
        if (!s || !s.name) return '';
        return s.name;
    },

    async showBookDetail(item) {
        this._currentDetailItem = item;
        const meta = item.media?.metadata || {};
        const chapters = item.media?.chapters || [];
        const duration = item.media?.duration || 0;
        const progress = await ABS.getProgress(item.id);
        // Use live player time if this item is currently playing
        const currentTime = (Player.item?.id === item.id)
            ? Player.getGlobalTime()
            : (progress?.currentTime || 0);

        // Redraw from the item already in hand, so returning here from
        // an author or series page costs no fetch.
        this.setNavTop(meta.title || 'Unknown', () => this.showBookDetail(item));

        let html = '<div class="detail-view">';
        html += '<div class="detail-header">';
        html += `<img class="detail-cover" src="${ABS.coverUrl(item.id)}" alt="" onerror="this.style.visibility='hidden'">`;
        html += '<div class="detail-meta">';
        html += `<h3>${esc(meta.title || 'Unknown')}</h3>`;
        const authors = meta.authors || [];
        if (authors.length) {
            html += '<div class="author">';
            html += authors.map(a =>
                `<a href="#" class="author-link" data-author-id="${a.id}" data-author-name="${esc(a.name)}">${esc(a.name)}</a>`
            ).join(', ');
            html += '</div>';
        } else if (meta.authorName) {
            html += `<div class="author">${esc(meta.authorName)}</div>`;
        }
        if (meta.narratorName) html += `<div class="narrator">Narrated by ${esc(meta.narratorName)}</div>`;
        html += `<div class="duration">${formatTime(duration)}`;
        if (progress) html += ` &bull; ${Math.round(progress.progress * 100)}% complete`;
        html += '</div>';
        const fmt = this._formatLabel(item);
        if (fmt) html += `<div class="format">${esc(fmt)}</div>`;
        if (meta.description) html += `<div class="description">${esc(meta.description)}</div>`;
        html += '</div></div>';

        const btnText = currentTime > 0 ? `Resume from ${formatTime(currentTime)}` : 'Play';
        html += `<button class="play-btn-large" id="detail-play">${btnText}</button>`;
        const finished = !!progress?.isFinished;
        const finishedLabel = finished ? 'Mark as not started' : 'Mark as finished';
        html += `<button class="text-btn detail-finish-btn" id="detail-finish">${finishedLabel}</button>`;
        if (this.shimCanDelete) html += `<button class="text-btn detail-delete-btn" id="detail-delete">Delete from pCloud…</button>`;
        html += `<div id="offline-controls" class="offline-controls"></div>`;

        if (chapters.length) {
            html += '<div class="section-title">Chapters</div><ul class="tracklist">';
            for (let i = 0; i < chapters.length; i++) {
                const ch = chapters[i];
                const chDur = ch.end - ch.start;
                const isActive = currentTime >= ch.start && (i === chapters.length - 1 || currentTime < chapters[i+1]?.start);
                let chProgress = 0;
                if (isActive && chDur > 0) chProgress = ((currentTime - ch.start) / chDur) * 100;
                else if (currentTime > ch.end) chProgress = 100;
                html += `<li class="tracklist-item ${isActive ? 'is-active' : ''}" data-index="${i}">`;
                html += `<div class="tracklist-cache-fill"></div>`;
                html += `<div class="tracklist-progress" style="width:${chProgress}%"></div>`;
                html += `<button class="tracklist-play">`;
                html += `<span class="tracklist-num">${i + 1}</span>`;
                html += `<span class="tracklist-title">${esc(ch.title)}</span>`;
                html += `<span class="tracklist-duration">${formatTime(chDur)}</span>`;
                html += '</button></li>';
            }
            html += '</ul>';
        }
        html += '</div>';
        this.setContent(html);

        document.querySelectorAll('.author-link').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                this.showAuthorDetail(el.dataset.authorId, el.dataset.authorName);
            });
        });
        this.renderOfflineControls(item);
        this.markCachedChapters(item);
        document.getElementById('detail-play').addEventListener('click', () => {
            // The book that's already playing must not be restarted from its
            // last synced position (that is behind the ear). Resume it if
            // paused, otherwise the tap just opens the player.
            if (Player.item?.id === item.id) {
                if (Player.audio.paused) Player.play(); else this.openFullscreen();
                return;
            }
            Player.startItem(item, currentTime > 0 ? currentTime : null);
            setTimeout(() => {
                const active = document.querySelector('.tracklist-item.is-active');
                if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }, 100);
        });
        document.getElementById('detail-delete')?.addEventListener('click', () => this.confirmDeleteItem(item.id, meta.title || 'this book', item));
        document.getElementById('detail-finish')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const wantFinished = !finished;
            const dur = duration || 0;
            // Marking finished pegs progress to 100% and currentTime to end.
            // Marking not-started rewinds to 0 — that's what the user expects
            // when they "restart" a book. ABS rejects PATCH bodies that omit
            // currentTime/progress, so always send the full triple.
            const body = wantFinished
                ? { isFinished: true,  currentTime: dur, progress: 1 }
                : { isFinished: false, currentTime: 0,   progress: 0 };
            btn.disabled = true; btn.textContent = wantFinished ? 'Marking…' : 'Resetting…';
            try {
                await ABS.updateProgress(item.id, body);
                // If it's the currently-playing item, reseat the playhead so
                // the UI matches what just happened on the server.
                if (Player.item?.id === item.id) {
                    if (!wantFinished) Player.loadTime(0);
                }
                this.showBookDetail(item);
            } catch (err) {
                btn.disabled = false; btn.textContent = finishedLabel;
                alert('Could not update: ' + (err?.message || 'unknown error'));
            }
        });
        document.querySelectorAll('.tracklist-item').forEach(el => {
            el.querySelector('.tracklist-play').addEventListener('click', (e) => {
                const idx = parseInt(el.dataset.index);
                const ch = chapters[idx];
                if (!ch) return;
                const rect = el.getBoundingClientRect();
                const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const seekTo = ch.start + (fraction < 0.08 ? 0 : fraction) * (ch.end - ch.start);
                if (Player.item?.id === item.id) {
                    Player.seekChapterByTap(idx, fraction);
                } else {
                    Player.startItem(item, seekTo);
                }
            });
        });
    },

    async markCachedChapters(item) {
        const audioFiles = item.media?.audioFiles || [];
        const chapters = item.media?.chapters || [];
        if (!audioFiles.length || !chapters.length) return;
        const coverage = await Offline.chunkCoverage(item);
        if (!coverage.some(c => c)) return;
        const trackInfo = [];
        let elapsed = 0;
        for (let i = 0; i < audioFiles.length; i++) {
            trackInfo.push({
                start: elapsed,
                end: elapsed + (audioFiles[i].duration || 0),
                duration: audioFiles[i].duration || 0,
                coverage: coverage[i],
            });
            elapsed += audioFiles[i].duration || 0;
        }
        // Update detail page chapter list and fullscreen player chapter list
        // independently — only paint the one(s) currently showing this item.
        if (this._currentDetailItem?.id === item.id) {
            this._paintChapterCacheFill(
                document.querySelectorAll('#content .tracklist-item[data-index]'),
                trackInfo, chapters
            );
        }
        if (Player.item?.id === item.id) {
            this._paintChapterCacheFill(
                document.querySelectorAll('#fs-chapter-list .tracklist-item[data-index]'),
                trackInfo, chapters
            );
        }
    },

    _paintChapterCacheFill(els, trackInfo, chapters) {
        els.forEach(el => {
            const idx = parseInt(el.dataset.index);
            const ch = chapters[idx];
            if (!ch) return;
            const r = trackInfo.find(r => ch.start >= r.start && ch.start < r.end);
            if (!r) return;
            const cached = this._chapterCovered(r, ch);
            const fill = el.querySelector('.tracklist-cache-fill');
            if (cached) {
                el.classList.add('is-cached');
                if (fill) fill.style.width = '100%';
            } else {
                el.classList.remove('is-cached');
                if (fill) fill.style.width = '0%';
            }
        });
    },

    // True if the chapter's byte range within its track is fully covered by
    // cached chunks. For legacy whole-file entries, returns true. For uncached
    // tracks, returns false. With sliding-window caching, chapters near the
    // playhead become cached even though the start of the file isn't.
    _chapterCovered(trackInfo, ch) {
        const cov = trackInfo.coverage;
        if (!cov) return false;
        if (cov.legacy) return true;
        const { totalSize, chunkSize, numChunks, cached } = cov;
        if (!cached.size) return false;
        const trackDur = trackInfo.duration;
        if (trackDur <= 0) return false;
        const chEndTime = Math.min(ch.end, trackInfo.end);
        const chStartByte = ((ch.start - trackInfo.start) / trackDur) * totalSize;
        const chEndByte = ((chEndTime - trackInfo.start) / trackDur) * totalSize;
        const firstChunk = Math.max(0, Math.floor(chStartByte / chunkSize));
        const lastChunk = Math.min(numChunks - 1, Math.floor(Math.max(chStartByte, chEndByte - 1) / chunkSize));
        for (let c = firstChunk; c <= lastChunk; c++) {
            if (!cached.has(c)) return false;
        }
        return true;
    },

    // Live update: re-query coverage and refresh chapter rows. Re-queries on
    // every event because chunks can be evicted by the sliding-window logic
    // and the UI must reflect that, not just additions. Coalesces overlapping
    // events into one trailing refresh so the final state is never lost.
    async onCacheProgress({ itemId }) {
        // The event might be for the playing item, the item being viewed in
        // detail, or both — markCachedChapters paints whichever lists match.
        let item = null;
        if (Player.item?.id === itemId) item = Player.item;
        else if (this._currentDetailItem?.id === itemId) item = this._currentDetailItem;
        if (!item) return;
        if (this._cacheProgressInFlight) {
            this._cacheProgressQueued = true;
            return;
        }
        this._cacheProgressInFlight = true;
        try {
            do {
                this._cacheProgressQueued = false;
                await this.markCachedChapters(item);
            } while (this._cacheProgressQueued);
        } finally {
            this._cacheProgressInFlight = false;
        }
    },

    async renderOfflineControls(item) {
        const el = document.getElementById('offline-controls');
        if (!el) return;
        const trackCount = item.media?.audioFiles?.length || 0;
        if (!trackCount) { el.innerHTML = ''; return; }

        const downloaded = await Offline.isDownloaded(item);
        if (downloaded) {
            el.innerHTML = `
                <span class="offline-badge">Downloaded</span>
                <button class="text-btn offline-delete">Remove download</button>
            `;
            el.querySelector('.offline-delete').addEventListener('click', async () => {
                if (!confirm('Remove downloaded audio for this book?')) return;
                el.innerHTML = '<span class="offline-status">Removing…</span>';
                await Offline.deleteBook(item);
                this._invalidateHomeCache();
                this.renderOfflineControls(item);
            });
        } else {
            el.innerHTML = `<button class="text-btn offline-download">Download for offline</button>`;
            el.querySelector('.offline-download').addEventListener('click', async () => {
                el.innerHTML = `<span class="offline-status">Starting…</span>`;
                try {
                    await Offline.downloadBook(item, (done, total, received, totalBytes) => {
                        const status = el.querySelector('.offline-status');
                        if (!status) return;
                        if (received != null && totalBytes) {
                            status.textContent = `Track ${done + 1}/${total} • ${formatBytes(received)} / ${formatBytes(totalBytes)}`;
                        } else {
                            status.textContent = `Downloading ${done}/${total}…`;
                        }
                    });
                    this._invalidateHomeCache();
                    this.renderOfflineControls(item);
                } catch (e) {
                    el.innerHTML = `<span class="offline-status error">Failed: ${esc(e.message)}</span>
                        <button class="text-btn offline-retry">Retry</button>`;
                    el.querySelector('.offline-retry').addEventListener('click', () => this.renderOfflineControls(item));
                }
            });
        }
    },

    // ── Podcasts ──
    // A show's page lists the episodes on the show (ABS's "downloaded"
    // episodes; on ABS_shim they stream from the publisher until archived)
    // with the listener's progress on each. Tapping a row plays it; its ⋯
    // opens the show notes and actions. On ABS_shim the page also carries the
    // feed controls (check now, every episode the feed lists, archiving to
    // pCloud); a stock ABS server gets the list and playback.
    // The show page's list filter, one choice for every show on this phone.
    // ("Unplayed only" was a checkbox before; it carries over.)
    _podFilter() {
        try {
            const f = localStorage.getItem('pholia_pod_filter');
            if (['all', 'unplayed', 'downloaded', 'archived'].includes(f)) return f;
            return localStorage.getItem('pholia_pod_unplayed_only') === 'true' ? 'unplayed' : 'all';
        } catch { return 'all'; }
    },

    // A show page's order, per show on this phone: newest first unless the
    // listener picked oldest (catching up on a show from the start). Play-on
    // follows the list as drawn, so oldest first plays on into newer ones.
    _podSortMap() {
        try { return JSON.parse(localStorage.getItem('pholia_pod_sort') || '{}') || {}; } catch { return {}; }
    },
    _podSort(showId) { return this._podSortMap()[showId] === 'oldest' ? 'oldest' : 'newest'; },
    _setPodSort(showId, order) {
        const map = this._podSortMap();
        if (order === 'oldest') map[showId] = 'oldest'; else delete map[showId];
        try { localStorage.setItem('pholia_pod_sort', JSON.stringify(map)); } catch {}
    },
    _sortEpisodes(episodes, order) {
        const dir = order === 'oldest' ? 1 : -1;
        return episodes.sort((a, b) => dir * (((a.publishedAt || 0) - (b.publishedAt || 0)) || ((a.index || 0) - (b.index || 0))));
    },

    async _reloadPodcast(itemId) {
        try { this.showPodcastDetail(await ABS.getItem(itemId)); }
        catch (e) { this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`); }
    },

    async showPodcastDetail(item) {
        const meta = item.media?.metadata || {};
        const episodes = this._sortEpisodes([...(item.media?.episodes || [])], this._podSort(item.id));
        this.setNavTop(meta.title || 'Unknown', () => this._reloadPodcast(item.id));
        const [progress, dl] = await Promise.all([this._episodeProgress(), Offline.fullyDownloadedIds()]);
        this._overlayProgress(progress, item.media?.episodes);

        let html = `<div class="detail-view" data-pod-show="${esc(item.id)}">`;
        html += '<div class="detail-header">';
        html += `<img class="detail-cover" src="${ABS.coverUrl(item.id)}" alt="" onerror="this.style.visibility='hidden'">`;
        html += '<div class="detail-meta">';
        html += `<h3>${esc(meta.title || 'Unknown')}</h3>`;
        if (meta.author) html += `<div class="author">${esc(meta.author)}</div>`;
        html += `<div class="duration">${episodes.length} episode${episodes.length !== 1 ? 's' : ''}${item.media?.archive ? ' · archiving to pCloud' : ''}</div>`;
        // Personal podcast lists (ABS_shim, 2026-10-14): `following` is the
        // caller's. A show reached from a link, search or a playlist may not
        // be on their list, and then Follow is the page's first offer.
        const follows = this.isShim && typeof item.following === 'boolean';
        if (this.isShim) {
            html += '<div class="pod-follow-row">';
            if (follows) {
                html += item.following
                    ? `<button type="button" class="pod-follow is-on" data-pod-follow aria-pressed="true">${this._followSvg(true)}<span>Following</span></button>`
                    : `<button type="button" class="pod-follow pod-follow-cta" data-pod-follow aria-pressed="false">${this._followSvg(false)}<span>Follow</span></button>`;
            }
            // New-episode notifications: filled in by _mountPushBell once the
            // shim's push status says it can send them. Only for a show on
            // the caller's list: the shim sends nothing for one they don't follow.
            if (item.following !== false) html += '<div class="pod-bell-box" data-pod-bell-box></div>';
            html += '</div>';
        }
        html += '</div></div>';
        if (meta.description) html += `<div class="author-bio podcast-desc">${esc(this._plainText(meta.description))}</div>`;
        html += '<div class="podcast-actions">';
        if (this.isShim) {
            // The shim lets only those who may add check a feed.
            if (this.shimCanAdd) html += '<button class="text-btn" data-pod-check>Check for new episodes</button>';
            html += '<button class="text-btn" data-pod-all>All episodes in the feed</button>';
            if (item.media?.canArchive && this.shimCanAdd) {
                html += `<label class="podcast-toggle"><input type="checkbox" data-pod-archive${item.media.archive ? ' checked' : ''}> Archive new episodes to pCloud</label>`;
                html += '<button class="text-btn" data-pod-archive-all>Archive all to pCloud</button>';
                html += '<div class="pod-archive-progress" data-archive-progress hidden></div>';
            }
            // Private (ABS_shim, 2026-10-21): only the show's followers see
            // it in their lists ("On this server" included), for a paid feed
            // whose address is the subscriber's key. Followers and the owner
            // may change it; an older shim doesn't send the field.
            if (typeof item.media?.private === 'boolean' && (item.following || this.shimCanDelete)) {
                html += `<label class="podcast-toggle" title="Other people on this server won't see it in their lists. Anyone with the feed address can still add it."><input type="checkbox" data-pod-private${item.media.private ? ' checked' : ''}> Private: only followers see it</label>`;
            }
        }
        // Per phone: the newest N unplayed episodes stay downloaded here.
        const keep = this._keepCount(item.id);
        html += `<label class="podcast-toggle">Keep on this phone <select data-pod-keep>${[0, 1, 3, 5, 10]
            .map(n => `<option value="${n}"${n === keep ? ' selected' : ''}>${n ? 'newest ' + n : 'none'}</option>`).join('')}</select></label>`;
        // When an episode counts as played (ABS_shim): this show's own
        // threshold, or the library's (Settings). Only shown by a shim that
        // knows the field.
        const finishOwn = item.media?.markAsFinishedTimeRemaining;
        if (this.isShim && this.shimCanAdd && finishOwn !== undefined) {
            const lib = this._libFinishRemaining(item.libraryId);
            html += `<label class="podcast-toggle">Mark played with <select data-pod-finish>`
                + `<option value=""${finishOwn == null ? ' selected' : ''}>default (${this._finishLabel(lib)} left)</option>`
                + this._finishOptions(finishOwn) + '</select></label>';
        }
        // Intro / outro skipping (ABS_shim; the player does it). Chapter
        // choices only for a show whose episodes have chapters.
        if (this.isShim && this.shimCanAdd && item.media?.skip !== undefined) {
            const hasChapters = episodes.some(ep => ep.chapters?.length > 1);
            html += `<label class="podcast-toggle">Skip the start ${this._skipSelect('start', item.media.skip, hasChapters)}</label>`;
            html += `<label class="podcast-toggle">Skip the end ${this._skipSelect('end', item.media.skip, hasChapters)}</label>`;
            // Ads found by ABS_shim's episode analysis (skip.ads; the
            // default, inserted, isn't stored). Ranges not skipped by
            // themselves get a "Skip ad" button while they play.
            const ads = item.media.skip?.ads || '';
            html += '<label class="podcast-toggle">Skip ads <select data-pod-skip="ads">'
                + [['', 'inserted ones'], ['all', 'all of them'], ['off', 'only when I tap']]
                    .map(([v, l]) => `<option value="${v}"${v === ads ? ' selected' : ''}>${l}</option>`).join('')
                + '</select></label>';
        }
        // Whether ABS_shim's episode analysis runs on this show by itself
        // (media.analyse: null = auto, 'on', 'off'; 'off' also drops what was
        // queued). "Analyse now" on an episode works whatever this says.
        // A shim from before analysis doesn't send the field.
        if (this.isShim && this.shimCanAdd && item.media && 'analyse' in item.media) {
            const cur = this._analyseValue(item.media.analyse);
            html += `<label class="podcast-toggle" title="${esc(this._analyseHelp(''))}">Analysis <select data-pod-analyse>`
                + [['', 'Auto'], ['on', 'On'], ['off', 'Off']]
                    .map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')
                + '</select></label>';
            html += `<div class="pod-analyse-note" data-pod-analyse-help>${esc(this._analyseHelp(cur))}</div>`;
            html += '<div class="pod-analyse-note" data-pod-analyse-runs hidden></div>';
        }
        html += '<span class="text-muted" data-pod-status></span>';
        html += '</div>';
        // "Unplayed only" hides played rows with a class on the list, so
        // marking an episode played (which redraws its row as .is-played)
        // takes it out of view at once. One switch for every show, per phone.
        const filter = this._podFilter();
        const unplayed = episodes.filter(ep => !progress.get(ep.id)?.isFinished).length;
        const downloadedHere = episodes.filter(ep => dl.has(`${item.id}~${ep.id}`)).length;
        const archived = episodes.filter(ep => ep.archiveState === 'done').length;
        const counts = [`${unplayed} unplayed`, downloadedHere ? `${downloadedHere} on this phone` : '', archived ? `${archived} on pCloud` : ''].filter(Boolean).join(' · ');
        const opt = (v, label) => `<option value="${v}"${filter === v ? ' selected' : ''}>${label}</option>`;
        html += '<div class="section-title episodes-head"><span>Episodes</span>'
            + `<span class="text-muted episodes-count">${counts}</span>`
            + `<span class="episodes-pickers"><select data-ep-filter aria-label="Show">${opt('all', 'All')}${opt('unplayed', 'Unplayed')}${opt('downloaded', 'On this phone')}${opt('archived', 'On pCloud')}</select>`
            + `<select data-ep-sort aria-label="Order"><option value="newest">Newest first</option><option value="oldest"${this._podSort(item.id) === 'oldest' ? ' selected' : ''}>Oldest first</option></select></span></div>`;
        html += episodes.length
            ? `<ul class="tracklist filter-${filter}" data-episode-list>` + episodes.map(ep => this._episodeRowHtml(item.id, ep, progress.get(ep.id), { dl })).join('') + '</ul>'
              + '<div class="empty-state filter-empty hidden"></div>'
            : '<div class="empty-state">No episodes on the show yet</div>';
        html += '</div>';
        this.setContent(html);

        const content = document.getElementById('content');
        content.querySelector('.podcast-desc')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('open'));
        this._bindEpisodeRows(content, item, episodes, progress);
        this._mountPushBell(content, item);
        this._paintShowAnalysisRuns(content, item);
        const status = content.querySelector('[data-pod-status]');
        content.querySelector('[data-pod-follow]')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            if (item.following) {
                // Off the list, so the page it was opened from is redrawn without it.
                this.confirmUnfollow(item.id, meta.title || 'this podcast', () => this.goBack());
                return;
            }
            btn.disabled = true;
            try {
                const r = await this._setFollow(item.id, true);
                item.following = true;
                if (typeof r?.followers === 'number') item.followers = r.followers;
                // Redrawn on the same level: the bell appears with it.
                if (document.contains(btn)) this.showPodcastDetail(item);
            } catch (err) {
                btn.disabled = false;
                status.textContent = 'Follow failed: ' + err.message;
            }
        });
        content.querySelector('[data-pod-private]')?.addEventListener('change', async (e) => {
            const box = e.currentTarget;
            box.disabled = true;
            try {
                const r = await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/private`, {
                    method: 'PUT', body: JSON.stringify({ private: box.checked }),
                });
                item.media.private = !!r.private;
                status.textContent = r.private ? 'Private: only followers see it' : 'Everyone on this server can see it';
            } catch (err) {
                box.checked = !box.checked;
                status.textContent = 'Change failed: ' + err.message;
            } finally { box.disabled = false; }
        });
        content.querySelector('[data-pod-check]')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; status.textContent = 'Checking the feed…';
            try {
                const r = await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/checknew`);
                const n = (r.episodes || []).length;
                status.textContent = n ? `${n} new episode${n === 1 ? '' : 's'}` : 'Nothing new';
                if (n) { this._invalidateTabCache(); this._reloadPodcast(item.id); }
            } catch (err) {
                status.textContent = 'Check failed: ' + err.message;
            } finally { btn.disabled = false; }
        });
        content.querySelector('[data-pod-all]')?.addEventListener('click', () => {
            this.pushNav('All episodes', () => this.showFeedEpisodes(item));
            this.showFeedEpisodes(item);
        });
        const applyFilter = (f) => {
            const list = content.querySelector('[data-episode-list]');
            if (!list) return;
            list.className = `tracklist filter-${f}`;
            const sel = { unplayed: ':not(.is-played)', downloaded: '.is-downloaded', archived: '.is-archived' }[f];
            const none = !!sel && !list.querySelector(`.episode-row${sel}`);
            const note = content.querySelector('.filter-empty');
            if (note) {
                note.textContent = { unplayed: 'Everything here has been played', downloaded: 'No episodes of this show are on this phone', archived: 'Nothing from this show is archived on pCloud yet' }[f] || '';
                note.classList.toggle('hidden', !none);
            }
        };
        applyFilter(filter);
        content.querySelector('[data-ep-filter]')?.addEventListener('change', (e) => {
            const f = e.currentTarget.value;
            try { localStorage.setItem('pholia_pod_filter', f); } catch {}
            applyFilter(f);
        });
        // Reorders the rows already drawn: their handlers find their episode
        // by id, so moving them is enough.
        content.querySelector('[data-ep-sort]')?.addEventListener('change', (e) => {
            const order = e.currentTarget.value;
            this._setPodSort(item.id, order);
            this._sortEpisodes(episodes, order);
            const list = content.querySelector('[data-episode-list]');
            if (!list) return;
            const rows = new Map([...list.querySelectorAll('.episode-row')].map(li => [li.dataset.episodeId, li]));
            for (const ep of episodes) { const li = rows.get(ep.id); if (li) list.appendChild(li); }
        });
        content.querySelector('[data-pod-keep]')?.addEventListener('change', async (e) => {
            const n = Number(e.currentTarget.value) || 0;
            this._setKeepCount(item.id, n);
            status.textContent = n ? `Downloading the newest ${n}…` : 'Removing kept downloads…';
            await this.syncKeptDownloads(item.id);
            status.textContent = n ? `Newest ${n} kept on this phone` : '';
            if (document.contains(status)) this._reloadPodcast(item.id);
        });
        this._rememberSkip(item);
        content.querySelectorAll('[data-pod-skip]').forEach(sel => sel.addEventListener('change', async () => {
            const part = (k, chKey, sKey) => {
                const v = content.querySelector(`[data-pod-skip="${k}"]`)?.value || '';
                return !v ? {} : { [v[0] === 'c' ? chKey : sKey]: Number(v.slice(1)) };
            };
            const want = { ...part('start', 'startChapters', 'startSeconds'), ...part('end', 'endChapters', 'endSeconds') };
            const ads = content.querySelector('[data-pod-skip="ads"]')?.value || '';
            if (ads) want.ads = ads;
            const skip = Object.keys(want).length ? want : null;
            try {
                const r = await this._shimCall(`/api/items/${encodeURIComponent(item.id)}/media`, {
                    method: 'PATCH', body: JSON.stringify({ skip }),
                });
                item.media.skip = r?.libraryItem?.media?.skip !== undefined ? r.libraryItem.media.skip : skip;
                this._rememberSkip(item);
                this._invalidateTabCache();
                status.textContent = this._skipSummary(item.media.skip);
            } catch (err) {
                for (const k of ['start', 'end']) {
                    const el = content.querySelector(`[data-pod-skip="${k}"]`);
                    if (el) el.value = this._skipValue(k, item.media.skip);
                }
                const adsEl = content.querySelector('[data-pod-skip="ads"]');
                if (adsEl) adsEl.value = item.media.skip?.ads || '';
                status.textContent = 'Change failed: ' + err.message;
            }
        }));
        content.querySelector('[data-pod-finish]')?.addEventListener('change', async (e) => {
            const sel = e.currentTarget;
            const v = sel.value === '' ? null : Number(sel.value);
            try {
                await this._shimCall(`/api/items/${encodeURIComponent(item.id)}/media`, {
                    method: 'PATCH', body: JSON.stringify({ markAsFinishedTimeRemaining: v }),
                });
                item.media.markAsFinishedTimeRemaining = v;
                this._invalidateTabCache();
                const secs = v ?? this._libFinishRemaining(item.libraryId);
                status.textContent = `Episodes of this show now count as played with ${this._finishLabel(secs)} left`;
            } catch (err) {
                sel.value = finishOwn == null ? '' : String(finishOwn);
                status.textContent = 'Change failed: ' + err.message;
            }
        });
        content.querySelector('[data-pod-analyse]')?.addEventListener('change', async (e) => {
            const sel = e.currentTarget;
            const want = sel.value || null;
            const help = content.querySelector('[data-pod-analyse-help]');
            if (help) help.textContent = this._analyseHelp(sel.value);
            sel.disabled = true;
            try {
                const r = await this._shimCall(`/api/items/${encodeURIComponent(item.id)}/media`, {
                    method: 'PATCH', body: JSON.stringify({ analyse: want }),
                });
                // The show item this page (and its nav level) holds follows
                // the server's answer, so a redraw shows what's stored.
                const m = r?.libraryItem?.media;
                item.media.analyse = m && 'analyse' in m ? m.analyse : want;
                this._invalidateTabCache();
                status.textContent = { on: 'Analysis on for this show', off: 'Analysis off for this show; anything waiting was dropped' }[item.media.analyse] || 'Analysis on Auto for this show';
            } catch (err) {
                status.textContent = 'Change failed: ' + err.message;
            } finally {
                sel.disabled = false;
                sel.value = this._analyseValue(item.media.analyse);
                if (help) help.textContent = this._analyseHelp(sel.value);
            }
        });
        content.querySelector('[data-pod-archive-all]')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            // Since 2026-10-21 "all" is every episode in the feed, on the
            // show or not; the shim's archive status says how many that is.
            // A shim without it (404) still means the show's own.
            let st = null;
            try { st = await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/archive`); } catch { st = null; }
            const left = st ? st.toCopy : episodes.filter(ep => !['done', 'queued', 'fetching'].includes(ep.archiveState)).length;
            if (!left) {
                // All on its way already (pressed before, or by someone
                // else): pressing still asks to be told when it's over.
                if (st && (st.queued || st.fetching) && !st.requested) {
                    try { await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/archive`, { method: 'POST', body: '{}' }); } catch {}
                    this._archiveWatch(item, content, episodes, progress, { started: true });
                }
                status.textContent = st && (st.queued || st.fetching) ? 'Everything is on pCloud or on its way'
                    : st ? 'Every episode in the feed is already on pCloud' : 'Everything on the show is already archived or on its way';
                return;
            }
            const n = `${left} episode${left === 1 ? '' : 's'}`;
            let ask;
            if (st) {
                const off = st.toCopyNotOnShow ? `, including ${st.toCopyNotOnShow} not on this page` : '';
                const eta = this._archiveEta(Math.ceil((st.queueAhead + left) / 3) * 120 + 240);
                const told = localStorage.getItem(this._pushKey('sub')) ? ' You\'ll get a notification when it\'s done.' : '';
                ask = `Copy ${n} into pCloud? That's every episode in the feed that isn't there yet${off}. The server copies 3 every 2 minutes, so about ${eta}, and carries on with Pholia closed.${told}`;
            } else {
                ask = `Copy ${n} of this show into pCloud? It runs on the server, a few at a time.`;
            }
            if (!confirm(ask)) return;
            btn.disabled = true;
            try {
                const r = await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/archive`, { method: 'POST', body: '{}' });
                if (st) { status.textContent = ''; this._archiveWatch(item, content, episodes, progress, { started: true }); }
                else status.textContent = `${r.queued} queued for pCloud. The server copies them a few at a time.`;
            } catch (err) { status.textContent = 'Archive failed: ' + err.message; }
            finally { btn.disabled = false; }
        });
        if (item.media?.canArchive && this.shimCanAdd) this._archiveWatch(item, content, episodes, progress);
        content.querySelector('[data-pod-archive]')?.addEventListener('change', async (e) => {
            const box = e.currentTarget;
            try {
                await this._shimCall(`/api/items/${encodeURIComponent(item.id)}/media`, {
                    method: 'PATCH', body: JSON.stringify({ archive: box.checked }),
                });
                status.textContent = box.checked ? 'New episodes will be copied to pCloud as they come out' : 'Archiving off';
            } catch (err) {
                box.checked = !box.checked;
                status.textContent = 'Change failed: ' + err.message;
            }
        });
    },

    // The skip selects' values: '' (nothing), 'c<N>' chapters, 's<N>' seconds.
    _skipValue(kind, skip) {
        const c = skip?.[kind + 'Chapters'], sec = skip?.[kind + 'Seconds'];
        return c ? 'c' + c : sec ? 's' + sec : '';
    },
    _skipSelect(kind, skip, hasChapters) {
        const cur = this._skipValue(kind, skip);
        const word = kind === 'start' ? 'first' : 'last';
        const opts = [['', 'nothing']];
        if (hasChapters || cur[0] === 'c') opts.push(['c1', `${word} chapter`], ['c2', `${word} 2 chapters`], ['c3', `${word} 3 chapters`]);
        for (const n of [5, 10, 15, 20, 30, 45, 60, 90, 120, 180]) opts.push(['s' + n, `${word} ${this._finishLabel(n)}`]);
        if (cur && !opts.some(o => o[0] === cur)) opts.push([cur, cur[0] === 'c' ? `${word} ${cur.slice(1)} chapters` : `${word} ${this._finishLabel(Number(cur.slice(1)))}`]);
        return `<select data-pod-skip="${kind}">` + opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('') + '</select>';
    },
    _skipSummary(skip) {
        const bit = (kind) => {
            const c = skip?.[kind + 'Chapters'], sec = skip?.[kind + 'Seconds'];
            const word = kind === 'start' ? 'first' : 'last';
            return c ? `the ${word} ${c === 1 ? 'chapter' : c + ' chapters'}` : sec ? `the ${word} ${this._finishLabel(sec)}` : '';
        };
        const parts = [bit('start'), bit('end')].filter(Boolean);
        const ads = skip?.ads === 'all' ? 'all ads' : skip?.ads === 'off' ? 'ads only when you tap' : 'inserted ads';
        return (parts.length ? `Skipping ${parts.join(' and ')} of each episode` : 'No intro or outro skipping') + `; skipping ${ads}`;
    },

    // "Played" thresholds: seconds left at which the server marks an
    // episode played (ABS's library markAsFinishedTimeRemaining, default
    // 10 s; ABS_shim adds a per-show override). Playback carries on to the
    // end either way; it only decides Unplayed and Continue Listening.
    _FINISH_CHOICES: [10, 30, 60, 120, 180, 300, 600],
    _finishLabel(sec) {
        if (sec < 60) return `${sec} s`;
        return sec % 60 ? formatTime(sec) : `${sec / 60} min`;
    },
    _finishOptions(selected) {
        const list = [...this._FINISH_CHOICES];
        if (selected != null && !list.includes(selected)) list.push(selected), list.sort((a, b) => a - b);
        return list.map(n => `<option value="${n}"${n === selected ? ' selected' : ''}>${this._finishLabel(n)} left</option>`).join('');
    },
    _libFinishRemaining(libraryId) {
        const v = (this.libraries || []).find(l => l.id === libraryId)?.settings?.markAsFinishedTimeRemaining;
        return typeof v === 'number' ? v : 10;
    },
    // Settings: the library-wide threshold, per podcast library. The
    // library's own setting, so only its owner sees it, and it holds for
    // everyone on every device.
    _renderFinishSetting() {
        const box = document.getElementById('setting-finish');
        if (!box) return;
        const libs = (this.libraries || []).filter(l => l.mediaType === 'podcast');
        if (!this.isShim || !this.shimCanDelete || !libs.length) { box.innerHTML = ''; return; }
        box.innerHTML = libs.map(l => `<label class="toggle-row">${libs.length > 1 ? esc(l.name) + ': mark' : 'Mark'} episodes played with`
            + `<select data-finish-lib="${esc(l.id)}">${this._finishOptions(this._libFinishRemaining(l.id))}</select></label>`).join('')
            + '<div class="setting-hint">For every show that doesn\'t set its own (on the show\'s page), for everyone. A played episode leaves Unplayed and Continue Listening; it still plays to the end.</div>';
        box.querySelectorAll('[data-finish-lib]').forEach(sel => sel.addEventListener('change', async () => {
            const id = sel.dataset.finishLib;
            try {
                const lib = await this._shimCall(`/api/libraries/${encodeURIComponent(id)}`, {
                    method: 'PATCH', body: JSON.stringify({ settings: { markAsFinishedTimeRemaining: Number(sel.value) } }),
                });
                const l = this.libraries.find(x => x.id === id);
                if (l && lib?.settings) {
                    l.settings = lib.settings;
                    this._saveCachedLibraries({ serverUrl: ABS.serverUrl, username: localStorage.getItem('pholia_username') }, this.libraries);
                }
            } catch (err) {
                alert('Change failed: ' + err.message);
                this._renderFinishSetting();
            }
        }));
    },

    // Every episode the feed has listed (ABS_shim's /all-episodes), newest
    // first, with an Add button on the ones that aren't on the show. A long
    // back catalogue is paged; the search box matches titles.
    async showFeedEpisodes(item, q = '') {
        const meta = item.media?.metadata || {};
        this.setNavTop('All episodes', () => this.showFeedEpisodes(item, q));
        let html = '<div class="inline-search"><div class="search-bar"><span class="search-wrap">'
            + `<input type="text" id="feed-q" placeholder="Search ${esc(meta.title || 'this podcast')}" autocomplete="off" value="${esc(q)}">`
            + '</span></div></div><ul class="tracklist" id="feed-list"></ul>'
            + '<button class="text-btn abb-more hidden" id="feed-more">More</button>';
        this.setContent(html);
        const content = document.getElementById('content');
        const list = content.querySelector('#feed-list');
        const more = content.querySelector('#feed-more');
        const [progress, dl] = await Promise.all([this._episodeProgress(), Offline.fullyDownloadedIds()]);
        let offset = 0, total = 0, gen = 0;
        const load = async () => {
            more.disabled = true;
            // A slower answer to an earlier search must not land in a newer one.
            const mine = ++gen;
            try {
                const r = await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/all-episodes?limit=50&offset=${offset}${q ? '&q=' + encodeURIComponent(q) : ''}`);
                if (mine !== gen || !document.contains(list)) return;
                total = r.total;
                offset += r.episodes.length;
                this._overlayProgress(progress, r.episodes);
                const tmp = document.createElement('ul');
                tmp.innerHTML = r.episodes.map(ep => this._episodeRowHtml(item.id, ep, progress.get(ep.id), { feed: true, dl })).join('');
                const rows = [...tmp.children];
                list.append(...rows);
                this._bindEpisodeRows(list, item, r.episodes, progress, rows);
                if (!total) list.innerHTML = '<div class="empty-state">No episodes match</div>';
            } catch (e) {
                list.insertAdjacentHTML('beforeend', `<div class="empty-state">${esc(e.message)}</div>`);
            }
            more.disabled = false;
            more.classList.toggle('hidden', offset >= total);
            more.textContent = `More (${total - offset} older)`;
        };
        more.addEventListener('click', load);
        let timer = null;
        content.querySelector('#feed-q').addEventListener('input', (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => { q = e.target.value.trim(); offset = 0; list.innerHTML = ''; this.setNavTop(null, () => this.showFeedEpisodes(item, q)); load(); }, 350);
        });
        load();
    },

    // The caller's progress per episode id, from /api/me (one request for
    // every show, and the same on real ABS). ABS_shim instead puts each
    // episode's progress on the lists themselves (`mediaProgress`, copied in
    // by _overlayProgress), and its /api/me no longer carries every played
    // episode (it grew with every episode ever played, and was fetched for
    // every show page): there, no request, just what lists have said so far,
    // which the caller then overlays with the list it is drawing.
    async _episodeProgress() {
        if (this.isShim) return new Map(this._epProgressLast || []);
        const map = new Map();
        try {
            const me = await ABS.request('/api/me');
            for (const p of me?.mediaProgress || []) if (p.episodeId) map.set(p.episodeId, p);
            this._epProgressLast = map;
        } catch {
            // Offline: last time's answer beats "nothing played".
            return this._epProgressLast || map;
        }
        return map;
    },

    // ABS_shim's lists of episodes carry the caller's progress on each one
    // (`mediaProgress`, null when there is none). Copy it into `map`, and
    // into the last known map that instant paints and offline use; an
    // episode without the key (stock ABS, an offline copy) keeps what
    // /api/me said. Returns `map`.
    _overlayProgress(map, episodes) {
        if (!this._epProgressLast) this._epProgressLast = new Map();
        for (const ep of episodes || []) {
            if (!ep?.id || !('mediaProgress' in ep)) continue;
            for (const m of new Set([map, this._epProgressLast])) {
                if (ep.mediaProgress) m.set(ep.id, ep.mediaProgress); else m.delete(ep.id);
            }
        }
        return map;
    },

    // ABS_shim's lists carry a snippet of an episode's notes
    // (`descriptionTrimmed: true`); the whole notes come from the episode's
    // own route. Fills `ep.description` in place, so a redraw, a download
    // and the player have it, and keeps the last 50 for the session (in
    // flight ones too, as the fullscreen player can ask twice). A failure
    // (offline) leaves the snippet. Resolves to the notes.
    _notesMemo: new Map(),
    _applyNotesMemo(itemId, ep) {
        const full = ep?.descriptionTrimmed ? this._notesMemo.get(`${itemId}~${ep.id}`) : null;
        if (typeof full === 'string') { ep.description = full; ep.descriptionTrimmed = false; }
        return ep;
    },
    async _fullNotes(itemId, ep) {
        if (!ep?.descriptionTrimmed) return ep?.description || '';
        const key = `${itemId}~${ep.id}`;
        let got = this._notesMemo.get(key);
        if (got == null) {
            got = ABS.request(`/api/podcasts/${encodeURIComponent(itemId)}/episode/${encodeURIComponent(ep.id)}`)
                .then(r => (typeof r?.description === 'string' ? r.description : null), () => null);
            this._notesMemo.set(key, got);
        }
        const full = await got;
        if (full == null) { if (this._notesMemo.get(key) === got) this._notesMemo.delete(key); return ep.description || ''; }
        this._notesMemo.set(key, full);
        while (this._notesMemo.size > 50) this._notesMemo.delete(this._notesMemo.keys().next().value);
        ep.description = full;
        ep.descriptionTrimmed = false;
        return full;
    },

    // Show notes are HTML (the shim sanitizes them, so does ABS). Shown as
    // text: parsed in an inert DOMParser document, which runs no scripts and
    // loads no images, unlike innerHTML on a detached element.
    _plainText(html) {
        const marked = String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n');
        const text = new DOMParser().parseFromString(marked, 'text/html').body.textContent || '';
        return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
    },

    // Service logos for archived episodes, keyed by ABS_shim's storage
    // provider id. Inline so they show offline; add one per service as
    // archiving learns to target it (only pCloud today).
    _STORAGE_LOGOS: {
        pcloud_oauth: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16.645996 10.693924"><path fill="#1ebcc5" d="M16.645 8.02c0-.843-.39-1.593-.998-2.083-.241.487-.655.87-1.159 1.078.72-.373 1.213-1.123 1.213-1.989 0-1.237-1.001-2.227-2.238-2.227-.094 0-.182.007-.273.018.309.677.481 1.416.481 2.209 0 .051-.003.101-.004.152C13.578 2.303 11.221 0 8.324 0 5.436 0 3.084 2.29 2.982 5.154 2.981 5.111 2.977 5.069 2.977 5.026c0-.792.177-1.541.485-2.216C1.511 3.054 0 4.716 0 6.734c0 2.187 1.773 3.96 3.959 3.96h10.069v-.005c1.45-.029 2.618-1.212 2.618-2.67"/><path fill="#fff" d="M8.941 5.3h-.005-1.171-.005v-.941h.005 1.171.005c.26 0 .47.21.47.47 0 .26-.21.471-.47.471M7.161 3.237c-.333 0-.604.27-.604.604V7.12c0 .333.271.604.604.604.334 0 .605-.271.605-.604v-.698h1.17V6.42c.879 0 1.592-.712 1.592-1.591 0-.879-.712-1.592-1.592-1.592"/></svg>',
    },
    // Archiving is ABS_shim's, and only where the episode's library is on
    // pCloud: the episode says so itself (canArchive), so every list knows.
    _canArchiveEp(ep) { return !!(this.isShim && this.shimCanAdd && ep?.canArchive); },

    // Queue one episode for pCloud, then follow it until pCloud has it:
    // the server copies it within a minute or two, and the row turns from
    // "Archiving" into the pCloud badge without a reload. `view` is where
    // it's shown when that isn't a row (the episode page): alive() while
    // still on screen, redraw() after a change.
    async _archiveEpisode(item, ep, li, progress, view = null) {
        await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/archive`, {
            method: 'POST', body: JSON.stringify({ episodeIds: [ep.id] }),
        });
        ep.archiveState = 'queued';
        ep.archiveError = null;
        let row = li;
        view = view || {
            alive: () => !!row?.isConnected,
            redraw: async () => { row = await this._redrawEpisodeRow(item, ep, row, progress); },
        };
        await view.redraw();
        for (let i = 0; i < 30 && view.alive(); i++) {
            await new Promise(r => setTimeout(r, 15000));
            let fresh;
            try { fresh = await ABS.request(`/api/podcasts/${encodeURIComponent(item.id)}/episode/${encodeURIComponent(ep.id)}`); } catch { continue; }
            if (!fresh || fresh.archiveState === ep.archiveState) continue;
            ep.archiveState = fresh.archiveState;
            ep.archiveError = fresh.archiveError;
            if (ep.archiveState === 'done') {
                // The audio now comes from pCloud: the badge names it.
                ep.audioFile = { ...(ep.audioFile || {}), storage: { provider: 'pcloud_oauth', name: 'pCloud', detail: '' } };
            }
            if (!view.alive()) return;
            await view.redraw();
            if (ep.archiveState === 'done' || ep.archiveState === 'error') return;
        }
    },

    // "Archive all to pCloud" under way (ABS_shim's GET /podcasts/:id/archive,
    // 2026-10-21): a bar under the button, "37 of 140 on pCloud · 3 copying
    // · about 1 h left", asked again every 20 s while the show page is open
    // and the app is in front, redrawing the episode rows whose state moved
    // (`since`). It goes when the copying ends, leaving the result, or a
    // list of failures with "Try again". The copying is the server's: this
    // only watches it. A shim without the route (404) shows nothing.
    async _archiveWatch(item, content, episodes, progress, { started = false } = {}) {
        const box = content.querySelector('[data-archive-progress]');
        if (!box) return;
        if (box._watching) { box._kick?.(); return; }
        box._watching = true;
        const byId = new Map(episodes.map(ep => [ep.id, ep]));
        let since = null, sawWork = started;
        const url = () => `/api/podcasts/${encodeURIComponent(item.id)}/archive${since ? '?since=' + since : ''}`;
        try {
            while (box.isConnected) {
                let st = null;
                try { st = await this._shimCall(url()); }
                catch (err) { if (err.status === 404 || err.status === 403) { box.hidden = true; return; } }
                if (!box.isConnected) return;
                if (st) {
                    since = st.now;
                    for (const ch of st.changed || []) {
                        const ep = byId.get(ch.id);
                        if (!ep || ep.archiveState === ch.archiveState) continue;
                        ep.archiveState = ch.archiveState;
                        ep.archiveError = ch.archiveError;
                        if (ep.archiveState === 'done') ep.audioFile = { ...(ep.audioFile || {}), storage: { provider: 'pcloud_oauth', name: 'pCloud', detail: '' } };
                        const li = content.querySelector(`.episode-row[data-item-id="${CSS.escape(item.id)}"][data-episode-id="${CSS.escape(ep.id)}"]`);
                        if (li) await this._redrawEpisodeRow(item, ep, li, progress);
                    }
                    const busy = st.queued + st.fetching > 0;
                    if (busy) sawWork = true;
                    this._paintArchiveProgress(box, item, content, episodes, progress, st, sawWork);
                    if (!busy) return;
                }
                // 20 s, or straight away when the button queues more; and
                // nothing while the app is in the background.
                await new Promise(resolve => {
                    const t = setTimeout(done, 20000);
                    function done() { clearTimeout(t); box._kick = null; resolve(); }
                    box._kick = done;
                });
                while (box.isConnected && document.visibilityState === 'hidden') {
                    await new Promise(r => document.addEventListener('visibilitychange', r, { once: true }));
                }
            }
        } finally { box._watching = false; box._kick = null; }
    },

    _archiveEta(sec) {
        if (sec < 90) return 'a minute or two';
        const min = Math.round(sec / 60);
        if (min < 60) return `${min} min`;
        const h = Math.floor(min / 60), m = Math.round((min % 60) / 5) * 5;
        return m ? `${h} h ${m} min` : `${h} h`;
    },

    _paintArchiveProgress(box, item, content, episodes, progress, st, sawWork) {
        const busy = st.queued + st.fetching > 0;
        const failures = st.errors?.length
            ? `<details class="pod-archive-fails"><summary>${st.error} couldn't be copied</summary><ul>`
              + st.errors.map(e => `<li><span>${esc(e.title || 'Episode')}</span><span class="text-muted">${esc(e.error || '')}</span></li>`).join('')
              + (st.error > st.errors.length ? `<li class="text-muted">and ${st.error - st.errors.length} more</li>` : '')
              + '</ul></details><button class="text-btn" data-archive-retry>Try those again</button>'
            : '';
        let html = '';
        if (busy) {
            const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
            const bits = [st.fetching ? `${st.fetching} copying` : '', st.queued ? `${st.queued} waiting` : ''].filter(Boolean).join(' · ');
            html = `<div class="pod-archive-line">Copying to pCloud: <strong>${st.done}</strong> of ${st.total} there${bits ? ' · ' + bits : ''}</div>`
                + `<div class="abb-bar"><span style="width:${pct}%"></span></div>`
                + `<div class="pod-archive-note">About ${this._archiveEta(st.etaSeconds)} left. It carries on with Pholia closed${st.requested ? ', and you\'ll get a notification when it\'s done' : ''}.</div>`
                + failures;
        } else if (st.error) {
            html = `<div class="pod-archive-line">${st.done} of ${st.total} episodes on pCloud.</div>` + failures;
        } else if (sawWork) {
            html = `<div class="pod-archive-line">${st.done === st.total ? `All ${st.total} episodes are on pCloud.` : `${st.done} of ${st.total} episodes on pCloud.`}</div>`;
        }
        box.innerHTML = html;
        box.hidden = !html;
        box.querySelector('[data-archive-retry]')?.addEventListener('click', async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            try {
                await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/archive`, { method: 'POST', body: JSON.stringify({ retryFailed: true }) });
                this._archiveWatch(item, content, episodes, progress, { started: true });
            } catch (err) { b.disabled = false; b.textContent = 'Try again failed: ' + err.message; }
        });
    },

    async _redrawEpisodeRow(item, ep, li, progress) {
        if (!li?.isConnected) return null;
        const fresh = document.createElement('ul');
        fresh.innerHTML = this._episodeRowHtml(item.id, ep, progress.get(ep.id), {
            feed: ep.inLibrary !== undefined, dl: await Offline.fullyDownloadedIds(),
            cover: !!li.querySelector('.ep-cover'), show: li.dataset.show || '',
        });
        const row = fresh.firstElementChild;
        if (li.dataset.show) row.dataset.show = li.dataset.show;
        if (li.dataset.playlistId) row.dataset.playlistId = li.dataset.playlistId;
        li.replaceWith(row);
        this._bindEpisodeRows(row.parentElement, item, [ep], progress, [row], li._bindOpts);
        return row;
    },

    _storageBadge(storage) {
        const name = storage?.name || 'cloud storage';
        const logo = this._STORAGE_LOGOS[storage?.provider];
        if (logo) return `<span class="ep-arch ep-arch-logo" title="Archived on ${esc(name)}" aria-label="Archived on ${esc(name)}">${logo}</span>`;
        return `<span class="ep-arch" title="Archived on ${esc(name)}" aria-label="Archived on ${esc(name)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z"/></svg></span>`;
    },

    _episodeRowHtml(itemId, ep, prog, opts = {}) {
        const played = !!prog?.isFinished;
        const pct = played ? 0 : Math.round((prog?.progress || 0) * 1000) / 10;
        const date = ep.publishedAt ? new Date(ep.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        const dur = ep.duration || ep.audioFile?.duration || 0;
        const left = !played && prog?.currentTime > 0 && dur ? Math.max(0, dur - prog.currentTime) : 0;
        const bits = [opts.show, date, dur ? (left ? formatTime(left) + ' left' : formatTime(dur)) : ''];
        if (played) bits.push('Played');
        if (ep.archiveState === 'done') bits.push(`On ${ep.audioFile?.storage?.name || 'pCloud'}`);
        else if (ep.archiveState === 'queued' || ep.archiveState === 'fetching') bits.push('Archiving');
        else if (ep.archiveState === 'error') bits.push('Archive failed');
        // `hidden` is the caller's own (ABS_shim's personal lists); `removed`
        // was the whole show's (an older shim's Hide, now the owner's only).
        if (opts.feed && ep.hidden) bits.push('Hidden');
        else if (opts.feed && ep.inLibrary === false) bits.push(ep.removed ? (this.shimFollows ? 'Removed' : 'Hidden') : 'Not on the show');
        // Downloaded: a badge before the title, not just a word in the grey
        // line, so a show's downloads stand out at a glance.
        const isDl = !!opts.dl?.has(`${itemId}~${ep.id}`);
        const isArch = ep.archiveState === 'done';
        let h = `<li class="tracklist-item episode-row${played ? ' is-played' : ''}${isDl ? ' is-downloaded' : ''}${isArch ? ' is-archived' : ''}" data-item-id="${esc(itemId)}" data-episode-id="${esc(ep.id)}"${opts.show ? ` data-show="${esc(opts.show)}"` : ''}>`;
        h += `<div class="tracklist-progress" style="width:${pct}%"></div>`;
        h += '<div class="episode-main">';
        // The row opens the episode's page (showEpisode); the round button
        // on the right plays it, as in Pocket Casts.
        h += '<button class="tracklist-play episode-open" aria-label="Episode details">';
        if (opts.cover) h += `<img class="ep-cover" src="${ABS.coverUrl(itemId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
        const dlBadge = isDl ? '<span class="ep-dl" title="Downloaded to this phone" aria-label="Downloaded"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M6 11l6 6 6-6M5 21h14"/></svg></span>' : '';
        // Archived: the logo of the service holding the copy (the episode's
        // audioFile.storage, sent by ABS_shim), a plain cloud for one without.
        const archBadge = ep.archiveState === 'done' ? this._storageBadge(ep.audioFile?.storage) : '';
        // The time ("12:34 left") has its own span: the playing episode's
        // row keeps it current (paintPlayingEpisode).
        // An episode with a video (ABS_shim's `videos`; the episode page has
        // the Watch button) gets a quiet camera after its length, or after
        // the date when there is none. Outside .ep-time, whose text the
        // player rewrites.
        const vidAt = ep.videos?.length ? [2, 1, 0].find(i => bits[i]) : undefined;
        const vid = '<span class="ep-video" role="img" aria-label="Has video" title="Has video"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10.5 22 7v10l-7-3.5z"/></svg></span>';
        const line = bits.map((b, i) => !b ? '' : (i === 2 ? `<span class="ep-time">${esc(b)}</span>` : esc(b)) + (i === vidAt ? vid : '')).filter(Boolean).join(' · ');
        h += `<span class="tracklist-title">${dlBadge}${archBadge}<span class="episode-title">${esc(ep.title || 'Untitled')}</span><br><span class="text-muted">${line}</span></span>`;
        h += '</button>';
        // A feed episode the caller hid gets Show again, and one that isn't
        // on the show gets Add, instead of Download.
        const unhidable = !!(opts.feed && ep.hidden && this.isShim && this.shimFollows);
        const addable = !unhidable && opts.feed && ep.inLibrary === false && this.shimCanAdd;
        if (unhidable) h += '<button class="episode-add" data-unhide>Show again</button>';
        else if (addable) h += '<button class="episode-add" data-add>Add</button>';
        // Archive to the library's pCloud, one tap (ABS_shim, when the
        // episode's library can archive and it isn't there or on its way).
        if (this._canArchiveEp(ep) && !['done', 'queued', 'fetching'].includes(ep.archiveState)) {
            h += '<button class="episode-dlbtn" data-quick-archive aria-label="Archive to pCloud" title="Archive to pCloud"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z"/><path d="M12 15V10M9.5 12.5 12 10l2.5 2.5"/></svg></button>';
        }
        // Download to this phone, one tap, without opening the ⋯ menu.
        if (!addable && !unhidable && !isDl && ep.audioFile?.ino && opts.dl) h += '<button class="episode-dlbtn" data-quick-dl aria-label="Download to this phone" title="Download to this phone"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M6 11l6 6 6-6M5 21h14"/></svg></button>';
        // Play, or pause while it's the one playing (CSS swaps the icon on
        // the row's is-playing / is-paused classes, set by paintPlayingEpisode).
        h += '<button class="episode-playbtn" aria-label="Play"><svg class="i-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><svg class="i-pause" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>';
        h += '</div>';
        h += '</li>';
        return h;
    },

    // The episode in the player, wherever it's listed (show page, Latest,
    // playlists, search): its row is highlighted, with bars that move while
    // it plays, and its progress bar and "left" follow the playhead. The
    // list was drawn from /api/me, which the player only updates every 30 s.
    // Called by the player on every tick (Player.updateUI, ~4 Hz while
    // visible) and on play/pause, and after any list is drawn, since a
    // paused player doesn't tick.
    paintPlayingEpisode() {
        const content = document.getElementById('content');
        if (!content) return;
        this._paintEpisodePage();
        const it = Player.item;
        const key = it?.episodeId ? `${it.id}~${it.episodeId}` : '';
        for (const li of content.querySelectorAll('.episode-row.is-playing')) {
            if (`${li.dataset.itemId}~${li.dataset.episodeId}` === key) continue;
            li.classList.remove('is-playing', 'is-paused');
            li.querySelector('.ep-eq')?.remove();
        }
        if (!key) return;
        const rows = content.querySelectorAll(`.episode-row[data-item-id="${CSS.escape(it.id)}"][data-episode-id="${CSS.escape(it.episodeId)}"]`);
        if (!rows.length) return;
        const gt = Player.getGlobalTime(), dur = Player.getTotalDuration();
        const pct = dur > 0 ? Math.min(100, Math.max(0, (gt / dur) * 100)) + '%' : '0%';
        const left = dur > 0 ? formatTime(Math.max(0, dur - gt)) + ' left' : '';
        const paused = !Player.isPlaying;
        for (const li of rows) {
            if (!li.classList.contains('is-playing')) {
                li.classList.add('is-playing');
                li.querySelector('.episode-title')?.insertAdjacentHTML('beforebegin', '<span class="ep-eq" aria-label="Now playing"><i></i><i></i><i></i></span>');
            }
            li.classList.toggle('is-paused', paused);
            const bar = li.querySelector('.tracklist-progress');
            if (bar && bar.style.width !== pct) bar.style.width = pct;
            const time = li.querySelector('.ep-time');
            if (time && left && time.textContent !== left) time.textContent = left;
        }
    },

    // Wire episode rows: tapping the row opens the episode's page, the round
    // button plays it (pauses it while it's the one playing). `rows` limits
    // it to rows just appended (the feed view pages in). `opts.queue(li, ep)`
    // says what plays after it (a playlist's rest); by default, the rows
    // below it on a show's page (_showQueue). The options ride on the row so
    // a redrawn row (_redrawEpisodeRow) keeps them.
    _bindEpisodeRows(root, item, episodes, progress, rows, opts = {}) {
        const byId = new Map(episodes.map(ep => [ep.id, ep]));
        for (const li of rows || root.querySelectorAll('.episode-row')) {
            const ep = byId.get(li.dataset.episodeId);
            if (!ep) continue;
            li._bindOpts = opts;
            const queue = () => opts.queue ? opts.queue(li, ep) : this._showQueue(li, item, ep, progress);
            li.querySelector('.episode-open').addEventListener('click', () =>
                this.showEpisode(item, ep, { queue: queue(), playlistId: li.dataset.playlistId || null, progress }));
            li.querySelector('.episode-playbtn').addEventListener('click', () => this._toggleEpisode(item, ep, queue));
            li.querySelector('[data-quick-archive]')?.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                if (btn.disabled) return;
                btn.disabled = true;
                btn.classList.add('busy');
                try { await this._archiveEpisode(item, ep, li, progress); }
                catch (err) { btn.disabled = false; btn.classList.remove('busy'); alert('Archive failed: ' + err.message); }
            });
            li.querySelector('[data-quick-dl]')?.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                if (btn.disabled) return;
                btn.disabled = true;
                btn.classList.add('busy');
                try {
                    await this.downloadEpisode(item, ep, (received, total) => {
                        if (total) btn.textContent = Math.floor((received / total) * 100) + '%';
                    });
                    await this._redrawEpisodeRow(item, ep, li, progress);
                } catch (err) {
                    btn.disabled = false; btn.classList.remove('busy');
                    alert('Download failed: ' + err.message);
                }
            });
            li.querySelector('[data-add]')?.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                    await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/episodes/add`, {
                        method: 'POST', body: JSON.stringify({ episodeIds: [ep.id] }),
                    });
                    btn.textContent = 'Added';
                    ep.inLibrary = true;
                    ep.hidden = false;
                    this._invalidateTabCache();
                } catch (err) { btn.disabled = false; alert('Add failed: ' + err.message); }
            });
            li.querySelector('[data-unhide]')?.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                    await this._unhideEpisode(item, ep);
                    await this._redrawEpisodeRow(item, ep, li, progress);
                } catch (err) { btn.disabled = false; alert('Show again failed: ' + err.message); }
            });
        }
        this.paintPlayingEpisode();
    },

    // Undo a per-person Hide: ABS_shim's add-to-show also unhides for the
    // caller (and puts it back on the show if it had left it).
    async _unhideEpisode(item, ep) {
        await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/episodes/add`, {
            method: 'POST', body: JSON.stringify({ episodeIds: [ep.id] }),
        });
        ep.hidden = false;
        ep.inLibrary = true;
        this._invalidateTabCache();
    },

    _isLoadedEpisode(itemId, episodeId) {
        return !!episodeId && Player.item?.id === itemId && Player.item?.episodeId === episodeId;
    },

    // A row's round button: pause the episode while it's the one playing,
    // else play it from where it was left. `queue` may be a function, so
    // the rows below are only read when something actually plays.
    _toggleEpisode(item, ep, queue) {
        if (this._isLoadedEpisode(item.id, ep.id) && Player.isPlaying) { Player.pause(); return; }
        this.playEpisode(item.id, ep.id, ep, item, { queue: typeof queue === 'function' ? queue() : queue || null });
    },

    // ── Episode page (2026-10-12) ──
    // Pocket Casts' episode card: artwork, title, a big Play, the actions
    // that used to sit behind a row's ⋯, then Show notes, Chapters and
    // Transcript. Opened by tapping a row; the fullscreen player's title and
    // its Transcript button open the playing episode's (openEpisodeById).
    // While its episode is in the player the page follows it
    // (_paintEpisodePage, run by paintPlayingEpisode on every player tick):
    // the progress, the chapter playing, and the transcript paragraph being
    // spoken, scrolled into view unless you've scrolled in the last 8 s.
    //
    // `opts`: queue (what plays after it, from the list it was opened from),
    // playlistId (offers "Remove from playlist"), progress (the list's map,
    // so the first paint costs no round trip), tab, and pushed (the caller
    // already pushed the nav level).
    async showEpisode(item, ep, opts = {}) {
        const render = () => this.showEpisode(item, ep, {
            ...opts, pushed: false, progress: null,
            tab: this._epPage?.episodeId === ep.id ? this._epPage.tab : opts.tab,
        });
        const navTitle = item.media?.metadata?.title || 'Episode';
        if (opts.pushed) this.setNavTop(navTitle, render); else this.pushNav(navTitle, render);
        this._applyNotesMemo(item.id, ep);
        const [progress, dl, analysis] = await Promise.all([
            opts.progress || this._episodeProgress().then(m => this._overlayProgress(m, [ep])),
            Offline.fullyDownloadedIds(),
            this._analysisFor(this._episodeItem(item, ep), ep.analysis),
        ]);

        const loaded = this._isLoadedEpisode(item.id, ep.id);
        const chapters = ep.chapters?.length ? ep.chapters : (loaded ? Player.chapters || [] : []);
        const hasTranscript = !!(this.isShim && (ep.transcripts?.length || ep.analysis?.transcriptSource === 'whisper'));
        const tabs = [['notes', 'Show notes']];
        if (chapters.length > 1) tabs.push(['chapters', `Chapters <span class="ep-tab-n">${chapters.length}</span>`]);
        if (hasTranscript) tabs.push(['transcript', 'Transcript']);
        const tab = tabs.some(t => t[0] === opts.tab) ? opts.tab : 'notes';

        const meta = item.media?.metadata || {};
        const prog = progress.get(ep.id);
        const played = !!prog?.isFinished;
        const dur = ep.duration || ep.audioFile?.duration || 0;
        const at = !played && prog?.currentTime > 0 ? prog.currentTime : 0;
        const idleLabel = played ? 'Play again'
            : at && dur ? `Resume · ${formatTime(Math.max(0, dur - at))} left`
            : 'Play' + (dur ? ` · ${formatTime(dur)}` : '');
        // A redraw of the same episode keeps the transcript it fetched.
        const prev = this._epPageFor(item.id, ep.id);
        const s = this._epPage = {
            itemId: item.id, episodeId: ep.id, item, ep, opts, progress, tab, chapters, analysis,
            queue: opts.queue || null, played, idleLabel, transcriptP: prev?.transcriptP || null,
            label: '', chIdx: -2, cueIdx: -2, cueStarts: null, touchedAt: 0, barPct: '',
            // Where the caller is in the episode's alternate video, asked
            // for now so Watch can start inside the tap (see _openWatch).
            videoP: prev?.videoP || (this._episodeVideos(ep).some(v => !v.sameAsAudio) ? this._videoProgressFor(item.id, ep.id) : null),
        };

        const date = ep.publishedAt ? new Date(ep.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
        const num = [ep.season ? `Season ${ep.season}` : '', ep.episode ? `Episode ${ep.episode}` : ''].filter(Boolean).join(', ');
        const metaLine = [date, num, played ? 'Played' : ''].filter(Boolean).join(' · ');
        const pct = played ? 100 : dur ? Math.min(100, (at / dur) * 100) : 0;

        let h = '<div class="episode-page" data-ep-page>';
        h += '<div class="ep-hero">';
        h += `<img class="ep-hero-cover" src="${ABS.coverUrl(item.id)}" alt="" onerror="this.style.visibility='hidden'">`;
        if (meta.title) h += `<button class="ep-hero-show" data-ep-show>${esc(meta.title)}</button>`;
        h += `<h2 class="ep-hero-title">${esc(ep.title || 'Untitled')}</h2>`;
        if (metaLine) h += `<div class="ep-hero-meta">${esc(metaLine)}</div>`;
        h += `<div class="ep-hero-bar"><div data-ep-bar style="width:${pct}%"></div></div>`;
        // An episode with video (ABS_shim's `videos`) gets Watch beside
        // Play, which stays the default and is unchanged.
        const videos = this._episodeVideos(ep);
        const playBtn = '<button class="play-btn-large ep-play-big" data-ep-play>'
            + '<svg class="i-play" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
            + '<svg class="i-pause" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
            + `<span data-ep-play-label>${esc(idleLabel)}</span></button>`;
        h += videos.length
            ? `<div class="ep-play-row">${playBtn}<button class="ep-watch-btn" data-ep-watch aria-label="Watch the video">`
                + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor"/></svg>'
                + '<span>Watch</span></button></div>'
            : playBtn;
        h += this._episodeActionsHtml(item, ep, { played, downloaded: dl.has(`${item.id}~${ep.id}`), playlistId: opts.playlistId });
        h += '</div>';
        if (tabs.length > 1) {
            h += '<div class="ep-tabs" role="tablist">'
                + tabs.map(([k, label]) => `<button role="tab" data-ep-tab="${k}" aria-selected="${k === tab}">${label}</button>`).join('')
                + '<button class="ep-now hidden" data-ep-now>Now</button></div>';
        }
        const notes = this._notesHtml(ep.description || ep.subtitle || '', dur);
        h += `<div class="ep-panel ep-notes${tab === 'notes' ? '' : ' hidden'}" data-ep-panel="notes">${notes || '<div class="text-muted">No show notes</div>'}</div>`;
        if (chapters.length > 1) h += `<div class="ep-panel${tab === 'chapters' ? '' : ' hidden'}" data-ep-panel="chapters">${this._epChaptersHtml(chapters, ep, analysis)}</div>`;
        if (hasTranscript) h += `<div class="ep-panel ep-transcript${tab === 'transcript' ? '' : ' hidden'}" data-ep-panel="transcript"><div class="text-muted">Loading the transcript…</div></div>`;
        h += '</div>';
        this.setContent(h);
        this._bindEpisodePage(s);
        if (tab === 'transcript') this._loadEpisodeTranscript(s);
        this._paintEpisodePage(true);
        if (this.isShim && this.shimCanAdd) this._loadAnalysisState(s);
        // A snippet (ABS_shim lists): the whole notes replace it when they come.
        if (ep.descriptionTrimmed) {
            this._fullNotes(item.id, ep).then(() => {
                const panel = this._epPage === s && this._epPageShowing(s) && document.querySelector('#content [data-ep-panel="notes"]');
                if (panel && !ep.descriptionTrimmed) panel.innerHTML = this._notesHtml(ep.description || ep.subtitle || '', dur) || '<div class="text-muted">No show notes</div>';
            });
        }
    },

    // The fullscreen player and a Latest row painted from last session's
    // render (no episode objects) only know the ids. Offline, the page is
    // built from what the phone holds: the episode in the player, or a
    // downloaded copy.
    async openEpisodeById(itemId, episodeId, opts = {}) {
        this.pushNav('Episode', () => this.openEpisodeById(itemId, episodeId, opts));
        this.showLoading();
        let show = null, ep = null;
        try {
            show = await ABS.getItem(itemId);
            ep = show?.media?.episodes?.find(e => e.id === episodeId) || null;
        } catch {}
        if (!ep) {
            const local = await this._episodeFromPhone(itemId, episodeId);
            if (local) ({ show, ep } = local);
        }
        if (!ep) { this.setContent('<div class="empty-state">Episode not found</div>'); return; }
        this.showEpisode(show, ep, { ...opts, pushed: true });
    },

    async _episodeFromPhone(itemId, episodeId) {
        const pi = this._isLoadedEpisode(itemId, episodeId) ? Player.item
            : (await Offline.fullyDownloaded()).find(i => Offline.oid(i) === `${itemId}~${episodeId}`);
        if (!pi) return null;
        const m = pi.media || {};
        return {
            show: { id: itemId, libraryId: pi.libraryId, media: { metadata: { title: m.metadata?.podcastTitle || m.metadata?.authorName || '' }, ...(m.skip !== undefined ? { skip: m.skip } : {}) } },
            ep: {
                id: episodeId, title: m.metadata?.title || '', description: m.metadata?.description || '',
                publishedAt: m.metadata?.publishedAt || null, duration: m.duration || 0,
                chapters: m.chapters || [], audioFile: m.audioFiles?.[0] || null, transcripts: m.transcripts || [],
                analysis: m.analysis || null, dynamicAds: !!m.dynamicAds,
            },
        };
    },

    _epPageShowing(s) {
        return this._epPage === s && !!document.querySelector('#content [data-ep-page]');
    },
    // The page's state when it's showing this episode (each redraw makes a
    // new one, so long-running work asks by id).
    _epPageFor(itemId, episodeId) {
        const s = this._epPage;
        return s && s.itemId === itemId && s.episodeId === episodeId && this._epPageShowing(s) ? s : null;
    },

    // Redraw after an action (download, played, archive…) on the same nav
    // level, keeping the tab.
    _rerenderEpisodePage(s) {
        if (!this._epPageShowing(s)) return;
        this.showEpisode(s.item, s.ep, { ...s.opts, pushed: true, progress: s.progress, tab: s.tab });
    },

    // ── Watch: episodes with video (ABS_shim, 2026-10-22) ──
    // ABS_shim lists an episode's videos (`videos`, [] for most). Two kinds:
    // `sameAsAudio`, the episode's own file being a video (Incognito Mode's
    // 3.2 GB mp4, labelled audio/mpeg), and a feed's alternate (LINUX
    // Unplugged's "Full HD Video"), which is ANOTHER EDIT, minutes longer or
    // shorter than the mp3. So an alternate keeps its own place
    // (`videoProgress`, PUT …/video-progress; Joseph chose that over mapping
    // one timeline onto the other), while the episode's own file writes the
    // ordinary listening position, so Listen carries on where Watch stopped.
    // "Played" is shared: reaching the end of either marks the episode
    // played the ordinary way.
    //
    // The view is an overlay over everything holding a plain <video
    // playsinline controls>, streamed natively from the shim (never through
    // the worker; sw.js says so). Opening it pauses the audio player with its
    // own pause(); the video pauses when the player starts again (lock
    // screen, headphones) and when the app goes to the background, which iOS
    // would do anyway. No hand-off to the audio.
    _videoPos: new Map(),   // `item~episode` → {position, duration, at}
    _watch: null,

    _episodeVideos(ep) {
        return Array.isArray(ep?.videos) ? ep.videos.filter(v => v && typeof v.url === 'string' && v.url) : [];
    },
    _videoLabel(v) {
        const q = v.height ? `${v.height}p` : '';
        return [v.sameAsAudio ? 'The episode itself' : v.title || 'Video', q].filter(Boolean).join(' · ');
    },
    // Seconds left at which the episode counts as played: the show's own
    // setting, else the library's (default 10).
    _finishWindowFor(item) {
        const own = item?.media?.markAsFinishedTimeRemaining;
        return typeof own === 'number' ? own : this._libFinishRemaining(item?.libraryId);
    },

    // The caller's place in the episode's alternate video (the episode route
    // carries it). A save made while the answer was on its way is newer than
    // the answer and wins.
    async _videoProgressFor(itemId, episodeId) {
        const key = `${itemId}~${episodeId}`;
        const asked = Date.now();
        try {
            const r = await ABS.request(`/api/podcasts/${encodeURIComponent(itemId)}/episode/${encodeURIComponent(episodeId)}`);
            const vp = r?.videoProgress;
            const mine = this._videoPos.get(key);
            if (!(mine && mine.at >= asked)) this._rememberVideoPos(key, Number(vp?.position) || 0, Number(vp?.duration) || null, asked);
        } catch {}
        return this._videoPos.get(key) || null;
    },
    _rememberVideoPos(key, position, duration, at = Date.now()) {
        this._videoPos.delete(key);
        this._videoPos.set(key, { position, duration, at });
        while (this._videoPos.size > 50) this._videoPos.delete(this._videoPos.keys().next().value);
    },

    // Where Watch starts, when that's known without waiting: the listening
    // position for the episode's own file (the player's, when it holds the
    // episode; else the server's, or a newer local one, as startItem
    // decides), the remembered place for an alternate. null: an alternate
    // whose place hasn't come back yet.
    _watchStartNow(s, v) {
        if (!v.sameAsAudio) {
            const m = this._videoPos.get(`${s.itemId}~${s.episodeId}`);
            return m ? m.position || 0 : null;
        }
        // (Only once its file is loaded: a start still on its way reads 0.)
        if (this._isLoadedEpisode(s.itemId, s.episodeId) && Player.audio.readyState >= 1) return Player.getGlobalTime() || 0;
        const prog = s.progress?.get(s.episodeId) || null;
        if (prog?.isFinished) return 0;
        let t = prog?.currentTime || 0;
        try {
            const local = JSON.parse(localStorage.getItem(`pholia_pos_${s.itemId}:${s.episodeId}`));
            if (local && typeof local.t === 'number' && typeof local.at === 'number' && local.at > (prog?.lastUpdate || 0) + 2000) t = local.t;
        } catch {}
        return t;
    },

    async _openWatch(s, idx = 0) {
        const videos = this._episodeVideos(s.ep);
        const v = videos[idx];
        if (!v) return;
        this._closeWatch({ redraw: false });
        // One thing at a time: the player's own pause (it syncs as usual).
        const pausedPlayer = Player.isPlaying;
        if (pausedPlayer) Player.pause();
        const { item, ep } = s;
        const key = `${item.id}~${ep.id}`;
        // The episode's own file, already in the player: while it's watched,
        // the paused player's 30 s sync would keep writing back where the
        // listening stopped, over where the watching is. Stopped here,
        // started again on close (or as soon as the player plays).
        const held = !!v.sameAsAudio && this._isLoadedEpisode(item.id, ep.id);
        const stoppedSync = held && !!Player.syncInterval;
        if (stoppedSync) Player.stopSync();

        const showTitle = item.media?.metadata?.title || '';
        const note = v.sameAsAudio
            ? 'The same recording as the audio, so watching moves your listening position too.'
            : 'A separate edit from the audio, so it keeps its own place. Reaching the end marks the episode played.';
        const el = document.createElement('div');
        el.className = 'watch-view';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Watch');
        el.innerHTML = '<div class="watch-head"><div class="watch-titles">'
            + `<div class="watch-title">${esc(ep.title || 'Untitled')}</div>`
            + (showTitle ? `<div class="watch-show">${esc(showTitle)}</div>` : '')
            + '</div><button class="watch-close" data-watch-close aria-label="Close">&times;</button></div>'
            + `<div class="watch-stage"><video playsinline webkit-playsinline controls preload="metadata" poster="${ABS.coverUrl(item.id)}"></video></div>`
            + '<div class="watch-foot">'
            + (videos.length > 1
                ? '<select class="watch-pick" data-watch-pick aria-label="Which video">'
                    + videos.map((x, i) => `<option value="${i}"${i === idx ? ' selected' : ''}>${esc(this._videoLabel(x))}</option>`).join('')
                    + '</select>'
                : `<div class="watch-what">${esc(this._videoLabel(v))}</div>`)
            + `<div class="watch-note">${esc(note)}</div><div class="watch-msg" data-watch-msg hidden></div></div>`;
        document.body.appendChild(el);
        const video = el.querySelector('video');
        const w = this._watch = {
            s, item, ep, itemId: item.id, episodeId: ep.id, key, v, el, video, held, stoppedSync,
            pausedPlayer, openedAt: Date.now(), yielded: false,
            win: this._finishWindowFor(item), ready: false, start: 0, lastSaved: null, lastTick: null,
            savedOnce: false, finished: false, timer: null, offs: [],
        };
        const on = (target, type, fn, opts) => {
            target.addEventListener(type, fn, opts);
            w.offs.push(() => target.removeEventListener(type, fn, opts));
        };
        const msg = (text) => {
            const m = el.querySelector('[data-watch-msg]');
            m.textContent = text || '';
            m.hidden = !text;
        };
        on(el.querySelector('[data-watch-close]'), 'click', () => this._closeWatch());
        on(document, 'keydown', (e) => { if (e.key === 'Escape') this._closeWatch(); });
        const pick = el.querySelector('[data-watch-pick]');
        if (pick) on(pick, 'change', () => this._openWatch(s, Number(pick.value)));
        on(video, 'timeupdate', () => this._watchTick(w));
        on(video, 'pause', () => {
            if (video.ended) return;
            // Paused for the player playing this same file: the player's
            // position is the one that counts now, not the video's.
            if (w.yielded) { w.yielded = false; w.lastSaved = video.currentTime; return; }
            this._saveWatch(w);
        });
        on(video, 'ended', () => this._watchFinished(w));
        on(video, 'playing', () => msg(''));
        // Played from the video's own controls while the player was going
        // (it started after Watch opened): the player's pause again.
        on(video, 'play', () => { if (Player.isPlaying) Player.pause(); });
        on(video, 'error', () => {
            const code = video.error?.code;
            msg(code === 4 ? "This video can't be played here." : "Couldn't load the video. Check the connection and try again.");
        });
        // The app going to the background: pause and save now, keepalive so
        // the save outlives a suspended page. An episode held by the player
        // says its place even unmoved, and again on coming back, because the
        // player's own hidden-page sync (an older position) goes out at the
        // same moment, just before this one.
        on(document, 'visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                video.pause();
                this._saveWatch(w, { keepalive: true, force: w.held });
            } else if (w.held) {
                this._saveWatch(w, { force: true });
            }
        });
        on(window, 'pagehide', () => this._saveWatch(w, { keepalive: true, force: w.held }));
        // The player started (lock screen, headphones, Control Center): the
        // video gives way, and the player is the player again. Except the
        // start Watch interrupted: the player retries at canplay a play()
        // that a pause refused mid-load, so a Watch tapped while the audio
        // was still loading would otherwise lose to it. Paused again, once.
        on(Player.audio, 'playing', () => {
            if (w.pausedPlayer && Date.now() - w.openedAt < 8000) {
                w.pausedPlayer = false;
                Player.pause();
                return;
            }
            w.pausedPlayer = false;
            if (!video.paused) {
                w.yielded = !!w.v.sameAsAudio && this._isLoadedEpisode(w.itemId, w.episodeId);
                video.pause();
            }
            if (w.held) {
                w.held = false;
                if (w.stoppedSync && !Player.syncInterval) Player.startSync();
                w.stoppedSync = false;
            }
        });
        w.timer = setInterval(() => { if (!video.paused) this._saveWatch(w); }, 15000);

        video.src = v.url.startsWith('http') ? v.url : `${ABS.serverUrl}${v.url}${v.url.includes('?') ? '&' : '?'}token=${ABS.token}`;
        let start = this._watchStartNow(s, v);
        if (start === null) {
            // The page asked for the alternate's place when it opened, so
            // this has normally long answered. Wait a little, then start
            // anyway; a play() refused for the wait leaves the video's own
            // controls, already at the right place.
            await Promise.race([s.videoP || this._videoProgressFor(item.id, ep.id), new Promise(r => setTimeout(r, 2500))]);
            if (this._watch !== w) return;
            start = this._watchStartNow(s, v) ?? 0;
        }
        w.start = start;
        // Not saved until the start is applied, or closing before the
        // metadata arrives would write 0 over the real place.
        const applyStart = () => {
            if (this._watch !== w) return;
            const d = video.duration;
            let t = w.start || 0;
            // At (or within the played window of) the end: from the top,
            // as Play again does.
            if (Number.isFinite(d) && d > 0 && t >= d - Math.max(w.win, 1)) t = 0;
            const ready = (at) => { w.ready = true; w.lastSaved = w.lastTick = at; };
            if (t <= 0) { ready(0); return; }
            // Ready only once the start seek has landed there. Chrome was
            // seen finishing one at 0 (paused while its range request was
            // out), and a save then would have written 0 over the place. A
            // seek that lands elsewhere is tried once more; a `seeking` to
            // somewhere else is the viewer's own, and theirs to keep.
            let tries = 0;
            on(video, 'seeking', () => {
                if (!w.ready && Math.abs(video.currentTime - t) > 2) ready(video.currentTime);
            });
            on(video, 'seeked', () => {
                if (w.ready) return;
                if (Math.abs(video.currentTime - t) <= 2) { ready(t); return; }
                if (++tries < 2) { video.currentTime = t; return; }
                ready(video.currentTime);
            });
            video.currentTime = t;
        };
        if (video.readyState >= 1) applyStart();
        else on(video, 'loadedmetadata', applyStart, { once: true });
        const p = video.play();
        if (p?.catch) p.catch(() => {});
    },

    _watchTick(w) {
        const video = w.video;
        const t = video.currentTime, d = video.duration, prev = w.lastTick;
        if (!w.ready) return;
        w.lastTick = t;
        if (w.finished || video.paused || video.seeking || !(d > 0)) return;
        // Reached by playing, not by a jump (more than 10 s between ticks
        // is a seek), as the outro skip judges it.
        if (prev != null && t >= prev && t - prev < 10 && d - t <= w.win) this._watchFinished(w);
    },

    // Same Map the page draws from, the list's copy of the episode and the
    // last-known progress: a redraw overlays all three (see Mark played).
    _watchProgress(w, patch) {
        const prev = w.s.progress?.get(w.episodeId) || w.ep.mediaProgress || {};
        const p = { ...prev, episodeId: w.episodeId, ...patch, lastUpdate: Date.now() };
        w.s.progress?.set(w.episodeId, p);
        w.ep.mediaProgress = p;
        this._epProgressLast?.set(w.episodeId, p);
    },

    // Every ~15 s while playing, on pause, on close, on hidden and pagehide.
    // `force` says a place already written again (the hidden-page race in
    // _openWatch); the untouched start is never written, so opening Watch
    // on a played episode and closing it again un-marks nothing.
    _saveWatch(w, { keepalive = false, force = false } = {}) {
        if (!w.ready) return;
        const pos = w.video.currentTime, d = w.video.duration;
        if (!Number.isFinite(pos)) return;
        if (Math.abs(pos - w.lastSaved) < 1 && !(force && w.savedOnce)) return;
        w.lastSaved = pos;
        w.savedOnce = true;
        const dur = Number.isFinite(d) && d > 0 ? d : 0;
        const opts = keepalive ? { keepalive: true } : {};
        if (w.v.sameAsAudio) {
            // One timeline with the audio: this IS the listening position.
            // No isFinished, as the player's own sync for an episode: false
            // would be "Mark unplayed" to the shim, which instead un-marks
            // a played episode watched again from well before the end (its
            // replay rule); the page's copy follows suit.
            const body = { currentTime: pos, duration: dur, progress: dur ? pos / dur : 0 };
            const replay = !w.finished && dur && pos < dur - w.win - 60 && (w.s.progress?.get(w.episodeId) || w.ep.mediaProgress)?.isFinished;
            this._watchProgress(w, replay ? { ...body, isFinished: false } : body);
            // The player's local resume slot (startItem prefers it when the
            // server's copy is older), except once played: a slot at the end
            // would start the next listen there.
            if (!w.finished) {
                try { localStorage.setItem(`pholia_pos_${w.itemId}:${w.episodeId}`, JSON.stringify({ t: pos, at: Date.now() })); } catch {}
            }
            ABS.updateProgress(`${w.itemId}/${w.episodeId}`, body, opts).catch(e => console.warn('Watch save failed', e));
        } else {
            this._rememberVideoPos(w.key, pos, dur || null);
            ABS.request(`/api/podcasts/${encodeURIComponent(w.itemId)}/episode/${encodeURIComponent(w.episodeId)}/video-progress`, {
                method: 'PUT', body: JSON.stringify({ position: pos, ...(dur ? { duration: dur } : {}) }), ...opts,
            }).catch(e => console.warn('Watch save failed', e));
        }
    },

    // The end of the video, or into the played window by playing: the
    // episode is played, as the page's Mark played does it (an alternate's
    // mark carries the AUDIO's length, since the mark is the episode's). A
    // failed write waits in the outbox like the player's finish does.
    _watchFinished(w) {
        if (w.finished || !w.ready) return;
        w.finished = true;
        const d = w.video.duration > 0 ? w.video.duration : 0;
        const epDur = w.ep.duration || w.ep.audioFile?.duration || 0;
        const dur = w.v.sameAsAudio ? (d || epDur) : epDur;
        const body = { isFinished: true, progress: 1, currentTime: dur, duration: dur };
        this._watchProgress(w, body);
        (this._playedHere ||= new Set()).add(w.episodeId);
        if (w.v.sameAsAudio) {
            try { localStorage.removeItem(`pholia_pos_${w.itemId}:${w.episodeId}`); } catch {}
        } else {
            this._saveWatch(w, { force: true });   // the video's own place: its end
        }
        ABS.updateProgress(`${w.itemId}/${w.episodeId}`, body)
            .catch(() => this._queueEpisodeFinished({ id: w.itemId, episodeId: w.episodeId, media: { duration: dur } }));
        this._invalidateTabCache();
    },

    _closeWatch({ redraw = true } = {}) {
        const w = this._watch;
        if (!w) return;
        this._watch = null;
        clearInterval(w.timer);
        w.offs.forEach(off => off());
        const pos = w.video.currentTime;
        this._saveWatch(w, { force: w.held });
        // Drop the stream: these files are gigabytes, through the Worker.
        try { w.video.pause(); w.video.removeAttribute('src'); w.video.load(); } catch {}
        w.el.remove();
        // The episode's own file, held paused by the player: put the player
        // where the watching stopped (its seek for a paused element, as its
        // skip buttons do), so Listen carries on from there, and let it sync
        // again. Played to the end too: left where it was, its next sync
        // would be a "replay" from long before the end and un-mark it.
        if (w.held && w.ready && Number.isFinite(pos) && this._isLoadedEpisode(w.itemId, w.episodeId)
            && !Player.isPlaying && Math.abs(pos - Player.getGlobalTime()) >= 1) {
            Player.loadTime(pos, 'watch', { keepPaused: true });
        }
        if (w.stoppedSync && !Player.syncInterval && Player.item) Player.startSync();
        if (!redraw) return;
        const cur = this._epPageFor(w.itemId, w.episodeId);
        if (cur) this._rerenderEpisodePage(cur);
    },

    // ── Episode analysis (ABS_shim, run on wharf) ──
    // The page says where this episode's analysis stands, and "Analyse now"
    // queues it. While it waits or runs, the state is asked for again every
    // 15 s; once done, the episode's chapters and ad ranges are fetched and
    // the page (and the player, if it has this episode) take them.
    async _loadAnalysisState(s) {
        try {
            const st = await this._shimCall(`/api/podcasts/${encodeURIComponent(s.itemId)}/episode/${encodeURIComponent(s.episodeId)}/analysis`);
            this._paintAnalysisState(s, st);
            if (st?.state === 'queued' || st?.state === 'running') this._watchAnalysis(s);
        } catch {}
    },
    _analysisText(st) {
        const c = st?.current;
        if (!st?.state || !c) return '';
        if (st.state === 'queued' && st.waitingFor === 'archive') return 'Archiving first…';
        if (st.state === 'queued') return 'Analysis waiting' + (c.error ? ` (${c.error})` : '');
        if (st.state === 'running') return 'Analysing…';
        if (st.state === 'error') return 'Analysis failed: ' + (c.error || 'unknown error');
        const a = st.analysis;
        if (!a) return c.size === st.currentSize ? 'Analysed' : '';
        const n = a.ads?.length || 0;
        const bits = [n ? `${n} ad${n === 1 ? '' : 's'} found` : 'no ads found'];
        if (a.chaptersSource === 'generated') bits.push('chapters written');
        if (a.transcriptSource === 'whisper') bits.push('transcript made');
        else if (a.aligned && a.transcriptSource === 'publisher') bits.push('times aligned');
        return 'Analysed: ' + bits.join(', ');
    },
    _paintAnalysisState(s, st) {
        if (!this._epPageShowing(s)) return;
        const out = document.querySelector('#content [data-ep-analysis]');
        if (out) out.textContent = (st ? ' ' + this._analysisText(st) : '');
        const btn = document.querySelector('#content [data-ep-analyse]');
        if (btn && st) btn.hidden = !this._analysisWanted(st);
        s.analysisState = st?.state || null;
    },
    // "Analyse now" is offered only when pressing it would do something:
    // never analysed, failed, or done for a stitch no longer served (a
    // streamed copy re-stitched since). Not while one is queued or running
    // (the shim leaves those alone), nor when the shim has no wharf.
    _analysisWanted(st) {
        if (st.configured === false) return false;
        if (st.state === 'queued' || st.state === 'running') return false;
        if (st.state === 'done' && (st.analysis || st.current?.size === st.currentSize)) return false;
        return true;
    },
    _watchAnalysis(s) {
        if (s.analysisTimer) return;
        const started = Date.now();
        const tick = async () => {
            s.analysisTimer = null;
            if (!this._epPageShowing(s) || Date.now() - started > 20 * 60 * 1000) return;
            let st = null;
            try {
                st = await this._shimCall(`/api/podcasts/${encodeURIComponent(s.itemId)}/episode/${encodeURIComponent(s.episodeId)}/analysis`);
            } catch {}
            if (st) this._paintAnalysisState(s, st);
            if (st?.state === 'done') { await this._takeAnalysis(s); return; }
            if (!st || st.state === 'queued' || st.state === 'running') s.analysisTimer = setTimeout(tick, 15000);
        };
        s.analysisTimer = setTimeout(tick, 15000);
    },
    // A finished analysis changes the episode's chapters (shifted or
    // written) and adds ad ranges: fetch the episode again and redraw.
    async _takeAnalysis(s) {
        let fresh;
        try {
            fresh = await this._shimCall(`/api/podcasts/${encodeURIComponent(s.itemId)}/episode/${encodeURIComponent(s.episodeId)}`);
        } catch { return; }
        if (!fresh) return;
        Object.assign(s.ep, { chapters: fresh.chapters || [], analysis: fresh.analysis || null, dynamicAds: !!fresh.dynamicAds });
        if (this._isLoadedEpisode(s.itemId, s.episodeId) && Player.item?.media) {
            Player.item.media.analysis = s.ep.analysis;
            if (s.ep.chapters.length) { Player.item.media.chapters = s.ep.chapters; Player.chapters = s.ep.chapters; }
            Player._setAnalysisFor(Player.item);
        }
        s.transcriptP = null;
        this._invalidateTabCache?.();
        this._rerenderEpisodePage(s);
    },

    _episodeActionsHtml(item, ep, { played, downloaded, playlistId }) {
        const icon = (d) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
        const btn = (attr, svg, label, cls = '') => `<button class="ep-act${cls}" ${attr}>${svg}<span>${esc(label)}</span></button>`;
        let h = '<div class="ep-actions">';
        if (ep.audioFile?.ino) {
            h += downloaded
                ? btn('data-ep-dl-remove', icon('<path d="M12 4v10M7 10l5 5 5-5"/><path d="M5 20h14"/>'), 'Downloaded', ' is-on')
                : btn('data-ep-dl', icon('<path d="M12 4v10M7 10l5 5 5-5"/><path d="M5 20h14"/>'), 'Download');
        }
        if (ep.archiveState === 'done') {
            h += `<button class="ep-act is-on" disabled>${this._storageBadge(ep.audioFile?.storage)}<span>On ${esc(ep.audioFile?.storage?.name || 'pCloud')}</span></button>`;
        } else if (ep.archiveState === 'queued' || ep.archiveState === 'fetching') {
            h += btn('disabled', icon('<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z"/>'), 'Archiving…', ' busy');
        } else if (this._canArchiveEp(ep) || (this.isShim && this.shimCanAdd && item.media?.canArchive)) {
            h += btn('data-ep-archive', icon('<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18z"/><path d="M12 15v-5M9.5 12.5 12 10l2.5 2.5"/>'), 'Archive');
        }
        h += btn('data-ep-played', icon('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/>'), played ? 'Played' : 'Mark played', played ? ' is-on' : '');
        h += btn('data-ep-playlist', icon('<path d="M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6"/>'), 'Playlist');
        h += '</div>';
        // Less common, and worded too long for an icon: plain text below.
        const more = [];
        // No "Hide episode" button since 2026-10-21: Joseph never used it
        // and it sat where a stray tap would hit it. The shim still hides
        // per person (ABS's DELETE, for other ABS apps), so an episode hidden
        // that way keeps its way back here.
        if (this.isShim && this.shimFollows && ep.hidden) {
            more.push('<span class="text-muted">Hidden for you</span><button class="text-btn" data-ep-unhide>Show again</button>');
        } else if (this.isShim && ep.inLibrary === false) {
            if (this.shimCanAdd) more.push('<button class="text-btn" data-ep-add>Add to the show</button>');
        }
        if (this.isShim && this.shimCanAdd) {
            // Hidden while an analysis of the file served now exists (the shim
            // serves `analysis` only then): a re-run of the same file gives
            // the same answer. _paintAnalysisState settles it once the state
            // is in.
            more.push(`<button class="text-btn" data-ep-analyse${ep.analysis ? ' hidden' : ''}>Analyse now</button><span class="text-muted" data-ep-analysis></span>`);
        }
        if (playlistId) more.push('<button class="text-btn" data-ep-unlist>Remove from playlist</button>');
        if (ep.archiveError) more.push(`<span class="text-muted">Archiving failed: ${esc(ep.archiveError)}</span>`);
        h += '<div class="ep-more" data-ep-more>' + more.join('') + '</div>';
        return h;
    },

    // Chapter and transcript times come from the feed, made from the
    // show's master file. A host that stitches ads in at download time
    // (ABS_shim marks the episode `dynamicAds`) serves a longer file, so
    // from the first ad on those times run early by the ads played so far,
    // and differently for every listener. Nothing here can know by how
    // much; the page says so rather than pretend.
    //
    // Since 2026-10-13 ABS_shim can know: an episode analysis (whisper on
    // wharf, of the very file served) maps those times onto it, and then
    // `analysis.aligned` is true and the note goes. `analysis` here is the
    // one that applies on this phone (_analysisFor), not merely the server's.
    _dynamicAdsNote(ep, analysis = ep?.analysis, kind = 'chapters') {
        if (!ep?.dynamicAds || analysis?.aligned) return '';
        if (kind === 'chapters' && analysis?.chaptersSource === 'generated') return '';
        return '<div class="text-muted tr-note tr-note-top">This show\'s host adds ads into the audio as it\'s downloaded, so from the first ad on these times run a little early (by the length of the ads played so far).</div>';
    },
    _epChaptersHtml(chapters, ep, analysis = ep?.analysis) {
        return this._dynamicAdsNote(ep, analysis) + '<ul class="tracklist ep-chapters">' + chapters.map((c, i) =>
            `<li class="tracklist-item" data-ch="${i}"><div class="tracklist-progress"></div>`
            + `<button class="tracklist-play"><span class="tracklist-num">${i + 1}</span>`
            + `<span class="tracklist-title">${esc(c.title || `Chapter ${i + 1}`)}<br><span class="text-muted">${formatTime(Math.max(0, (c.end || 0) - (c.start || 0)))}</span></span>`
            + `<span class="tracklist-duration">${formatTime(c.start || 0)}</span></button></li>`).join('') + '</ul>';
    },

    // Show notes as HTML, rebuilt from an inert DOMParser document keeping
    // only text, paragraphs, lists, line breaks, emphasis and http(s)/mailto
    // links (ABS and the shim sanitize too; this doesn't rely on it). Times
    // written in the notes ("12:34", "1:02:03") become buttons that play
    // from there, as in Pocket Casts. Notes with no markup keep their lines.
    _notesHtml(src, dur) {
        src = String(src || '').trim();
        if (!src) return '';
        if (!/<[a-z][^>]*>/i.test(src)) src = esc(src).replace(/\n/g, '<br>');
        const doc = new DOMParser().parseFromString(src, 'text/html');
        const TS = /\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g;
        const KEEP = { p: 'p', div: 'p', ul: 'ul', ol: 'ol', li: 'li', strong: 'strong', b: 'strong', em: 'em', i: 'em', blockquote: 'blockquote', h1: 'p', h2: 'p', h3: 'p', h4: 'p', h5: 'p', h6: 'p' };
        const SKIP = new Set(['script', 'style', 'img', 'iframe', 'object', 'video', 'audio', 'svg', 'form', 'button', 'input', 'select', 'textarea', 'template', 'noscript']);
        const walk = (node, inLink) => {
            let out = '';
            for (const n of node.childNodes) {
                if (n.nodeType === 3) {
                    const text = n.textContent;
                    if (inLink) { out += esc(text); continue; }
                    let last = 0, m;
                    TS.lastIndex = 0;
                    while ((m = TS.exec(text))) {
                        const t = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
                        if (dur && t > dur) continue;
                        out += esc(text.slice(last, m.index)) + `<button class="ep-ts" data-t="${t}">${esc(m[0])}</button>`;
                        last = m.index + m[0].length;
                    }
                    out += esc(text.slice(last));
                    continue;
                }
                if (n.nodeType !== 1) continue;
                const tag = n.tagName.toLowerCase();
                if (SKIP.has(tag)) continue;
                if (tag === 'br') { out += '<br>'; continue; }
                if (tag === 'a') {
                    const inner = walk(n, true);
                    const href = (n.getAttribute('href') || '').trim();
                    out += /^(https?:|mailto:)/i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
                    continue;
                }
                const inner = walk(n, inLink);
                out += KEEP[tag] ? `<${KEEP[tag]}>${inner}</${KEEP[tag]}>` : inner;
            }
            return out;
        };
        return walk(doc.body, false).trim();
    },

    _bindEpisodePage(s) {
        const page = document.querySelector('#content [data-ep-page]');
        if (!page) return;
        const { item, ep } = s;
        const touched = () => { s.touchedAt = Date.now(); };
        page.addEventListener('touchmove', touched, { passive: true });
        page.addEventListener('wheel', touched, { passive: true });
        page.querySelector('[data-ep-show]')?.addEventListener('click', () => this.showItem(item.id));
        page.querySelector('[data-ep-play]').addEventListener('click', () => {
            if (this._isLoadedEpisode(item.id, ep.id)) { Player.toggle(); return; }
            this.playEpisode(item.id, ep.id, ep, item, { queue: s.queue, startAt: s.played ? 0 : undefined });
        });
        page.querySelector('[data-ep-watch]')?.addEventListener('click', () => this._openWatch(s, 0));
        page.querySelectorAll('[data-ep-tab]').forEach(b => b.addEventListener('click', () => {
            s.tab = b.dataset.epTab;
            page.querySelectorAll('[data-ep-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
            page.querySelectorAll('[data-ep-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.epPanel !== s.tab));
            if (s.tab === 'transcript') this._loadEpisodeTranscript(s);
            s.chIdx = s.cueIdx = -2;   // repaint, and bring "now" into view
            this._paintEpisodePage(true);
        }));
        page.querySelector('[data-ep-now]')?.addEventListener('click', () => {
            s.touchedAt = 0;
            page.querySelector('.tr-cue.is-now')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
        page.querySelector('[data-ep-panel="notes"]').addEventListener('click', (e) => {
            const ts = e.target.closest('.ep-ts');
            if (ts) this._epSeek(s, Number(ts.dataset.t));
        });
        page.querySelector('[data-ep-panel="chapters"]')?.addEventListener('click', (e) => {
            const row = e.target.closest('[data-ch]');
            const ch = row && s.chapters[Number(row.dataset.ch)];
            if (ch) this._epSeek(s, ch.start || 0);
        });
        page.querySelector('[data-ep-panel="transcript"]')?.addEventListener('click', (e) => {
            const time = e.target.closest('.tr-time');
            if (time) { this._epSeek(s, Number(time.dataset.t)); return; }
            // Tapping the words themselves only moves an episode that's
            // already in the player; starting one takes the time button.
            const cue = e.target.closest('.tr-cue');
            if (cue && s.transcript?.cues && this._isLoadedEpisode(item.id, ep.id) && !window.getSelection?.()?.toString()) {
                this._epSeek(s, s.transcript.cues[Number(cue.dataset.cue)].start);
            }
        });

        // Actions.
        page.querySelector('[data-ep-played]').addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            const dur = ep.duration || ep.audioFile?.duration || 0;
            const body = s.played
                ? { isFinished: false, progress: 0, currentTime: 0 }
                : { isFinished: true, progress: 1, currentTime: dur, duration: dur };
            try {
                const p = await ABS.updateProgress(`${item.id}/${ep.id}`, body);
                s.progress.set(ep.id, p || { ...body, episodeId: ep.id });
                // The list's copy of this episode carries its progress too
                // (ABS_shim), and a redraw overlays it: it must say the same.
                ep.mediaProgress = s.progress.get(ep.id);
                this._epProgressLast?.set(ep.id, ep.mediaProgress);
                this._invalidateTabCache();
                this._rerenderEpisodePage(s);
            } catch (err) { alert('Failed: ' + err.message); this._rerenderEpisodePage(s); }
        });
        page.querySelector('[data-ep-dl]')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const label = btn.querySelector('span');
            btn.disabled = true; btn.classList.add('busy'); label.textContent = 'Downloading';
            try {
                await this.downloadEpisode(item, ep, (received, total) => {
                    if (total) label.textContent = Math.floor((received / total) * 100) + '%';
                });
            } catch (err) { alert('Download failed: ' + err.message); }
            this._rerenderEpisodePage(s);
        });
        page.querySelector('[data-ep-dl-remove]')?.addEventListener('click', async () => {
            if (!confirm('Remove the download from this phone?')) return;
            const stored = (await Offline.listDownloaded()).find(i => Offline.oid(i) === `${item.id}~${ep.id}`);
            if (stored) await Offline.deleteBook(stored);
            this._invalidateHomeCache();
            this._rerenderEpisodePage(s);
        });
        page.querySelector('[data-ep-archive]')?.addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            try {
                await this._archiveEpisode(item, ep, null, s.progress, {
                    alive: () => !!this._epPageFor(item.id, ep.id),
                    redraw: async () => { const cur = this._epPageFor(item.id, ep.id); if (cur) this._rerenderEpisodePage(cur); },
                });
            } catch (err) { alert('Archive failed: ' + err.message); this._rerenderEpisodePage(s); }
        });
        page.querySelector('[data-ep-playlist]').addEventListener('click', (e) => {
            e.currentTarget.disabled = true;
            this._addToPlaylistUi(page.querySelector('[data-ep-more]'), item.id, ep);
        });
        page.querySelector('[data-ep-add]')?.addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            try {
                await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/episodes/add`, {
                    method: 'POST', body: JSON.stringify({ episodeIds: [ep.id] }),
                });
                ep.inLibrary = true;
                ep.hidden = false;
                this._invalidateTabCache();
                this._rerenderEpisodePage(s);
            } catch (err) { e.currentTarget.disabled = false; alert('Add failed: ' + err.message); }
        });
        page.querySelector('[data-ep-unhide]')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
                await this._unhideEpisode(item, ep);
                this._rerenderEpisodePage(s);
            } catch (err) { btn.disabled = false; alert('Show again failed: ' + err.message); }
        });
        page.querySelector('[data-ep-analyse]')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
                const st = await this._shimCall(`/api/podcasts/${encodeURIComponent(item.id)}/episode/${encodeURIComponent(ep.id)}/analysis/run`, { method: 'POST', body: '{}' });
                this._paintAnalysisState(s, st);
                this._watchAnalysis(s);
            } catch (err) {
                const out = page.querySelector('[data-ep-analysis]');
                if (out) out.textContent = ' ' + err.message;
            } finally { btn.disabled = false; }
        });
        page.querySelector('[data-ep-unlist]')?.addEventListener('click', async () => {
            try {
                await ABS.request(`/api/playlists/${s.opts.playlistId}/item/${item.id}/${ep.id}`, { method: 'DELETE' });
                this._invalidateTabCache('playlists');
                this.goBack();
            } catch (err) { alert('Remove failed: ' + err.message); }
        });
    },

    // Go to `t` in the page's episode: a seek when it's the one in the
    // player, else play it from there (no intro skip: you asked for here).
    _epSeek(s, t) {
        if (!Number.isFinite(t)) return;
        if (this._isLoadedEpisode(s.itemId, s.episodeId)) { Player.loadTime(t, 'episode-page'); return; }
        this.playEpisode(s.itemId, s.episodeId, s.ep, s.item, { queue: s.queue, startAt: t, exact: true });
    },

    // Runs on every player tick while visible (paintPlayingEpisode), and
    // after the page is drawn. Cheap when nothing changed: each part only
    // touches the DOM when its value moved.
    _paintEpisodePage(force = false) {
        const s = this._epPage;
        if (!s) return;
        const page = document.querySelector('#content [data-ep-page]');
        if (!page) return;
        const loaded = this._isLoadedEpisode(s.itemId, s.episodeId);
        const playing = loaded && Player.isPlaying;
        const gt = loaded ? Player.getGlobalTime() : null;
        const dur = loaded ? Player.getTotalDuration() : 0;

        const label = !loaded ? s.idleLabel : playing ? 'Pause' : dur ? `Resume · ${formatTime(Math.max(0, dur - gt))} left` : 'Resume';
        if (label !== s.label || force) {
            s.label = label;
            const btn = page.querySelector('[data-ep-play]');
            btn.querySelector('[data-ep-play-label]').textContent = label;
            btn.classList.toggle('is-playing', playing);
        }
        const nowBtn = page.querySelector('[data-ep-now]');
        nowBtn?.classList.toggle('hidden', !(loaded && s.tab === 'transcript' && s.cueStarts));
        if (!loaded) return;

        const pct = dur > 0 ? Math.min(100, Math.max(0, (gt / dur) * 100)).toFixed(2) + '%' : '0%';
        if (pct !== s.barPct) { s.barPct = pct; page.querySelector('[data-ep-bar]').style.width = pct; }

        if (s.chapters.length > 1) {
            const i = s.chapters.findIndex(c => gt >= c.start && gt < c.end);
            const rows = page.querySelectorAll('[data-ch]');
            if (i !== s.chIdx) {
                s.chIdx = i;
                rows.forEach((r, j) => {
                    r.classList.toggle('is-active', j === i);
                    r.classList.toggle('is-done', gt >= (s.chapters[j].end || 0));
                    if (j !== i) r.querySelector('.tracklist-progress').style.width = '0%';
                });
            }
            const c = s.chapters[i];
            if (c && rows[i]) rows[i].querySelector('.tracklist-progress').style.width = Math.min(100, ((gt - c.start) / Math.max(1, c.end - c.start)) * 100) + '%';
        }

        if (s.cueStarts) {
            // The last paragraph starting at or before the playhead.
            let lo = 0, hi = s.cueStarts.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (s.cueStarts[mid] <= gt) lo = mid + 1; else hi = mid; }
            const i = lo - 1;
            if (i !== s.cueIdx) {
                s.cueIdx = i;
                page.querySelector('.tr-cue.is-now')?.classList.remove('is-now');
                const el = i >= 0 ? page.querySelector(`.tr-cue[data-cue="${i}"]`) : null;
                el?.classList.add('is-now');
                if (el && s.tab === 'transcript' && (playing || force) && Date.now() - s.touchedAt > 8000) {
                    el.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
                }
            }
        }
    },

    // Fetched once per page (and kept across its redraws); called again by
    // a second tap on the tab, which then finds it drawn.
    async _loadEpisodeTranscript(s) {
        const panel = () => this._epPageShowing(s) ? document.querySelector('#content [data-ep-panel="transcript"]') : null;
        s.transcriptP = s.transcriptP || this._fetchTranscript(s.itemId, s.episodeId);
        try {
            s.transcript = await s.transcriptP;
        } catch (e) {
            s.transcriptP = null;
            const p = panel();
            if (p) p.innerHTML = `<div class="text-muted">${esc(/transcript/i.test(e.message) ? e.message : "Couldn't load the transcript: " + e.message)}</div>`;
            return;
        }
        const p = panel();
        if (!p || p.dataset.loaded) return;
        p.dataset.loaded = '1';
        p.innerHTML = this._transcriptHtml(s.transcript, s.ep, s.analysis);
        s.cueStarts = s.transcript.format === 'cues' ? s.transcript.cues.map(c => c.start) : null;
        s.cueIdx = -2;
        this._paintEpisodePage(true);
    },

    _transcriptHtml(t, ep, analysis = ep?.analysis) {
        if (t.format !== 'cues') {
            return '<div class="text-muted tr-note">This transcript has no timings, so it can\'t follow the episode.</div>'
                + (t.paragraphs || []).map(p => `<p class="tr-para">${esc(p)}</p>`).join('');
        }
        // A speech-recognition transcript was made from the file itself:
        // its times are right whatever the host stitched in.
        const whisper = t.source === 'whisper';
        let h = whisper ? '' : this._dynamicAdsNote(ep, analysis, 'transcript'), lastSpeaker = null;
        t.cues.forEach((c, i) => {
            const speaker = c.speaker && c.speaker !== lastSpeaker ? c.speaker : '';
            if (c.speaker) lastSpeaker = c.speaker;
            h += `<div class="tr-cue" data-cue="${i}"><div class="tr-meta">`
                + (speaker ? `<span class="tr-speaker">${esc(speaker)}</span>` : '')
                + `<button class="tr-time" data-t="${c.start}">${formatTime(c.start)}</button></div>`
                + `<p>${esc(c.text)}</p></div>`;
        });
        return h + (whisper
            ? '<div class="text-muted tr-note">Transcript made by speech recognition.</div>'
            : '<div class="text-muted tr-note">Transcript from the publisher\'s feed.</div>');
    },

    // Transcripts come parsed from ABS_shim (GET …/episode/:id/transcript).
    // The last 40 opened are kept on the phone (their own cache, listed in
    // sw.js KEEP_CACHES), and a downloaded episode's is fetched with it, so
    // one played offline still has its words.
    TRANSCRIPT_CACHE: 'pholia-transcripts-v1',
    _transcriptKey(itemId, epId) {
        return `https://transcripts.pholia.invalid/${encodeURIComponent(ABS.serverUrl || '')}/${encodeURIComponent(itemId)}/${encodeURIComponent(epId)}`;
    },
    async _fetchTranscript(itemId, epId) {
        const key = this._transcriptKey(itemId, epId);
        try {
            const t = await this._shimCall(`/api/podcasts/${encodeURIComponent(itemId)}/episode/${encodeURIComponent(epId)}/transcript`);
            this._storeTranscript(key, t);
            return t;
        } catch (e) {
            try {
                const hit = await (await caches.open(this.TRANSCRIPT_CACHE)).match(key);
                if (hit) return await hit.json();
            } catch {}
            throw e;
        }
    },
    async _storeTranscript(key, t) {
        try {
            const c = await caches.open(this.TRANSCRIPT_CACHE);
            await c.delete(key);   // re-added at the end: keys() lists in insertion order
            await c.put(key, new Response(JSON.stringify(t), { headers: { 'Content-Type': 'application/json' } }));
            const keys = await c.keys();
            for (const k of keys.slice(0, Math.max(0, keys.length - 40))) await c.delete(k);
        } catch {}
    },

    // ── Personal podcast lists (ABS_shim, 2026-10-14) ──
    // A show is stored once per library and each member follows the ones
    // they want: their list, Latest, shelves and search are filtered by the
    // shim. Following an existing show costs no fetch, download or analysis.
    // A show nobody follows stays stored but idle (not polled).
    async _setFollow(itemId, follow) {
        const r = await this._shimCall(`/api/podcasts/${encodeURIComponent(itemId)}/follow`, {
            method: 'PUT', body: JSON.stringify({ follow }),
        });
        // The shim turns the bell off with an unfollow.
        if (!follow) this._setPushShows((this._pushStatusCache?.data?.shows || []).filter(id => id !== itemId));
        this._invalidateTabCache();
        this._podServerShows = null;
        if (follow) this._catchUpShow(itemId);
        return r;
    },
    // Following makes an idle show's feed due at once, and the shim's next
    // 2-minute tick catches it up. Whoever may check feeds gets it now, and
    // the show's page is redrawn if new episodes came.
    _catchUpShow(itemId) {
        if (!this.shimCanAdd) return;
        this._shimCall(`/api/podcasts/${encodeURIComponent(itemId)}/checknew`).then(r => {
            if (!(r?.episodes || []).length) return;
            this._invalidateTabCache();
            if (document.querySelector(`#content [data-pod-show="${CSS.escape(itemId)}"]`)) this._reloadPodcast(itemId);
        }, () => {});
    },
    _followSvg(on) {
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${on ? '<path d="M5 12.5l4.5 4.5L19 7.5"/>' : '<path d="M12 5v14M5 12h14"/>'}</svg>`;
    },

    // Unfollow (the show page's Following, or long-press on a show): it
    // leaves the caller's list and nobody else's; progress, archives and the
    // show itself stay on the server. `after` runs once it's done (the show
    // page goes back); by default the tab being shown is redrawn.
    confirmUnfollow(itemId, title, after) {
        const overlay = document.createElement('div');
        overlay.className = 'modal confirm-modal';
        overlay.innerHTML =
            '<div class="modal-content modal-narrow">' +
              '<div class="modal-header"><h3>Stop following?</h3></div>' +
              '<div class="modal-body"><p class="confirm-title"></p><p class="text-muted">It leaves your list; your progress is kept.</p></div>' +
              '<div class="modal-actions"><button class="text-btn" data-cancel>Cancel</button><button class="danger-btn" data-ok>Unfollow</button></div>' +
            '</div>';
        overlay.querySelector('.confirm-title').textContent = title;
        const close = () => overlay.remove();
        overlay.querySelector('[data-cancel]').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('[data-ok]').addEventListener('click', async () => {
            const ok = overlay.querySelector('[data-ok]');
            ok.disabled = true; ok.textContent = 'Unfollowing…';
            try {
                await this._setFollow(itemId, false);
                close();
                if (after) after(); else this.switchTab(this.currentTab);
            } catch (e) {
                ok.disabled = false; ok.textContent = 'Unfollow';
                alert('Unfollow failed: ' + e.message);
            }
        });
        document.body.appendChild(overlay);
    },

    // Long-press on a show (a shim without personal lists). Unsubscribing
    // keeps archived episodes on pCloud unless the box is ticked; the
    // publisher's copies are never touched.
    confirmUnsubscribe(itemId, title) {
        const overlay = document.createElement('div');
        overlay.className = 'modal confirm-modal';
        overlay.innerHTML =
            '<div class="modal-content modal-narrow">' +
              '<div class="modal-header"><h3>Unsubscribe?</h3></div>' +
              '<div class="modal-body"><p class="confirm-title"></p><p class="text-muted">Removes the podcast from the library. Listening progress for its episodes is lost.</p>' +
              '<label class="podcast-toggle hidden" data-files-row><input type="checkbox" data-files> Also delete its archived episodes from pCloud</label></div>' +
              '<div class="modal-actions"><button class="text-btn" data-cancel>Cancel</button><button class="danger-btn" data-ok>Unsubscribe</button></div>' +
            '</div>';
        overlay.querySelector('.confirm-title').textContent = title;
        ABS.getItem(itemId).then(it => {
            const n = (it?.media?.episodes || []).filter(e => e.archiveState === 'done').length;
            if (n) {
                const row = overlay.querySelector('[data-files-row]');
                row.lastChild.textContent = ` Also delete its ${n} archived episode${n === 1 ? '' : 's'} from pCloud`;
                row.classList.remove('hidden');
            }
        }).catch(() => {});
        const close = () => overlay.remove();
        overlay.querySelector('[data-cancel]').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('[data-ok]').addEventListener('click', async () => {
            const ok = overlay.querySelector('[data-ok]');
            ok.disabled = true; ok.textContent = 'Removing…';
            const files = overlay.querySelector('[data-files]').checked;
            try {
                const r = await this._shimCall(`/api/admin/items/${encodeURIComponent(itemId)}${files ? '?deleteFiles=1' : ''}`, { method: 'DELETE' });
                close();
                this._invalidateTabCache();
                this.switchTab(this.currentTab);
                if (r && r.reason) alert(r.reason);
            } catch (e) {
                ok.disabled = false; ok.textContent = 'Unsubscribe';
                alert('Unsubscribe failed: ' + e.message);
            }
        });
        document.body.appendChild(overlay);
    },

    // ── Finding podcasts (ABS_shim) ──
    // In a podcast library the ordinary search (the header's magnifier, and
    // the pull-down bar) also searches Apple's podcast directory, below your
    // own shows and episodes. A result opens as an ordinary show page: the
    // shim stores the show without following it (`POST /api/podcasts`
    // `follow: false`, its `canPreview`), so its episodes play, its notes and
    // chapters show, and Follow is on the page. With the search empty, the
    // overlay lists the shows stored here that you don't follow ("On this
    // server"). This replaced the podcast library's "+" Add screen
    // (2026-10-18, Joseph: "It should automatically search podcasts").
    _dirSearchOn() { return this.isShim && this.shimCanSubscribe && this.currentMediaType === 'podcast'; },

    // Apple rate-limits per IP (about 20 calls a minute), so a term's answer
    // is kept for ten minutes: going back to the search, or typing the same
    // word again, asks nobody.
    _dirMemo: new Map(),
    _dirCountry() { return (navigator.language || 'en-US').split('-')[1]?.toLowerCase() || 'us'; },
    _dirMemoGet(term) {
        const k = this._dirCountry() + '|' + term.toLowerCase();
        const m = this._dirMemo.get(k);
        return m && Date.now() - m.at < 600000 ? m.results : null;
    },
    // One question per term at a time: Enter right after typing starts a
    // search, and the typing's own (300 ms behind) would ask again.
    _dirInFlight: new Map(),
    _dirSearch(term) {
        const hit = this._dirMemoGet(term);
        if (hit) return Promise.resolve(hit);
        const k = this._dirCountry() + '|' + term.toLowerCase();
        if (this._dirInFlight.has(k)) return this._dirInFlight.get(k);
        const p = this._podDirectorySearch(term, this._dirCountry()).then(results => {
            this._dirMemo.delete(k);
            this._dirMemo.set(k, { at: Date.now(), results: Array.isArray(results) ? results : [] });
            while (this._dirMemo.size > 30) this._dirMemo.delete(this._dirMemo.keys().next().value);
            return this._dirMemo.get(k).results;
        }).finally(() => this._dirInFlight.delete(k));
        this._dirInFlight.set(k, p);
        return p;
    },

    // Apple's directory is searched from the phone: Apple rate-limits per IP
    // and refuses the shim's shared Cloudflare IPs, but sends CORS headers.
    // A pasted feed URL, or Apple failing, goes through the shim instead
    // (which retries Apple, then falls back to fyyd.de).
    async _podDirectorySearch(term, country) {
        if (!/^https?:\/\//i.test(term)) {
            try {
                const q = new URLSearchParams({ term, entity: 'podcast', media: 'podcast', country, limit: '25' });
                const r = await fetch('https://itunes.apple.com/search?' + q, { credentials: 'omit' });
                if (r.ok) {
                    const d = await r.json();
                    // One result per feed: Apple can list one feed under two
                    // ids (Linux Matters is 1682797246 and 976672924).
                    const seen = new Set();
                    return (d.results || []).filter(x => {
                        const k = this._feedKey(x.feedUrl);
                        if (!k || seen.has(k)) return false;
                        seen.add(k);
                        return true;
                    }).map(x => ({
                        id: x.collectionId, artistId: x.artistId || null, title: x.collectionName, artistName: x.artistName,
                        genres: x.genres || [], cover: x.artworkUrl600 || x.artworkUrl100 || '', trackCount: x.trackCount,
                        feedUrl: x.feedUrl, pageUrl: x.collectionViewUrl,
                    }));
                }
            } catch { /* fall through to the shim */ }
        }
        return this._shimCall(`/api/search/podcast?term=${encodeURIComponent(term)}&country=${country}`);
    },

    _feedKey(u) { return String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, ''); },

    // Every show stored in this library, followed or not (`GET
    // /api/podcasts/shows`; the shim leaves out shows someone only looked
    // at). Kept a minute, dropped by any follow. null: an older shim (404)
    // or no connection.
    _podServerShows: null, // { libraryId, at, shows }
    async _loadServerShows() {
        if (!this.isShim || !this.shimFollows) return null;
        const libId = this.currentLibraryId;
        const c = this._podServerShows;
        if (c && c.libraryId === libId && Date.now() - c.at < 60000) return c.shows;
        try {
            const r = await this._shimCall(`/api/podcasts/shows?libraryId=${encodeURIComponent(libId)}`);
            const shows = Array.isArray(r?.shows) ? r.shows : [];
            this._podServerShows = { libraryId: libId, at: Date.now(), shows };
            return shows;
        } catch { return null; }
    },

    // One row, for a directory result or a stored show: cover, title, line
    // under it, and Follow. The row opens the show; the button only follows.
    _podFindRowHtml(kind, i, { title, sub, cover, following }) {
        return `<li class="tracklist-item abb-item pod-find-row" data-find="${kind}" data-i="${i}"><div class="abb-main">`
            + (cover ? `<img class="abb-cover pod-server-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="abb-cover"></span>')
            + `<span class="tracklist-title"><strong>${esc(title || 'Untitled')}</strong><span class="text-muted">${esc(sub)}</span></span>`
            + `<button class="abb-grab${following ? ' abb-grab-again' : ''}" data-find-follow ${following ? 'disabled' : ''}>${following ? '✓ Following' : 'Follow'}</button>`
            + '</div></li>';
    },
    _serverShowRow(s, i) {
        const n = Number(s.numEpisodes) || 0;
        return this._podFindRowHtml('server', i, {
            title: s.title, sub: [s.author, n ? `${n} episode${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
            cover: ABS.coverUrl(s.id), following: !!s.following,
        });
    },
    _dirResultRow(r, i, following) {
        return this._podFindRowHtml('dir', i, {
            title: r.title, sub: [r.artistName, r.trackCount ? `${r.trackCount} episodes` : '', (r.genres || [])[0]].filter(Boolean).join(' · '),
            cover: r.cover, following,
        });
    },

    // The directory half of doSearch: after the library's own results are
    // drawn, wait for the typing to stop (doSearch is already 300 ms behind
    // the keys; Enter skips the wait), then ask Apple and the shim's stored
    // shows together and draw below. `token` is the results element's
    // search: a newer one makes this one draw nothing.
    async _podFindSection(term, el, token, libData, opts = {}) {
        const box = el.querySelector('[data-pod-dir]');
        if (!box || term.length < 3) { if (box && !box.previousElementSibling) box.innerHTML = '<div class="empty-state">No results</div>'; return; }
        const memo = this._dirMemoGet(term);
        if (!memo) {
            box.innerHTML = '<div class="pod-find-status text-muted">Searching the podcast directory…</div>';
            if (!opts.now) {
                await new Promise(r => setTimeout(r, 450));
                if (el._searchToken !== token) return;
            }
        }
        let results = [], error = null;
        const [dir, server] = await Promise.all([
            this._dirSearch(term).catch(e => { error = e; return []; }),
            this._loadServerShows(),
        ]);
        if (el._searchToken !== token) return;
        results = dir;
        // Your own shows are already above, as the library search found them.
        const mine = new Set((libData?.podcast || []).map(p => this._feedKey((p.libraryItem || p).media?.metadata?.feedUrl)).filter(Boolean));
        let followed = null;
        if (server) followed = new Set(server.filter(s => s.following).map(s => this._feedKey(s.feedUrl)));
        else {
            // An older shim without the stored-shows list: the caller's own
            // list says what they follow.
            try {
                const t = await ABS.request(`/api/libraries/${this.currentLibraryId}/podcast-titles`);
                followed = new Set((t?.podcasts || []).map(p => this._feedKey(p.feedUrl)).filter(Boolean));
            } catch { followed = new Set(); }
            if (el._searchToken !== token) return;
        }
        const dirRows = results.filter(r => !mine.has(this._feedKey(r.feedUrl)));
        const dirFeeds = new Set(results.map(r => this._feedKey(r.feedUrl)));
        // Stored here, not followed, matching every word, and not already a
        // directory row (that row opens the stored show anyway).
        const words = term.toLowerCase().split(/\s+/).filter(Boolean);
        const onServer = /^https?:\/\//i.test(term) ? [] : (server || []).filter(s => {
            if (s.following || dirFeeds.has(this._feedKey(s.feedUrl))) return false;
            const hay = `${s.title || ''} ${s.author || ''}`.toLowerCase();
            return words.every(w => hay.includes(w));
        });
        let html = '';
        if (onServer.length) html += '<div class="section-title">On this server</div><ul class="tracklist">' + onServer.map((s, i) => this._serverShowRow(s, i)).join('') + '</ul>';
        if (dirRows.length) html += '<div class="section-title">Podcast directory</div><ul class="tracklist">' + dirRows.map((r, i) => this._dirResultRow(r, i, followed.has(this._feedKey(r.feedUrl)))).join('') + '</ul>';
        if (!html) {
            const nothingAbove = !box.previousElementSibling;
            html = error ? `<div class="empty-state">Couldn't search the podcast directory: ${esc(error.message)}</div>`
                : nothingAbove ? '<div class="empty-state">No results</div>' : '';
        }
        box.innerHTML = html;
        this._bindFindRows(box, { dir: dirRows, server: onServer });
    },

    // The search overlay with nothing typed: what's stored here that you
    // don't follow, one tap to look, one to follow.
    async _renderServerBrowse(el) {
        const token = el._searchToken = (el._searchToken || 0) + 1;
        el.innerHTML = '<div class="pod-find-status text-muted">Search your podcasts and the podcast directory, or paste a feed URL.</div>';
        const server = await this._loadServerShows();
        if (el._searchToken !== token) return;
        const shows = (server || []).filter(s => !s.following);
        if (!shows.length) return;
        el.insertAdjacentHTML('beforeend', '<div class="section-title">On this server</div><ul class="tracklist">' + shows.map((s, i) => this._serverShowRow(s, i)).join('') + '</ul>');
        this._bindFindRows(el, { server: shows });
    },

    _bindFindRows(root, lists) {
        root.querySelectorAll('.pod-find-row').forEach(li => {
            const kind = li.dataset.find;
            const entry = (lists[kind] || [])[Number(li.dataset.i)];
            if (!entry) return;
            const btn = li.querySelector('[data-find-follow]');
            btn.addEventListener('click', (e) => { e.stopPropagation(); this._findFollow(kind, entry, btn); });
            if (kind === 'server') {
                li.addEventListener('click', () => this._openFromSearch(() => this.showItem(entry.id)));
            } else if (this.shimPreview) {
                li.addEventListener('click', () => this._openDirShow(entry, li));
            } else {
                // A shim from before canPreview can't store a show without
                // following it, so a directory row only follows.
                li.classList.add('no-open');
            }
        });
    },

    async _findFollow(kind, entry, btn) {
        btn.disabled = true; btn.innerHTML = '<span class="abb-spinner"></span>Following';
        try {
            if (kind === 'server') {
                await this._setFollow(entry.id, true);
                entry.following = true;
                btn.textContent = '✓ Following';
            } else {
                // Subscribing to a feed the server already stores just follows
                // that show (the shim answers the stored item); a new feed is
                // fetched and stored.
                const item = await this._shimCall('/api/podcasts', {
                    method: 'POST', body: JSON.stringify(this._podCreateBody(entry, true)),
                });
                const n = item?.media?.numEpisodes || 0;
                btn.textContent = item?.followedExisting || Number(item?.followers) > 1 || !n ? '✓ Following' : `✓ ${n} episode${n === 1 ? '' : 's'}`;
                this._invalidateTabCache();
            }
            btn.classList.add('abb-grab-again');
            this._podServerShows = null;
        } catch (e) {
            // A shim from before personal lists answers 409 for a feed it has.
            if (/already exists/i.test(e.message)) { btn.textContent = '✓ Following'; btn.classList.add('abb-grab-again'); return; }
            btn.disabled = false; btn.textContent = 'Follow';
            alert('Follow failed: ' + e.message);
        }
    },

    _podCreateBody(r, follow) {
        return {
            libraryId: this.currentLibraryId,
            ...(follow ? {} : { follow: false }),
            media: {
                metadata: {
                    feedUrl: r.feedUrl, title: r.title, author: r.artistName, imageUrl: r.cover || null, genres: r.genres || [],
                    itunesId: r.id ? String(r.id) : null, itunesArtistId: r.artistId ? String(r.artistId) : null, itunesPageUrl: r.pageUrl || null,
                },
                autoDownloadEpisodes: true,
            },
        };
    },

    // A directory result opens as its show page. A feed the server doesn't
    // have is fetched and stored first, unfollowed (a few seconds for a big
    // feed), so the row says so while it waits.
    async _openDirShow(r, li) {
        if (li.classList.contains('is-opening')) return;
        li.classList.add('is-opening');
        const sub = li.querySelector('.text-muted');
        const was = sub?.textContent;
        if (sub) sub.innerHTML = '<span class="abb-spinner"></span>Opening…';
        try {
            const item = await this._shimCall('/api/podcasts', { method: 'POST', body: JSON.stringify(this._podCreateBody(r, false)) });
            if (!item?.id) throw new Error('the server sent no show back');
            // Typed something else meanwhile, or closed the search: stay.
            if (!li.isConnected) return;
            this._openFromSearch(() => this.showItem(item.id));
        } catch (e) {
            if (li.isConnected) alert(`Couldn't open ${r.title || 'the show'}: ${e.message}`);
        } finally {
            li.classList.remove('is-opening');
            if (sub && sub.isConnected) sub.textContent = was;
        }
    },

    // Opening something found by a search: Back from it returns to the
    // search, with the same words (goBack reopens the overlay once the
    // stack is back to where it was; the directory's answer is memoised, so
    // that asks Apple nothing). Any tab switch forgets it.
    _searchReopen: null, // { query, depth }
    _openFromSearch(open) {
        const overlay = !document.getElementById('search-overlay').classList.contains('hidden');
        const q = (overlay ? document.getElementById('search-input') : document.getElementById('inline-search-input'))?.value.trim() || '';
        // The depth before the page opens: not every page pushes its level
        // before its first await. Set after open(), which may switch tabs
        // (an episode of another library), and a switch would clear it.
        const depth = this.navStack.length;
        this.hideSearch();
        open();
        this._searchReopen = q ? { query: q, depth } : null;
    },

    // ── New-episode notifications (ABS_shim) ──
    // The shim is the sender: it polls the feeds, so it knows when an
    // episode lands, and it holds the VAPID keys, the subscriptions and each
    // user's per-show choice (`/api/push/*`, see its CLAUDE.md). Pholia is
    // the receiver: sw.js shows the notification and routes a tap; this part
    // subscribes, keeps the shim's copy of the subscription current, and
    // draws the show page's bell and Settings → Notifications. None of it
    // shows on stock ABS, or on a shim whose status says configured: false.
    _pushStatusCache: null, // { key, at, data }: the last /api/push/status
    _pushStartedFor: null,
    _pushSubP: null,
    _pushTitles: new Map(), // show id → title, for Settings' list of shows

    setupPush() {
        window.addEventListener('pholia-open-episode', () => this._maybeOpenPendingEpisode());
        if (!('serviceWorker' in navigator)) return;
        // iOS has been seen to drop a subscription when a new worker takes
        // over (TinnyGo: pushes silently stopped after deploys), so look
        // again once the new one has settled. A page that had a worker
        // reloads on controllerchange anyway (setupSwUpdate), and the launch
        // check covers it; this is for the first install and a failed reload.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            setTimeout(() => this.ensurePushSubscription(), 2000);
        });
    },

    _pushKey(kind) { return `pholia_push_${kind}:${ABS.serverUrl}|${localStorage.getItem('pholia_username') || ''}`; },
    _pushSupported() {
        return 'serviceWorker' in navigator && typeof window.PushManager !== 'undefined' && typeof window.Notification !== 'undefined';
    },
    _isIOS() {
        return /iP(hone|ad|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    },
    // iOS offers push only to an app added to the Home Screen and opened
    // from there; a Safari tab has no PushManager at all.
    _pushUnsupportedText() {
        if (!this._isIOS()) return 'This browser can\'t receive notifications.';
        const standalone = navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)')?.matches;
        return standalone ? 'Notifications need iOS 16.4 or later.'
            : 'Add Pholia to your Home Screen, then open it from there, to get notifications.';
    },
    // A denied permission can't be asked for again from a page, so say where
    // it's changed instead of offering a button that can't work.
    _pushDeniedText() {
        return this._isIOS()
            ? 'Notifications are turned off for Pholia. To allow them: Settings → Notifications → Pholia → Allow Notifications.'
            : 'Notifications are blocked for this site. Allow them in the browser\'s settings for this site.';
    },

    // The shim's push status, cached five minutes per server and user (the
    // show page asks on every visit). null when it couldn't be asked
    // (offline, or a shim from before push, which 404s); callers treat that
    // as "no notifications here".
    async _loadPushStatus(fresh = false) {
        if (!this.isShim || !ABS.token) return null;
        const key = this._pushKey('status');
        const c = this._pushStatusCache;
        if (!fresh && c && c.key === key && Date.now() - c.at < 5 * 60e3) return c.data;
        let r;
        try { r = await this._shimCall('/api/push/status'); } catch { return null; }
        const data = {
            configured: !!(r && r.configured && r.publicKey),
            publicKey: (r && r.publicKey) || null,
            shows: Array.isArray(r?.shows) ? r.shows.map(String) : [],
            subscriptions: Array.isArray(r?.subscriptions) ? r.subscriptions : [],
        };
        this._pushStatusCache = { key, at: Date.now(), data };
        return data;
    },
    _setPushShows(shows) {
        const d = this._pushStatusCache?.data;
        if (d && Array.isArray(shows)) d.shows = shows.map(String);
    },

    // Once per page load per server and user (from checkAbbSupport, which
    // runs whenever a shim is found): subscriptions go stale unseen (a row
    // the shim deleted after a 410, a new endpoint, a worker update) and
    // re-sending is what repairs them.
    async _pushStart() {
        const key = this._pushKey('start');
        if (this._pushStartedFor === key) return;
        this._pushStartedFor = key;
        const st = await this._loadPushStatus(true);
        // Couldn't ask: the next library switch or sign-in tries again.
        if (!st) { if (this._pushStartedFor === key) this._pushStartedFor = null; return; }
        if (st.configured) this.ensurePushSubscription(st);
    },

    // Only where notifications are already allowed: asking needs a tap,
    // and that's the bell's job. Never throws.
    async ensurePushSubscription(status) {
        try {
            if (!this.isShim || !ABS.token || !this._pushSupported() || Notification.permission !== 'granted') return null;
            const st = status || await this._loadPushStatus();
            if (!st?.configured) return null;
            return await this._pushSubscribe(st.publicKey);
        } catch (e) {
            this._pushLog('page', { ev: 'push-ensure-failed', err: String(e?.message || e) });
            return null;
        }
    },

    // One at a time: the launch check and a bell tap can meet.
    _pushSubscribe(publicKey) {
        if (this._pushSubP) return this._pushSubP;
        const p = this._pushSubscribeNow(publicKey);
        this._pushSubP = p;
        const clear = () => { if (this._pushSubP === p) this._pushSubP = null; };
        p.then(clear, clear);
        return p;
    },
    async _pushSubscribeNow(publicKey) {
        const key = this._b64urlBytes(publicKey);
        const reg = await this._swReady();
        let sub = await reg.pushManager.getSubscription();
        // A subscription is bound to the key it was made with, and a push
        // signed with another is refused (Apple answers 403, which a sender
        // keeps as a passing failure), so a phone subscribed under an old or
        // another shim's key would stay deaf for good; TinnyGo never fixed
        // that. Start again under this shim's key and drop its row for the
        // dead endpoint. A browser that doesn't expose the key is left
        // alone, rather than re-subscribed on every launch.
        const had = sub?.options?.applicationServerKey;
        if (sub && had && !this._sameBytes(new Uint8Array(had), key)) {
            const old = sub.endpoint;
            try { await sub.unsubscribe(); } catch {}
            try { await this._shimCall('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: old }) }); } catch {}
            sub = null;
        }
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength),
            });
        }
        // ALWAYS sent, changed or not: the shim deletes a row its push
        // service answered 404/410 for, and this is what puts it back. It
        // also moves the phone to whoever is signed in now.
        const j = typeof sub.toJSON === 'function' ? sub.toJSON() : {};
        const r = await this._shimCall('/api/push/subscriptions', {
            method: 'POST',
            body: JSON.stringify({ endpoint: j.endpoint || sub.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } }),
        });
        // Remembered so Settings can say which device in the list is this one.
        if (r?.id != null) { try { localStorage.setItem(this._pushKey('sub'), String(r.id)); } catch {} }
        this._pushLog('page', { ev: 'push-subscribed', created: !!r?.created });
        return sub;
    },
    // ready never settles without a registered worker; don't hang a tap on it.
    _swReady() {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('the service worker isn\'t running')), 10000);
            navigator.serviceWorker.ready.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
        });
    },
    _b64urlBytes(s) {
        let b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        const bin = atob(b);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    },
    _sameBytes(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    },

    _bellSvg(on) {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
    },
    _paintBell(btn, on) {
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.innerHTML = this._bellSvg(on) + `<span>${on ? 'Notifications on' : 'Notify me of new episodes'}</span>`;
    },

    // The show page's bell. On: the shim notifies this user of the show's
    // new episodes on every device they've subscribed. Off leaves the
    // subscription alone, so other shows carry on.
    async _mountPushBell(content, item) {
        const box = content.querySelector('[data-pod-bell-box]');
        if (!box) return;
        const st = await this._loadPushStatus();
        if (!box.isConnected || !st?.configured) return;
        const title = item.media?.metadata?.title;
        if (title) this._pushTitles.set(item.id, title);
        const on = st.shows.includes(item.id);
        const blocked = this._pushSupported() && Notification.permission === 'denied';
        // Blocked and off: nothing a tap could do, so only the way to fix it.
        // Blocked and on: the bell stays, to turn the show off.
        box.innerHTML = (blocked && !on ? '' : '<button type="button" class="pod-bell" data-pod-bell></button>')
            + '<div class="pod-bell-note" data-pod-bell-note hidden></div>';
        const note = box.querySelector('[data-pod-bell-note]');
        const say = (t) => { note.textContent = t || ''; note.hidden = !t; };
        if (blocked) say(this._pushDeniedText());
        const btn = box.querySelector('[data-pod-bell]');
        if (!btn) return;
        this._paintBell(btn, on);
        btn.addEventListener('click', () => this._toggleShowPush(item, st, btn, say));
    },

    async _toggleShowPush(item, st, btn, say) {
        const url = `/api/push/shows/${encodeURIComponent(item.id)}`;
        if (btn.getAttribute('aria-pressed') === 'true') {
            btn.disabled = true;
            try {
                const r = await this._shimCall(url, { method: 'PUT', body: JSON.stringify({ notify: false }) });
                this._setPushShows(r?.shows || st.shows.filter(id => id !== item.id));
                this._paintBell(btn, false);
                say('');
            } catch (e) { say('Couldn\'t turn notifications off: ' + e.message); }
            finally { btn.disabled = false; }
            return;
        }
        if (!this._pushSupported()) { say(this._pushUnsupportedText()); return; }
        if (Notification.permission === 'denied') { say(this._pushDeniedText()); return; }
        btn.disabled = true;
        try {
            // Asked first, before anything else is awaited: iOS shows the
            // prompt only in answer to a tap.
            const perm = await this._askNotificationPermission();
            if (perm !== 'granted') {
                say(perm === 'denied' ? this._pushDeniedText() : 'Notifications weren\'t allowed, so nothing changed.');
                return;
            }
            say('Turning on…');
            await this._pushSubscribe(st.publicKey);
            const r = await this._shimCall(url, { method: 'PUT', body: JSON.stringify({ notify: true }) });
            this._setPushShows(r?.shows || [...st.shows, item.id]);
            this._paintBell(btn, true);
            say('');
        } catch (e) {
            say('Couldn\'t turn notifications on: ' + e.message);
        } finally { btn.disabled = false; }
    },
    _askNotificationPermission() {
        return new Promise((resolve) => {
            let p;
            // Old Safari answers through a callback, everything since with a promise.
            try { p = Notification.requestPermission((v) => resolve(v)); }
            catch { resolve(Notification.permission); return; }
            if (p && typeof p.then === 'function') p.then(resolve, () => resolve(Notification.permission));
        });
    },

    // A tapped notification (the inline script in index.html holds it):
    // open that episode's page once signed in, as a level on the nav stack,
    // so Back returns to wherever the app was.
    _maybeOpenPendingEpisode() {
        const t = window.__pholiaOpenEpisode;
        if (!t || !ABS.token || !this.libraries?.length) return;
        if (!document.getElementById('main-screen')?.classList.contains('active')) return;
        window.__pholiaOpenEpisode = null;
        this._openPushedEpisode(t);
    },
    async _openPushedEpisode(t) {
        const token = ABS.token;
        let show = null, ep = null, failed = null;
        try {
            show = await ABS.getItem(t.libraryItemId);
            ep = t.episodeId ? show?.media?.episodes?.find(e => e.id === t.episodeId) || null : null;
        } catch (e) { failed = e; }
        if (failed && (failed.status === 401 || failed.status === 403 || failed.isNetwork)) {
            // Offline, a copy on the phone will do. Otherwise (offline, or the
            // token was refused and the login screen is coming) keep the
            // target for the next sign-in's showMain; if a new token arrived
            // while this was in flight, that sign-in has already looked.
            const local = failed.isNetwork && t.episodeId ? await this._episodeFromPhone(t.libraryItemId, t.episodeId) : null;
            if (!local) {
                if (!window.__pholiaOpenEpisode) window.__pholiaOpenEpisode = t;
                if (ABS.token && ABS.token !== token) this._maybeOpenPendingEpisode();
                return;
            }
            ({ show, ep } = local);
        }
        this.hideSettings();
        if (!document.getElementById('fs-player')?.classList.contains('hidden')) this.closeFullscreen();
        // Shows live in a podcast library. A tap while an audiobook library
        // is showing switches to the show's, so Back lands on its Home and
        // not on a shelf of books.
        const lib = show?.libraryId && (this.libraries || []).find(l => l.id === show.libraryId);
        if (lib && lib.mediaType === 'podcast' && this.currentMediaType !== 'podcast') {
            this.currentLibraryId = lib.id;
            try { localStorage.setItem('pholia_library', lib.id); } catch {}
            const sel = document.getElementById('library-select');
            if (sel) sel.value = lib.id;
            this.updateMediaType();
            this.switchTab('home');
        }
        // No episode: "Archive all" is done, and the show is what to see.
        if (!t.episodeId) this.showItem(t.libraryItemId);
        else if (show && ep) this.showEpisode(show, ep);
        else this.openEpisodeById(t.libraryItemId, t.episodeId);
    },

    // Settings → Notifications (shim, configured): whether this device may
    // show them, a test that reports what the push services really said,
    // the devices the shim pushes to, and the shows that are on.
    async _renderPushSettings({ fresh = false, clearNote = false, titlesTried = false } = {}) {
        const sec = document.getElementById('push-section');
        const body = document.getElementById('push-body');
        if (!sec || !body) return;
        if (clearNote) this._pushNote('');
        const st = this.isShim ? await this._loadPushStatus(fresh) : null;
        if (!st?.configured) { sec.classList.add('hidden'); return; }
        sec.classList.remove('hidden');
        if (!this._pushSettingsWired) {
            this._pushSettingsWired = true;
            document.getElementById('push-test').addEventListener('click', () => this._sendTestPush());
            body.addEventListener('click', (e) => this._onPushSettingsClick(e));
        }
        const perm = this._pushSupported() ? Notification.permission : 'unsupported';
        const permText = {
            granted: 'Allowed on this device.',
            default: 'Not turned on for this device yet: tap the bell on a show\'s page.',
            denied: this._pushDeniedText(),
            unsupported: this._pushUnsupportedText(),
        }[perm] || String(perm);
        const mine = (() => { try { return localStorage.getItem(this._pushKey('sub')); } catch { return null; } })();
        let h = `<div class="push-perm">${esc(permText)}</div>`;
        h += '<div class="push-subhead">Devices</div>';
        if (!st.subscriptions.length) h += '<div class="downloads-empty">No devices yet.</div>';
        else {
            h += '<div class="downloads-list push-list">';
            for (const s of st.subscriptions) {
                const here = mine != null && String(s.id) === mine;
                const bits = [
                    s.createdAt ? 'Added ' + this._pushWhen(s.createdAt) : '',
                    s.lastSuccessAt ? 'Last accepted: ' + this._pushWhen(s.lastSuccessAt) : 'Never pushed to',
                ];
                if (s.lastFailureAt && (!s.lastSuccessAt || s.lastFailureAt > s.lastSuccessAt)) {
                    bits.push('Last refused: ' + this._pushWhen(s.lastFailureAt) + (s.lastFailureStatus ? ` (HTTP ${s.lastFailureStatus})` : ''));
                }
                h += '<div class="downloads-row"><div class="downloads-info">'
                    + `<div class="downloads-title">${esc(String(s.service || 'Unknown'))}${here ? ' <span class="push-here">· this device</span>' : ''}</div>`
                    + `<div class="downloads-sub push-sub">${esc(bits.filter(Boolean).join(' · '))}</div></div>`
                    // This device would put itself back at the next launch
                    // (the always-re-send above), so it gets no Remove.
                    + (here ? '' : `<button class="text-btn downloads-remove" data-push-remove="${esc(String(s.id))}">Remove</button>`)
                    + '</div>';
            }
            h += '</div>';
        }
        h += '<div class="push-subhead">Shows</div>';
        if (!st.shows.length) h += '<div class="downloads-empty">None yet: tap the bell on a show\'s page.</div>';
        else {
            h += '<div class="downloads-list push-list">';
            for (const id of st.shows) {
                const title = this._pushTitles.get(id) || (titlesTried ? 'A show no longer in your libraries' : '…');
                h += `<div class="downloads-row"><button class="push-show" data-push-open="${esc(id)}">${esc(title)}</button>`
                    + `<button class="text-btn downloads-remove" data-push-off="${esc(id)}">Turn off</button></div>`;
            }
            h += '</div>';
        }
        body.innerHTML = h;
        if (!titlesTried && st.shows.some(id => !this._pushTitles.has(id))) {
            await this._loadPushTitles();
            if (!document.getElementById('settings-modal')?.classList.contains('hidden')) this._renderPushSettings({ titlesTried: true });
        }
    },
    async _loadPushTitles() {
        const libs = (this.libraries || []).filter(l => l.mediaType === 'podcast');
        await Promise.all(libs.map(async (l) => {
            try {
                const r = await ABS.getLibraryItems(l.id, 0, 500);
                for (const it of r?.results || []) {
                    const t = it?.media?.metadata?.title;
                    if (it?.id && t) this._pushTitles.set(it.id, t);
                }
            } catch {}
        }));
    },
    _pushNote(text) {
        const el = document.getElementById('push-test-result');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('hidden', !text);
    },
    async _onPushSettingsClick(e) {
        const rm = e.target.closest('[data-push-remove]');
        const off = e.target.closest('[data-push-off]');
        const open = e.target.closest('[data-push-open]');
        if (open) { this.hideSettings(); this.showItem(open.dataset.pushOpen); return; }
        const btn = rm || off;
        if (!btn) return;
        btn.disabled = true;
        try {
            if (rm) {
                await this._shimCall('/api/push/subscriptions/' + encodeURIComponent(rm.dataset.pushRemove), { method: 'DELETE' });
            } else {
                const r = await this._shimCall('/api/push/shows/' + encodeURIComponent(off.dataset.pushOff), { method: 'PUT', body: JSON.stringify({ notify: false }) });
                this._setPushShows(r?.shows);
            }
            this._pushNote('');
        } catch (err) {
            this._pushNote((rm ? 'Couldn\'t remove the device: ' : 'Couldn\'t turn it off: ') + err.message);
        }
        this._renderPushSettings({ fresh: true, titlesTried: true });
    },
    // The real outcome, device by device: "sent" only where a push service
    // took it (TinnyGo's test said success whatever happened, which made it
    // useless for "I didn't get a notification").
    async _sendTestPush() {
        const btn = document.getElementById('push-test');
        btn.disabled = true;
        this._pushNote('Sending…');
        try {
            const r = await this._shimCall('/api/push/test', { method: 'POST' });
            this._pushNote(this._pushTestText(r));
            // Last accepted moved, and expired devices are gone.
            await this._renderPushSettings({ fresh: true, titlesTried: true });
        } catch (e) {
            this._pushNote('Test failed: ' + e.message);
        } finally { btn.disabled = false; }
    },
    _pushTestText(r) {
        const n = Number(r?.devices) || 0;
        if (!n) return 'No devices to send to. Tap the bell on a show\'s page on this device first.';
        const parts = [`Sent to ${Number(r.sent) || 0} of ${n} device${n === 1 ? '' : 's'}`];
        if (r.failed) parts.push(`${r.failed} failed`);
        if (r.expired) parts.push(`${r.expired} expired and removed`);
        const lines = [parts.join(', ') + '.'];
        for (const x of Array.isArray(r.results) ? r.results : []) {
            lines.push(`${x?.service || 'Device'}: ${x?.status || '?'}${x?.httpStatus ? ` (HTTP ${x.httpStatus})` : ''}`);
        }
        return lines.join('\n');
    },
    _pushWhen(ms) {
        const d = new Date(Number(ms));
        if (isNaN(d.getTime())) return '?';
        const now = new Date();
        const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const ago = Math.round((day(now) - day(d)) / 86400e3);
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        if (ago === 0) return 'today ' + time;
        if (ago === 1) return 'yesterday ' + time;
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
    },

    // ── Episode analysis: the per-show switch and the run records (ABS_shim) ──
    // Each finished analysis (done or failed) is a row in the shim's
    // append-only log, `GET /api/analysis/runs` (canAdd; totals, months,
    // shows, what's queued or running, and the runs newest first, paged by
    // `before`). The show page shows its own count and cost under the
    // Analysis select; Settings shows the lot. A shim without the route
    // 404s, and then neither says anything.
    _AN_PAGE: 20,
    _anSeq: 0,
    _anState: null, // { runs, nextBefore, open }: Settings' run list

    // The select's value for media.analyse: '' is Auto (null on the server).
    _analyseValue(v) { return v === 'on' || v === 'off' ? v : ''; },
    _analyseHelp(v) {
        if (v === 'on') return 'On: every new episode, and any you play. Shows that insert ads wait until the episode is archived.';
        if (v === 'off') return 'Off: only when you tap Analyse now on an episode.';
        return 'Auto: episodes from hosts that insert ads (once archived), and any without chapters or a transcript.';
    },
    _anRunsUrl(extra) {
        return `/api/analysis/runs?${extra}&${ABS._tzQuery()}`;
    },

    // Under the show page's Analysis select: "N episodes analysed · $X.XX".
    // Nothing at all when there are no runs, the call fails, or the shim
    // predates the log.
    async _paintShowAnalysisRuns(content, item) {
        const el = content.querySelector('[data-pod-analyse-runs]');
        if (!el) return;
        let r;
        try { r = await this._shimCall(this._anRunsUrl(`showId=${encodeURIComponent(item.id)}&limit=1`)); } catch { return; }
        const t = r?.totals;
        if (!el.isConnected || !t || !(Number(t.runs) > 0)) return;
        el.textContent = this._anShowLine(t);
        el.hidden = false;
    },
    _anShowLine(t) {
        const done = Number(t.done) || 0, failed = Number(t.failed) || 0;
        const bits = [`${done} episode${done === 1 ? '' : 's'} analysed`];
        if (failed) bits.push(`${failed} failed`);
        bits.push(this._anCost(t));
        return bits.join(' · ');
    },

    // Money is what OpenRouter charged, in US dollars: two places, three
    // under 10 cents (a run is about seven). Whisper costs nothing extra.
    _usd(v) {
        const n = Number(v);
        if (v == null || !isFinite(n)) return null;
        if (n <= 0) return '$0.00';
        if (n < 0.001) return 'under $0.001';
        return '$' + n.toFixed(n < 0.1 ? 3 : 2);
    },
    // A total's cost, saying so when some runs (from before the log kept
    // costs) aren't in it.
    _anCost(t) {
        const runs = Number(t.runs) || 0, unknown = Number(t.costUnknownRuns) || 0;
        if (runs && unknown >= runs) return 'cost not recorded';
        const s = this._usd(Number(t.costUsd) || 0);
        return unknown ? `${s} (${unknown} not recorded)` : s;
    },
    _anHours(sec) {
        const s = Math.max(0, Number(sec) || 0);
        if (s < 3600) return `${Math.round(s / 60)} min`;
        const h = s / 3600;
        return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
    },
    _anDur(sec) {
        const s = Math.round(Number(sec) || 0);
        if (s < 60) return `${s} s`;
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
        if (h) return m ? `${h} h ${m} min` : `${h} h`;
        return r ? `${m} min ${r} s` : `${m} min`;
    },
    _anIsland(id) { return id ? ({ mac: 'Mac' }[id] || String(id)) : ''; },
    _anOn(id) { return id === 'mac' ? 'on the Mac' : id ? 'on ' + id : ''; },
    _anReason(r) { return { asked: 'asked', played: 'after you played it', new: 'new episode' }[r] || ''; },
    // "anthropic/claude-sonnet-5.5" → "Claude Sonnet 5.5".
    _anModel(m) {
        if (!m) return '';
        const name = String(m).split('/').pop().replace(/:.*$/, '');
        return name.split('-').map(w => /^gpt$/i.test(w) ? 'GPT' : /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
    },
    // What the model part of a run came to.
    _anLlmText(run) {
        const llm = String(run.llm || '').split(':')[0];
        const model = this._anModel(run.llmModel);
        if (llm === 'skipped' || (!llm && !run.llmModel)) return 'no model call';
        const cost = run.costUsd == null ? 'cost not recorded' : this._usd(run.costUsd);
        if (llm === 'error') return `${model || 'model'} call failed` + (run.costUsd != null ? ' · ' + cost : '');
        return [model, cost].filter(Boolean).join(' · ');
    },
    // A queued row's reason for waiting, as the shim records it.
    _anWaitWhy(err) {
        const code = String(err || '').split(':')[0].trim();
        return {
            island_unreachable: 'the computer that does it isn\'t answering',
            node_busy: 'that computer is busy',
            project_not_routed: 'no computer is set up for it yet',
        }[code] || String(err);
    },

    _anRunHtml(run) {
        const open = run.episodeId && run.libraryItemId
            ? ` data-an-ep="${esc(String(run.episodeId))}" data-an-item="${esc(String(run.libraryItemId))}"` : ' disabled';
        const head = [run.showTitle, run.at ? this._pushWhen(run.at) : '', this._anIsland(run.island), this._anReason(run.reason)].filter(Boolean).join(' · ');
        const audio = Number(run.audioSeconds) > 0
            ? `${this._anDur(run.audioSeconds)} of audio` + (Number(run.whisperSeconds) > 0 ? `, transcribed in ${this._anDur(run.whisperSeconds)}` : '')
            : (Number(run.whisperSeconds) > 0 ? `Transcribed in ${this._anDur(run.whisperSeconds)}` : '');
        let did, err = false;
        if (run.outcome === 'error') {
            did = 'Failed: ' + (run.error || 'no reason given');
            err = true;
        } else {
            const n = Number(run.adsCount) || 0;
            const bits = [];
            if (run.aligned) bits.push('times aligned');
            if (run.transcriptSource === 'whisper') bits.push('transcript made');
            if (run.chaptersGenerated) bits.push('chapters written');
            bits.push(n ? `${n} ad${n === 1 ? '' : 's'}` : 'no ads');
            did = bits.join(', ');
            did = did[0].toUpperCase() + did.slice(1);
        }
        const llm = this._anLlmText(run);
        return `<button type="button" class="an-run"${open}>`
            + `<span class="an-title">${esc(run.episodeTitle || 'An episode no longer listed')}</span>`
            + (head ? `<span class="an-line">${esc(head)}</span>` : '')
            + (audio ? `<span class="an-line">${esc(audio)}</span>` : '')
            + `<span class="an-line${err ? ' an-err' : ''}">${esc(did)}</span>`
            + (err && llm === 'no model call' ? '' : `<span class="an-line">${esc(llm)}</span>`)
            + '</button>';
    },
    _anActiveHtml(a) {
        let state;
        if (a.state === 'running') state = 'Running' + (a.island ? ' ' + this._anOn(a.island) : '');
        else if (a.waitingFor === 'archive') state = 'Waiting for its pCloud copy';
        else state = 'Waiting' + (a.error ? ': ' + this._anWaitWhy(a.error) : '');
        const sub = [a.showTitle, this._anReason(a.reason), a.since ? 'since ' + this._pushWhen(a.since).replace(/^today /, '') : ''].filter(Boolean).join(' · ');
        const open = a.episodeId && a.libraryItemId
            ? ` data-an-ep="${esc(String(a.episodeId))}" data-an-item="${esc(String(a.libraryItemId))}"` : ' disabled';
        return `<button type="button" class="an-run"${open}>`
            + `<span class="an-title">${esc(a.episodeTitle || 'Episode')}</span>`
            + `<span class="an-line an-state">${esc(state)}</span>`
            + (sub ? `<span class="an-line">${esc(sub)}</span>` : '')
            + '</button>';
    },

    // Settings → Episode analysis (shim, canAdd, a podcast library):
    // totals, what's waiting or running, each show's switch and cost, and
    // the runs themselves behind "Show runs".
    async _renderAnalysisSettings() {
        const sec = document.getElementById('analysis-section');
        const body = document.getElementById('analysis-body');
        if (!sec || !body) return;
        const seq = ++this._anSeq;
        const podcasts = (this.libraries || []).some(l => l.mediaType === 'podcast');
        if (!this.isShim || !this.shimCanAdd || !podcasts) { sec.classList.add('hidden'); return; }
        if (!this._anWired) {
            this._anWired = true;
            body.addEventListener('click', (e) => this._onAnalysisSettingsClick(e));
        }
        let r;
        try { r = await this._shimCall(this._anRunsUrl(`limit=${this._AN_PAGE}`)); }
        catch (e) {
            if (seq !== this._anSeq) return;
            // No log on this shim (or not allowed): nothing to say.
            if (e.status === 404 || e.status === 403) { sec.classList.add('hidden'); return; }
            sec.classList.remove('hidden');
            body.innerHTML = `<div class="downloads-empty">Couldn't load the records: ${esc(e.message)}</div>`;
            return;
        }
        if (seq !== this._anSeq) return;
        if (!r || !r.totals) { sec.classList.add('hidden'); return; }
        sec.classList.remove('hidden');
        const runs = Array.isArray(r.runs) ? r.runs : [];
        this._anState = { runs, nextBefore: r.nextBefore ?? null, open: false };
        const t = r.totals;
        const now = new Date();
        const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const m = (Array.isArray(r.months) ? r.months : []).find(x => x?.month === thisMonth) || { runs: 0, costUsd: 0, audioSeconds: 0 };
        let h = '';
        if (!(Number(t.runs) > 0)) {
            h += '<div class="downloads-empty">Nothing analysed yet.</div>';
        } else {
            const row = (k, a, b) => `<span class="an-k">${k}</span><span class="an-v">${esc(a)}</span><span class="an-v">${esc(b)}</span>`;
            h += '<div class="an-totals"><span></span><span class="an-h">All time</span><span class="an-h">This month</span>'
                + row('Runs', String(Number(t.runs) || 0), String(Number(m.runs) || 0))
                + row('Cost', Number(t.costUnknownRuns) >= Number(t.runs) ? 'not recorded' : this._usd(Number(t.costUsd) || 0), this._usd(Number(m.costUsd) || 0))
                + row('Transcribed', this._anHours(t.audioSeconds), this._anHours(m.audioSeconds))
                + '</div>';
            const since = Number(t.since) ? new Date(Number(t.since)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
            const unknown = Number(t.costUnknownRuns) || 0;
            const notes = [
                since ? 'Since ' + since : '',
                Number(t.failed) ? `${t.failed} failed` : '',
                `${Number(t.llmRuns) || 0} with a model call`,
                Number(t.whisperSeconds) > 0 ? `${this._anHours(t.whisperSeconds)} spent transcribing` : '',
                unknown && unknown < Number(t.runs) ? `cost not recorded for ${unknown} run${unknown === 1 ? '' : 's'}` : '',
            ].filter(Boolean);
            h += `<div class="an-note">${esc(notes.join(' · '))}</div>`;
        }
        const active = Array.isArray(r.active) ? r.active : [];
        h += '<div class="push-subhead">Waiting or running</div>';
        h += active.length
            ? '<div class="an-list">' + active.map(a => this._anActiveHtml(a)).join('') + '</div>'
            : '<div class="downloads-empty">Nothing waiting or running.</div>';
        const shows = Array.isArray(r.shows) ? r.shows : [];
        if (shows.length) {
            h += '<div class="push-subhead">Shows</div><div class="an-list">';
            for (const s of shows) {
                const label = { on: 'On', off: 'Off' }[s.analyse] || 'Auto';
                const n = Number(s.runs) || 0;
                const sub = [`Analysis: ${label}`, n ? `${n} run${n === 1 ? '' : 's'}` : 'nothing analysed yet', n ? this._usd(Number(s.costUsd) || 0) : ''].filter(Boolean).join(' · ');
                h += `<button type="button" class="an-run an-show"${s.libraryItemId ? ` data-an-show="${esc(String(s.libraryItemId))}"` : ' disabled'}>`
                    + `<span class="an-title">${esc(s.title || 'Untitled')}</span><span class="an-line">${esc(sub)}</span></button>`;
            }
            h += '</div>';
        }
        if (runs.length) {
            h += '<button type="button" class="text-btn an-toggle" data-an-runs-toggle>Show runs</button>';
            h += '<div class="an-list" data-an-runs hidden></div>';
        }
        body.innerHTML = h;
    },
    _paintAnalysisRuns() {
        const st = this._anState;
        const list = document.querySelector('#analysis-body [data-an-runs]');
        if (!st || !list) return;
        list.hidden = !st.open;
        if (!st.open) return;
        list.innerHTML = st.runs.map(run => this._anRunHtml(run)).join('')
            + (st.nextBefore != null ? '<button type="button" class="text-btn an-more" data-an-more>Load more</button>' : '')
            + '<div class="an-note" data-an-more-note hidden></div>';
    },
    async _onAnalysisSettingsClick(e) {
        const ep = e.target.closest('[data-an-ep]');
        if (ep) { this.hideSettings(); this.openEpisodeById(ep.dataset.anItem, ep.dataset.anEp); return; }
        const show = e.target.closest('[data-an-show]');
        if (show) { this.hideSettings(); this.showItem(show.dataset.anShow); return; }
        const st = this._anState;
        const toggle = e.target.closest('[data-an-runs-toggle]');
        if (toggle && st) {
            st.open = !st.open;
            toggle.textContent = st.open ? 'Hide runs' : 'Show runs';
            this._paintAnalysisRuns();
            return;
        }
        const more = e.target.closest('[data-an-more]');
        if (!more || !st || st.nextBefore == null) return;
        more.disabled = true;
        more.textContent = 'Loading…';
        try {
            const r = await this._shimCall(this._anRunsUrl(`limit=${this._AN_PAGE}&before=${encodeURIComponent(st.nextBefore)}`));
            if (st !== this._anState) return;
            const seen = new Set(st.runs.map(x => x.id));
            for (const run of Array.isArray(r?.runs) ? r.runs : []) if (!seen.has(run.id)) st.runs.push(run);
            st.nextBefore = r?.nextBefore ?? null;
            this._paintAnalysisRuns();
        } catch (err) {
            if (st !== this._anState) return;
            more.disabled = false;
            more.textContent = 'Load more';
            const note = document.querySelector('#analysis-body [data-an-more-note]');
            if (note) { note.textContent = 'Couldn\'t load more: ' + err.message; note.hidden = false; }
        }
    },

    // ── Settings ──
    showSettings() {
        document.getElementById('setting-server').textContent = ABS.serverUrl;
        document.getElementById('setting-user').textContent = localStorage.getItem('pholia_username') || '';
        document.getElementById('setting-build').textContent = document.getElementById('build-version')?.textContent || '?';
        document.getElementById('setting-speed').value = Player.audio.playbackRate;
        document.getElementById('setting-skip').value = Player.skipDuration;
        document.getElementById('setting-theme').value = localStorage.getItem('pholia_theme') || 'dark';
        document.getElementById('setting-auto-cache').checked = localStorage.getItem('pholia_auto_cache') === 'true';
        document.getElementById('setting-keep-played').checked = localStorage.getItem('pholia_keep_played_episodes') === 'true';
        document.getElementById('setting-autoplay-next').checked = localStorage.getItem('pholia_autoplay_next') !== 'false';
        document.getElementById('setting-auto-rewind').checked = localStorage.getItem('pholia_auto_rewind') !== 'false';
        document.getElementById('setting-hide-collections').checked = localStorage.getItem('pholia_hide_collections') === 'true';
        const swExp = localStorage.getItem('pholia_sw_experimental') === 'true';
        document.getElementById('setting-sw-experimental').checked = swExp;
        document.getElementById('sw-log-section').classList.toggle('hidden', !swExp);
        // Rescan lives here for shim servers only (real ABS has its own UI).
        document.getElementById('shim-section').classList.toggle('hidden', !this.isShim);
        if (!this._shimRescanWired) {
            this._shimRescanWired = true;
            document.getElementById('shim-rescan').addEventListener('click', () => this.shimRescan());
        }
        this._renderFinishSetting();
        this._renderPushSettings({ fresh: true });
        this._renderAnalysisSettings();
        document.getElementById('settings-modal').classList.remove('hidden');
        this._renderSwLog();
        this.renderDownloadsList();
        this.renderAccountSection();
    },

    // POST /api/admin/libraries/:id/scan on the shim — picks up files that
    // landed on pCloud outside the grab flow (or formats /finish didn't
    // register). Same call the grab tail makes.
    async shimRescan() {
        const btn = document.getElementById('shim-rescan');
        const st = document.getElementById('shim-rescan-status');
        const libId = this.currentLibraryId || this.abbLibraryId;
        if (!libId) { st.textContent = 'No library selected.'; return; }
        btn.disabled = true;
        st.textContent = 'Scanning… (a big library can take a minute)';
        try {
            const r = await this._shimCall(`/api/admin/libraries/${encodeURIComponent(libId)}/scan`, { method: 'POST' });
            const errs = (r.errors || []).length;
            st.textContent = `Done: ${r.added || 0} added, ${r.skipped || 0} already known${errs ? ', ' + errs + ' error' + (errs === 1 ? '' : 's') + ' (see /admin)' : ''}.`;
            if (r.added) this._invalidateTabCache();
            await this._refreshLibraries();
        } catch (e) {
            st.textContent = 'Scan failed: ' + e.message;
        } finally {
            btn.disabled = false;
        }
    },
    hideSettings() { document.getElementById('settings-modal').classList.add('hidden'); },

    async renderAccountSection() {
        const status = document.getElementById('account-status');
        const actions = document.getElementById('account-actions');
        if (!status || !actions) return;

        const passkeyAvailable = await Account.isPasskeyAvailable();
        const me = Account.token() ? await Account.whoami() : null;

        if (!me) {
            const dot = '<span class="account-dot off"></span>';
            status.innerHTML = `${dot}Not signed in`;
            if (!passkeyAvailable) {
                actions.innerHTML = '<div class="setting-hint">This device doesn\'t support passkeys, so Pholia accounts aren\'t available here.</div>';
                return;
            }
            actions.innerHTML = `
                <div class="setting-hint">A Pholia account stores your server URL and password (encrypted) behind a passkey, so you can sign in with Face ID on any device.</div>
                <button id="account-signin" type="button">Sign in with existing passkey</button>
                <button id="account-create" type="button">Set up new Pholia account</button>
            `;
            document.getElementById('account-signin').addEventListener('click', () => this._signInExistingFromSettings());
            document.getElementById('account-create').addEventListener('click', () => this._setupAccountFromSettings());
            return;
        }

        const dot = '<span class="account-dot on"></span>';
        status.innerHTML = `${dot}Signed in · ${me.passkeys} passkey${me.passkeys === 1 ? '' : 's'}`;

        let servers = [];
        try { servers = await Account.listServers(); } catch {}

        const currentUsername = localStorage.getItem('pholia_username');
        let html = '';
        if (servers.length) {
            html += '<div class="account-server-list">';
            for (const s of servers) {
                const isCurrent = s.server_url === ABS.serverUrl && s.username === currentUsername;
                const cls = 'account-server-row' + (isCurrent ? ' current' : ' clickable');
                const tag = isCurrent
                    ? '<span class="account-server-current">Connected</span>'
                    : '';
                html += `<div class="${cls}" data-id="${s.id}" data-idx="${servers.indexOf(s)}" ${isCurrent ? '' : 'role="button" tabindex="0"'}>
                    <div class="acct-server-info">
                        <div>${esc(s.label || s.username)}${tag}</div>
                        <div class="acct-server-sub">${esc(s.username)} · ${esc(s.server_url)}</div>
                    </div>
                    <button class="text-btn account-server-remove" data-id="${s.id}">Remove</button>
                </div>`;
            }
            html += '</div>';
        }
        if (passkeyAvailable) {
            html += '<button id="account-add-passkey" type="button">Add another passkey</button>';
        }
        // If we're logged into ABS but the current server isn't in the
        // saved list, offer to add it. (The password isn't in memory, so
        // we ask for it.)
        const currentServerSaved = servers.some(s =>
            s.server_url === ABS.serverUrl && s.username === localStorage.getItem('pholia_username')
        );
        if (ABS.serverUrl && !currentServerSaved) {
            html += '<button id="account-add-server" type="button">Save current server to account</button>';
        }
        html += '<button id="account-logout" type="button" class="danger-btn">Sign out of Pholia account</button>';
        actions.innerHTML = html;

        actions.querySelectorAll('.account-server-row.clickable').forEach(row => {
            const connect = async () => {
                if (row.classList.contains('busy')) return;
                row.classList.add('busy');
                const idx = parseInt(row.dataset.idx, 10);
                const server = servers[idx];
                if (!server) return;
                try { await this.loginFromAccount(server); }
                finally { row.classList.remove('busy'); }
            };
            row.addEventListener('click', connect);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); connect(); }
            });
        });
        actions.querySelectorAll('.account-server-remove').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm('Remove this saved server? You\'ll need to log in manually next time.')) return;
                btn.disabled = true; btn.textContent = 'Removing…';
                try {
                    await Account.deleteServer(btn.dataset.id);
                    this.renderAccountSection();
                } catch (e) {
                    btn.disabled = false; btn.textContent = 'Remove';
                    alert('Could not remove: ' + e.message);
                }
            });
        });
        document.getElementById('account-add-passkey')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const orig = btn.textContent;
            btn.disabled = true; btn.textContent = 'Setting up…';
            try {
                await Account.registerPasskey({ newAccount: false });
                this.renderAccountSection();
            } catch (err) {
                const msg = err?.message || '';
                if (!/Cancelled|NotAllowed/i.test(msg)) alert('Failed: ' + msg);
                btn.disabled = false; btn.textContent = orig;
            }
        });
        document.getElementById('account-add-server')?.addEventListener('click', () => this._saveCurrentServerFromSettings());
        document.getElementById('account-logout')?.addEventListener('click', async () => {
            if (!confirm('Sign out of your Pholia account on this device? Saved servers stay in the account but you\'ll need a passkey to access them again.')) return;
            await Account.logout();
            this.renderAccountSection();
        });
    },

    // Settings → Set up Pholia account: register a passkey to create the
    // account, then save the currently-logged-in server (if any) by asking
    // for the password (not in memory after auto-login).
    async _setupAccountFromSettings() {
        try {
            await Account.registerPasskey({ newAccount: true });
        } catch (err) {
            const msg = err?.message || '';
            if (!/Cancelled|NotAllowed/i.test(msg)) alert('Passkey setup failed: ' + msg);
            return;
        }
        if (ABS.serverUrl) {
            await this._saveCurrentServerFromSettings();
        }
        this.renderAccountSection();
    },

    // Settings → Sign in with existing passkey: authenticate against an
    // existing Pholia account from a device that's only logged into a server.
    // Re-renders the section so the user sees their saved servers and the
    // "save current server" offer if applicable.
    async _signInExistingFromSettings() {
        try {
            await Account.authenticateWithPasskey();
        } catch (err) {
            const msg = err?.message || '';
            if (!/Cancelled|NotAllowed/i.test(msg) && err?.name !== 'NotAllowedError') {
                alert('Passkey sign-in failed: ' + msg);
            }
            return;
        }
        this.renderAccountSection();
    },

    async _saveCurrentServerFromSettings() {
        if (!ABS.serverUrl) return;
        const username = localStorage.getItem('pholia_username') || '';
        const password = prompt(
            `Save the current server (${ABS.serverUrl}) to your Pholia account? ` +
            `Enter your ABS password — it'll be encrypted and stored so Face ID can ` +
            `sign you in on any device.`
        );
        if (!password) return;
        try {
            await Account.saveServer({ server_url: ABS.serverUrl, username, password });
            this.renderAccountSection();
        } catch (e) {
            alert('Save failed: ' + e.message);
        }
    },

    async renderDownloadsList() {
        const list = document.getElementById('downloads-list');
        const clearBtn = document.getElementById('downloads-clear');
        if (!list) return;
        list.innerHTML = '<div class="downloads-empty">Loading…</div>';
        await Offline.cleanupPhantoms();
        const items = await Offline.listDownloaded();
        if (!items.length) {
            list.innerHTML = '<div class="downloads-empty">Nothing cached yet</div>';
            clearBtn.style.display = 'none';
            return;
        }
        clearBtn.style.display = '';
        const sizes = await Promise.all(items.map(i => Offline.bookSize(i)));
        const totalBytes = sizes.reduce((a, b) => a + b, 0);
        let html = `<div class="downloads-total">Total: ${formatBytes(totalBytes)}</div>`;
        items.forEach((item, i) => {
            const meta = item.media?.metadata || {};
            const title = meta.title || 'Unknown';
            const author = meta.authorName || '';
            html += `<div class="downloads-row" data-id="${esc(Offline.oid(item))}">`;
            html += `<div class="downloads-info">`;
            html += `<div class="downloads-title">${esc(title)}</div>`;
            html += `<div class="downloads-sub">${esc(author)} • ${formatBytes(sizes[i])}</div>`;
            html += `</div>`;
            html += `<button class="text-btn downloads-remove" data-id="${esc(Offline.oid(item))}">Remove</button>`;
            html += `</div>`;
        });
        list.innerHTML = html;
        list.querySelectorAll('.downloads-remove').forEach(btn => {
            btn.addEventListener('click', async () => {
                const item = items.find(i => Offline.oid(i) === btn.dataset.id);
                if (!item) return;
                btn.disabled = true; btn.textContent = 'Removing…';
                await Offline.deleteBook(item);
                this._invalidateHomeCache();
                this.renderDownloadsList();
            });
        });
        clearBtn.onclick = async () => {
            if (!confirm(`Remove all ${items.length} cached download${items.length === 1 ? '' : 's'}?`)) return;
            list.innerHTML = '<div class="downloads-empty">Clearing…</div>';
            for (const item of items) await Offline.deleteBook(item);
            this._invalidateHomeCache();
            this.renderDownloadsList();
        };
    },

    // ── Fullscreen player ──
    openFullscreen() {
        if (!Player.item) return;
        document.getElementById('fs-player').classList.remove('hidden');
        document.body.classList.add('fs-open');
        document.getElementById('fs-cover-wrap').classList.remove('is-flipped');
        this._renderFsFileInfo();
        this._renderFsDescription();
        Player.updateUI();
    },

    _renderFsFileInfo() {
        const list = document.getElementById('fs-info-list');
        const item = Player.item;
        const tracks = item?.media?.audioFiles || [];
        const cur = tracks[Player.currentTrackIndex] || tracks[0];
        const rows = [];
        const md = cur?.metadata || {};
        const codec = cur?.codec || md.codec;
        const bitRate = cur?.bitRate ?? md.bitRate ?? cur?.bitrate;
        const channels = cur?.channels ?? md.channels;
        const sampleRate = cur?.sampleRate ?? md.sampleRate;
        const mimeType = cur?.mimeType || cur?.format;
        const size = cur?.metadata?.size ?? cur?.size;
        const filename = cur?.metadata?.filename || cur?.filename;
        const duration = cur?.duration;
        const trackCount = tracks.length;

        const fmtBitrate = (b) => {
            if (b == null) return null;
            const kbps = b > 10000 ? Math.round(b / 1000) : Math.round(b);
            return kbps + ' kbps';
        };
        const fmtSize = (n) => {
            if (n == null) return null;
            if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
            if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
            if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
            return n + ' B';
        };
        const fmtSample = (s) => s == null ? null : (s >= 1000 ? (s / 1000).toFixed(1) + ' kHz' : s + ' Hz');
        const add = (k, v) => { if (v != null && v !== '') rows.push([k, v]); };

        add('Codec', codec ? String(codec).toUpperCase() : null);
        add('Bitrate', fmtBitrate(bitRate));
        add('Sample rate', fmtSample(sampleRate));
        add('Channels', channels);
        add('Container', mimeType);
        add('Duration', duration ? formatTime(duration) : null);
        add('Size', fmtSize(size));
        const store = cur && cur.storage;
        if (store && store.name) add('Storage', store.detail ? store.name + ' / ' + store.detail : store.name);
        if (trackCount > 1) add('Track', `${(Player.currentTrackIndex ?? 0) + 1} of ${trackCount}`);
        add('File', filename);

        list.innerHTML = rows.length
            ? rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')
            : '<dt style="grid-column:1/-1;color:var(--text-muted);font-style:italic">No file info available</dt>';
    },

    _renderFsDescription() {
        const wrap = document.getElementById('fs-description-wrap');
        const body = document.getElementById('fs-description');
        const btn = document.getElementById('fs-description-toggle');
        const md = Player.item?.media?.metadata;
        // An episode whose notes came as a snippet: fetch the rest, then draw again.
        if (md?.descriptionTrimmed && Player.item.episodeId) {
            const item = Player.item;
            const ep = { id: item.episodeId, description: '', descriptionTrimmed: true };
            this._fullNotes(item.id, ep).then((full) => {
                // Failed (offline): the snippet stays, and the next opening asks again.
                if (ep.descriptionTrimmed || Player.item !== item || !md.descriptionTrimmed) return;
                md.description = this._plainText(full);
                md.descriptionTrimmed = false;
                this._renderFsDescription();
            });
        }
        const desc = md?.description?.trim();
        if (!desc) { wrap.hidden = true; return; }
        wrap.hidden = false;
        body.textContent = desc;
        body.classList.add('is-collapsed');
        btn.textContent = 'Read more';
        // Show the toggle only if the text actually overflows the collapsed height
        requestAnimationFrame(() => {
            const overflows = body.scrollHeight > body.clientHeight + 2;
            btn.hidden = !overflows;
            if (!overflows) body.classList.remove('is-collapsed');
        });
    },
    closeFullscreen() {
        // Leave the player on its first page, or reopening lands on chapters.
        this.showFsChapters(false);
        document.getElementById('fs-player').classList.add('hidden');
        document.body.classList.remove('fs-open');
    },

    // The chapter list keeps its own `hidden` class because Player's tick
    // reads it to decide whether the rows are worth repainting — don't drop
    // it in favour of the panel class alone.
    showFsChapters(open) {
        const fs = document.getElementById('fs-player');
        const list = document.getElementById('fs-chapter-list');
        const panel = document.getElementById('fs-chapters-panel');
        fs.classList.toggle('chapters-open', !!open);
        panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        list.classList.toggle('hidden', !open);
        if (open) this.renderFsChapters();
    },

    // Drag the chapter page in and out with your finger, like turning a page
    // or switching desktops: the panel tracks the touch 1:1 and settles to
    // whichever side it was heading for on release. Two fingers work anywhere
    // in the player; one finger only from the artwork area and the chapters
    // header, because a one-finger horizontal drag over the scrubber is a
    // seek and over a chapter row is a tap-to-position.
    //
    // The gesture only engages once movement is clearly horizontal, so a
    // vertical scroll of the artwork or the chapter list still scrolls. While
    // dragging, the panel gets `.dragging` (transition off, visible even when
    // closed) plus an inline transform; both are dropped on release so the
    // CSS class animates the last stretch.
    _wireFsSwipe() {
        const fs = document.getElementById('fs-player');
        const panel = document.getElementById('fs-chapters-panel');
        const ENGAGE_PX = 12;         // movement before we claim the gesture
        const SETTLE_FRACTION = 0.3;  // dragged this far across, it settles
        const FLICK_PX_PER_MS = 0.8;  // a real flick; a careful drag is far slower
        const FLICK_MIN_PX = 40;      // ...and has to have gone somewhere

        let startX = 0, startY = 0, lastX = 0, lastT = 0, velocity = 0;
        let width = 1, base = 0, active = false, engaged = false, wasOpen = false;
        // 'chapters' drags the chapter page; 'dismiss' drags the whole player
        // away to the right, which is the way back to whatever opened it —
        // tapping something in Continue listening lands you here, and the
        // close button is a long reach from the bottom of a phone.
        let kind = 'chapters';

        fs.addEventListener('touchstart', (e) => {
            active = false; engaged = false;
            if (e.touches.length > 2) return;
            // One finger works anywhere except the scrubber, where a
            // horizontal drag is a seek. It used to be limited to the artwork
            // and the chapters header, which meant you could swipe TO the
            // chapter list with one finger but needed two to get back — the
            // chapter rows filled the screen. A drag over a row is now
            // suppressed as a tap instead (see renderFsChapters).
            if (e.touches.length === 1 && e.target.closest('#fs-seek')) return;
            const t = e.touches[0];
            startX = lastX = t.clientX;
            startY = t.clientY;
            lastT = e.timeStamp;
            velocity = 0;
            this._fsDragged = false;
            width = fs.clientWidth || 1;
            wasOpen = fs.classList.contains('chapters-open');
            base = wasOpen ? 0 : width;
            active = true;
        }, { passive: true });

        fs.addEventListener('touchmove', (e) => {
            if (!active) return;
            const t = e.touches[0];
            if (!t) return;
            const dx = t.clientX - startX, dy = t.clientY - startY;
            if (!engaged) {
                // A vertical scroll wins outright; only clear horizontal
                // movement claims the gesture.
                if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > ENGAGE_PX) { active = false; return; }
                if (Math.abs(dx) < ENGAGE_PX) return;
                engaged = true;
                // Tells the chapter rows to ignore the click this touch will
                // fire when it lands on one.
                this._fsDragged = true;
                // Rightward with the chapter page already shut means "leave",
                // not "close the thing that is already closed".
                kind = (!wasOpen && dx > 0) ? 'dismiss' : 'chapters';
                if (kind === 'dismiss') {
                    fs.classList.add('dismissing');
                } else {
                    panel.classList.add('dragging');
                    if (!wasOpen) this._prepareFsChapters();   // don't slide in a blank page
                }
            }
            const dt = e.timeStamp - lastT;
            if (dt > 0) velocity = (t.clientX - lastX) / dt;
            lastX = t.clientX;
            lastT = e.timeStamp;
            if (kind === 'dismiss') {
                fs.style.transform = 'translateX(' + Math.max(0, dx) + 'px)';
            } else {
                panel.style.transform = 'translateX(' + Math.max(0, Math.min(width, base + dx)) + 'px)';
            }
            if (e.cancelable) e.preventDefault();
        }, { passive: false });

        const end = (e) => {
            if (!active) return;
            active = false;
            if (!engaged) return;
            engaged = false;
            const t = e.changedTouches && e.changedTouches[0];
            const dx = t ? t.clientX - startX : 0;
            const flick = Math.abs(velocity) > FLICK_PX_PER_MS && Math.abs(dx) > FLICK_MIN_PX;

            if (kind === 'dismiss') {
                // A flick alone isn't enough to throw the player away: a brisk
                // 10% swipe while reaching for the scrubber shouldn't close
                // what you're listening to. It has to have travelled too.
                const flickFar = flick && velocity > 0 && dx > Math.max(60, width * 0.12);
                const leave = flickFar || dx > width * SETTLE_FRACTION;
                if (leave) {
                    fs.classList.add('settling');
                    fs.style.transform = 'translateX(' + width + 'px)';
                    setTimeout(() => {
                        this.closeFullscreen();
                        fs.classList.remove('dismissing', 'settling');
                        fs.style.transform = '';
                    }, 180);
                    return;
                }
                fs.classList.add('settling');
                fs.style.transform = '';
                setTimeout(() => fs.classList.remove('dismissing', 'settling'), 220);
                return;
            }

            const x = Math.max(0, Math.min(width, base + dx));
            const open = flick ? velocity < 0 : x < width * (1 - SETTLE_FRACTION);
            panel.classList.remove('dragging');
            panel.style.transform = '';
            this.showFsChapters(open);
        };
        fs.addEventListener('touchend', end, { passive: true });
        fs.addEventListener('touchcancel', end, { passive: true });
    },

    // Two gestures on the content area, both finger-following like the
    // chapter page:
    //   • drag right from the left edge → go back (what the header's back
    //     button does)
    //   • drag down at the top of a list → grow the inline search bar out
    //     from under the header; drag up to put it away again
    // They're wired together because one touch has to choose between them:
    // the axis is decided once, at 12px of movement, and never revisited.
    //
    // The back drag works from anywhere on the page, not just the left edge:
    // an edge-only gesture is hard to hit and, in a browser tab, iOS claims
    // that edge for its own back gesture so ours never sees the touch. It is
    // only armed when there is somewhere to go back to, so on a tab's own
    // home screen it does nothing.
    _wireContentGestures() {
        const content = document.getElementById('content');
        const bar = document.getElementById('inline-search');
        const ENGAGE_PX = 12;
        const BACK_SETTLE = 0.3;      // fraction of the width that commits the back
        const FLICK_PX_PER_MS = 0.8;
        const BAR_H = 56;             // the bar's height when fully open

        let startX = 0, startY = 0, lastX = 0, lastT = 0, velocity = 0;
        let width = 1, baseH = 0, mode = null, active = false;

        const barOpen = () => bar.offsetHeight > BAR_H / 2;
        const canGoBack = () =>
            !document.getElementById('back-btn').classList.contains('hidden') || this.currentTab === 'add';
        const canPull = () => content.scrollTop <= 0 && this.currentTab !== 'add';

        const settleBar = (open) => {
            bar.classList.add('settling');
            bar.style.height = open ? BAR_H + 'px' : '0px';
            setTimeout(() => bar.classList.remove('settling'), 220);
            if (!open) this.closeInlineSearch();
        };
        const resetContent = (animate) => {
            content.classList.remove('dragging');
            if (animate) {
                content.classList.add('settling');
                setTimeout(() => content.classList.remove('settling'), 240);
            }
            content.style.transform = '';
        };

        content.addEventListener('touchstart', (e) => {
            active = false; mode = null;
            // A previous gesture whose settle timers never ran (a tab
            // backgrounded mid-swipe throttles timeouts hard) would leave the
            // page translated off-screen. Put it back before starting a new one.
            if (content.style.transform) {
                content.classList.remove('dragging', 'settling');
                content.style.transform = '';
            }
            if (e.touches.length !== 1) return;
            // A shelf that can still scroll right keeps its own swipe; one
            // already at its left end can't use a rightward drag anyway, so
            // the back gesture may have it.
            const shelf = e.target.closest('.h-scroll');
            if (shelf && shelf.scrollLeft > 0) return;
            const t = e.touches[0];
            startX = lastX = t.clientX;
            startY = t.clientY;
            lastT = e.timeStamp;
            velocity = 0;
            width = content.clientWidth || 1;
            baseH = bar.offsetHeight;
            active = true;
        }, { passive: true });

        content.addEventListener('touchmove', (e) => {
            if (!active) return;
            const t = e.touches[0];
            if (!t) return;
            const dx = t.clientX - startX, dy = t.clientY - startY;
            if (!mode) {
                if (Math.abs(dx) < ENGAGE_PX && Math.abs(dy) < ENGAGE_PX) return;
                if (Math.abs(dx) > Math.abs(dy) && dx > 0 && canGoBack()) {
                    mode = 'back';
                    content.classList.remove('settling');
                    content.classList.add('dragging');
                } else if (Math.abs(dy) > Math.abs(dx) && canPull() && (dy > 0 || baseH > 0)) {
                    mode = 'pull';
                    bar.classList.remove('settling');
                } else {
                    active = false;   // an ordinary scroll — leave it alone
                    return;
                }
            }
            const dt = e.timeStamp - lastT;
            if (mode === 'back') {
                if (dt > 0) velocity = (t.clientX - lastX) / dt;
                content.style.transform = 'translateX(' + Math.max(0, Math.min(width, dx)) + 'px)';
            } else {
                // The bar's height follows the finger, a bit damped, so it
                // grows out from under the header instead of the whole page
                // moving.
                const h = Math.max(0, Math.min(BAR_H, baseH + dy * 0.7));
                bar.style.height = h + 'px';
            }
            lastX = t.clientX;
            lastT = e.timeStamp;
            if (e.cancelable) e.preventDefault();
        }, { passive: false });

        const end = (e) => {
            if (!active) return;
            active = false;
            const m = mode;
            mode = null;
            if (!m) return;
            const t = e.changedTouches && e.changedTouches[0];
            const dx = t ? t.clientX - startX : 0;
            if (m === 'back') {
                const commit = (velocity > FLICK_PX_PER_MS && dx > 40) || dx > width * BACK_SETTLE;
                if (commit) {
                    // Slide the outgoing page off to the right, then render
                    // the previous one and bring it in from the LEFT: it was
                    // sitting behind this page, not ahead of it. Clearing the
                    // transform instead (what this did until 2026-09-21) let
                    // the `settling` transition run the new page in from the
                    // right — the same direction the finger had just gone.
                    content.classList.add('settling');
                    content.style.transform = 'translateX(' + width + 'px)';
                    setTimeout(() => {
                        content.classList.remove('dragging');
                        content.classList.remove('settling');   // jump, don't animate
                        content.style.transform = 'translateX(' + (-width) + 'px)';
                        this.goBack();
                        void content.offsetWidth;               // commit the jump
                        content.classList.add('settling');
                        content.style.transform = 'translateX(0)';
                        setTimeout(() => {
                            content.classList.remove('settling');
                            content.style.transform = '';
                        }, 240);
                    }, 180);
                    return;
                }
                resetContent(true);
                return;
            }
            settleBar(barOpen());
        };
        content.addEventListener('touchend', end, { passive: true });
        content.addEventListener('touchcancel', end, { passive: true });
    },

    // The inline bar searches into the content area itself: results replace
    // the list you pulled down from, and clearing or cancelling puts that
    // list back. The full-screen overlay behind the header's magnifier is
    // untouched.
    _wireInlineSearch() {
        const bar = document.getElementById('inline-search');
        const input = document.getElementById('inline-search-input');
        const run = debounce((v) => {
            if (!v || v.length < 2) { if (this._inlineSearching) this._restoreAfterInlineSearch(); return; }
            this._inlineSearching = true;
            this.doSearch(v, document.getElementById('content'));
        }, 300);
        input.addEventListener('input', (e) => run(e.target.value));
        this._wireSearchClear(input, document.getElementById('inline-search-clear'), () => {
            this._restoreAfterInlineSearch();
        });
        document.getElementById('inline-search-cancel').addEventListener('click', () => {
            bar.classList.add('settling');
            bar.style.height = '0px';
            setTimeout(() => bar.classList.remove('settling'), 220);
            this.closeInlineSearch();
        });
    },

    closeInlineSearch() {
        const input = document.getElementById('inline-search-input');
        if (input.value) input.value = '';
        input.dispatchEvent(new Event('input'));
        input.blur();
        this._restoreAfterInlineSearch();
    },

    _restoreAfterInlineSearch() {
        if (!this._inlineSearching) return;
        this._inlineSearching = false;
        this.switchTab(this.currentTab);
    },

    // Render the chapter rows without moving the panel — used mid-drag so the
    // page isn't blank as it slides in.
    _prepareFsChapters() {
        document.getElementById('fs-chapter-list').classList.remove('hidden');
        this.renderFsChapters();
    },

    renderFsChapters() {
        const list = document.getElementById('fs-chapter-list');
        if (!Player.chapters.length) { list.innerHTML = '<div style="padding:0.5rem;color:var(--text-muted)">No chapters</div>'; return; }
        let html = '<ul class="tracklist">';
        const gt = Player.getGlobalTime();
        for (let i = 0; i < Player.chapters.length; i++) {
            const ch = Player.chapters[i];
            const chDur = ch.end - ch.start;
            const isActive = i === Player.currentChapterIndex;
            let prog = 0;
            if (isActive && chDur > 0) prog = ((gt - ch.start) / chDur) * 100;
            else if (gt >= ch.end) prog = 100;
            html += `<li class="tracklist-item ${isActive ? 'is-active' : ''}" data-index="${i}" id="fs-ch-${i}">`;
            html += `<div class="tracklist-cache-fill"></div>`;
            html += `<div class="tracklist-progress" style="width:${prog}%"></div>`;
            html += `<button class="tracklist-play"><span class="tracklist-num">${ch.id != null ? ch.id + 1 : i + 1}</span>`;
            html += `<span class="tracklist-title">${esc(ch.title)}</span>`;
            html += `<span class="tracklist-duration">${formatTime(chDur)}</span></button></li>`;
        }
        html += '</ul>';
        list.innerHTML = html;
        list.querySelectorAll('.tracklist-item').forEach(el => {
            el.querySelector('.tracklist-play').addEventListener('click', (e) => {
                // A horizontal drag across the list is the back gesture, and
                // it still fires a click on release — don't seek because of it.
                if (this._fsDragged) { this._fsDragged = false; return; }
                const rect = el.getBoundingClientRect();
                const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                Player.seekChapterByTap(parseInt(el.dataset.index), fraction);
            });
        });
        // Scroll to current chapter
        const activeEl = document.getElementById(`fs-ch-${Player.currentChapterIndex}`);
        if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (Player.item) this.markCachedChapters(Player.item);
    },
};

// Offline download manager — stores audio + cover in Cache Storage,
// keyed with the auth token stripped so cache survives token rotation.
const Offline = {
    AUDIO_CACHE: 'pholia-offline-audio-v2',
    META_CACHE: 'pholia-offline-meta-v1',

    keyFor(url) {
        const u = new URL(url);
        u.searchParams.delete('token');
        return u.toString();
    },

    // Cache keys for chunked entries. Use query params not fragments — the
    // Cache API strips fragments before storing/matching, so #chunk=0 and
    // #chunk=1 collapse to the same key. Query params are preserved.
    chunkKey(baseKey, i) {
        return baseKey + (baseKey.includes('?') ? '&' : '?') + '__chunk=' + i;
    },
    chunkMetaKey(baseKey) {
        return baseKey + (baseKey.includes('?') ? '&' : '?') + '__meta=1';
    },
    // Sentinel marking that all chunks for this entry are cached. Only
    // present when the SW is allowed to intercept and serve from cache;
    // partial sliding-window caches do NOT get this sentinel. (iOS WebKit
    // adds latency to SW-intercepted media fetches, so partial caches must
    // be passed through natively.)
    completeKey(baseKey) {
        return baseKey + (baseKey.includes('?') ? '&' : '?') + '__complete=1';
    },

    // Memoized chunkCoverage results, keyed by itemId. Each entry records the
    // _coverageVersion at compute time. Any chunk write or delete bumps the
    // global version, invalidating all cached entries on next access. For a
    // settled (fully-downloaded) book that nothing is writing to, the cache
    // stays valid for the page's lifetime — turning a thousand-entry
    // cache.keys() walk into a Map.get() on every detail-page / fullscreen
    // open.
    _coverageCache: new Map(),
    _coverageVersion: 0,
    _invalidateCoverage() { this._coverageVersion++; },

    notifySwCacheChanged() {
        this._invalidateCoverage();
        try { navigator.serviceWorker?.controller?.postMessage({ type: 'CACHE_CHANGED' }); } catch {}
    },

    // Debounced variant — call after individual chunk writes so the SW's
    // chunk-coverage map gets refreshed without spamming it with a message
    // (and full cache.keys() walk) per chunk during a long auto-cache run.
    _pendingSwNotify: null,
    notifySwCacheChangedSoon() {
        if (this._pendingSwNotify) return;
        this._pendingSwNotify = setTimeout(() => {
            this._pendingSwNotify = null;
            this.notifySwCacheChanged();
        }, 1000);
    },

    metaKey(itemId) { return `https://pholia.local/meta/${itemId}`; },

    // An offline entry's own id. A podcast episode shares its show's item
    // id (its audio is /api/items/<show>/file/<ino>, which is what the
    // chunks are keyed by), so its record, coverage memo and "downloaded"
    // set entries use show~episode. A book's is just its id.
    oid(item) { return item?.episodeId ? `${item.id}~${item.episodeId}` : item?.id; },

    trackUrls(item) {
        return (item.media?.audioFiles || []).map(t => ABS.trackUrl(item.id, t.ino));
    },

    async isDownloaded(item) {
        const tracks = item.media?.audioFiles || [];
        if (!tracks.length) return false;
        const coverage = await this.chunkCoverage(item);
        for (let i = 0; i < tracks.length; i++) {
            const cov = coverage[i];
            if (!cov) return false;
            if (cov.legacy) continue;
            if (cov.cached.size !== cov.numChunks) return false;
        }
        return true;
    },

    async downloadBook(item, onProgress) {
        const audioCache = await caches.open(this.AUDIO_CACHE);
        const urls = this.trackUrls(item);

        try {
            const coverUrl = ABS.coverUrl(item.id);
            const coverKey = this.keyFor(coverUrl);
            if (!(await audioCache.match(coverKey))) {
                const coverRes = await fetch(coverUrl, { credentials: 'omit' });
                if (coverRes.ok) await audioCache.put(coverKey, coverRes);
            }
        } catch {}

        for (let i = 0; i < urls.length; i++) {
            const key = this.keyFor(urls[i]);
            // Always run — _streamFetchToCache validates and skips chunks
            // that are already correctly cached. sticky: true marks this
            // book as user-pinned so auto-cache eviction won't touch it.
            await this._streamFetchToCache(audioCache, urls[i], key, (received, total) => {
                onProgress?.(i, urls.length, received, total);
            }, { sticky: true });
            onProgress?.(i + 1, urls.length);
        }

        await this.saveMeta(item);
        this.notifySwCacheChanged();
    },

    CHUNK_SIZE: 10 * 1024 * 1024, // 10 MB

    // Fetch a track in 10 MB pieces using HTTP Range, storing each piece as
    // its own cache entry. Avoids putting a multi-hundred-MB Response into
    // cache.put in one go (which OOMs iOS PWA). The SW reassembles chunks
    // when the audio element makes Range requests during playback.
    async _streamFetchToCache(cache, url, key, onChunk, opts = {}) {
        // Discover the full file size. Try HEAD first — Content-Length is
        // CORS-safelisted, so it works across browsers. Fall back to a Range
        // probe + Content-Range parsing only if HEAD fails or doesn't return
        // a size. (Content-Range is NOT safelisted, so requires the server to
        // opt in via Access-Control-Expose-Headers, which ABS doesn't do —
        // this is why the probe-only approach reported 1 byte.)
        let total = 0;
        let contentType = 'audio/mpeg';
        try {
            const head = await fetch(url, { method: 'HEAD', credentials: 'omit' });
            if (head.ok) {
                const len = parseInt(head.headers.get('content-length') || '0', 10);
                if (len > 0) total = len;
                contentType = head.headers.get('content-type') || contentType;
            }
        } catch {}
        if (!total) {
            try {
                const probe = await fetch(url, {
                    credentials: 'omit',
                    headers: { Range: 'bytes=0-0' },
                });
                if (probe.status === 206) {
                    const cr = probe.headers.get('content-range');
                    if (cr) {
                        const m = /\/(\d+)$/.exec(cr);
                        if (m) total = parseInt(m[1], 10);
                    }
                    contentType = probe.headers.get('content-type') || contentType;
                }
                try { await probe.arrayBuffer(); } catch {}
            } catch {}
        }

        if (!total) {
            // Last-resort fallback: one-shot streaming.
            const res = await fetch(url, { credentials: 'omit' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const headers = new Headers();
            for (const [k, v] of res.headers.entries()) headers.set(k, v);
            await cache.put(key, new Response(res.body, { status: 200, headers }));
            return;
        }

        const metaK = this.chunkMetaKey(key);
        const numChunks = Math.ceil(total / this.CHUNK_SIZE);

        // Determine sticky state. Sliding-window auto-cache passes sticky:false;
        // explicit Download passes sticky:true. We never downgrade a previously
        // sticky entry — once a book has been pinned, it stays pinned.
        let sticky = !!opts.sticky;
        const existingMeta = await cache.match(metaK);
        if (existingMeta) {
            try {
                const m = await existingMeta.json();
                if (m.totalSize !== total || m.chunkSize !== this.CHUNK_SIZE) {
                    await cache.delete(metaK);
                } else if (m.sticky === true) {
                    sticky = true;
                }
            } catch { await cache.delete(metaK); }
        }

        // Write meta upfront so coverage queries (markCachedChapters) work
        // mid-loop. With sliding-window caching the loop can take a long time
        // (chunks ahead of the playhead sleep until playback catches up), so
        // a trailing meta-write would leave the UI without coverage info for
        // most of a session.
        await cache.put(metaK, new Response(JSON.stringify({
            contentType, totalSize: total, chunkSize: this.CHUNK_SIZE, numChunks, sticky,
        }), { headers: { 'Content-Type': 'application/json' } }));

        let received = 0;

        for (let i = 0; i < numChunks; i++) {
            const start = i * this.CHUNK_SIZE;
            // Caller can filter out chunks they don't want cached at all
            // (e.g. too far behind a playhead). Skipped chunks aren't fetched
            // and aren't counted toward progress.
            if (opts.shouldCache && !opts.shouldCache(start, total)) continue;

            const chunkK = this.chunkKey(key, i);
            const expected = (i === numChunks - 1) ? (total - i * this.CHUNK_SIZE) : this.CHUNK_SIZE;

            // Trust an existing chunk only if its byte length matches what
            // this position should hold. Catches stale/partial chunks left
            // behind by previous failed downloads.
            const existing = await cache.match(chunkK);
            if (existing) {
                const len = parseInt(existing.headers.get('content-length') || '0', 10);
                if (len === expected) {
                    received += expected;
                    try { await onChunk?.(received, total); } catch {}
                    continue;
                }
                await cache.delete(chunkK);
            }

            const end = Math.min(start + this.CHUNK_SIZE - 1, total - 1);
            if (opts.beforeChunk) await opts.beforeChunk(start, total);
            const fetchOpts = {
                credentials: 'omit',
                headers: { Range: `bytes=${start}-${end}` },
            };
            if (opts.priority) fetchOpts.priority = opts.priority;
            const res = await fetch(url, fetchOpts);
            if (res.status !== 206 && res.status !== 200) {
                throw new Error(`Range fetch ${i} failed: ${res.status}`);
            }
            const blob = await res.blob();
            if (blob.size !== expected) {
                throw new Error(`Chunk ${i} size mismatch: expected ${expected}, got ${blob.size}`);
            }
            await cache.put(chunkK, new Response(blob, {
                status: 200,
                headers: { 'Content-Type': contentType, 'Content-Length': String(blob.size) },
            }));
            this._invalidateCoverage();
            // Tell the SW its chunk-coverage map has a new entry. Debounced
            // so a tight chunk loop doesn't make the SW re-walk cache.keys()
            // hundreds of times. Without this, the SW's view of sliding-window
            // chunks would only refresh when the __complete sentinel changes
            // (i.e. never, for partial caches).
            this.notifySwCacheChangedSoon();
            received += blob.size;
            try { onChunk?.(received, total); } catch {}
        }

        // Update the __complete sentinel based on whether every chunk is now
        // present at the expected size. The SW only intercepts entries with
        // this sentinel — partial caches must pass through to the network
        // natively to avoid iOS WebKit's SW-media-fetch latency penalty.
        const completeK = this.completeKey(key);
        const wasComplete = !!(await cache.match(completeK));
        let allPresent = true;
        for (let i = 0; i < numChunks; i++) {
            const c = await cache.match(this.chunkKey(key, i));
            if (!c) { allPresent = false; break; }
            const expected = (i === numChunks - 1) ? (total - i * this.CHUNK_SIZE) : this.CHUNK_SIZE;
            const len = parseInt(c.headers.get('content-length') || '0', 10);
            if (len !== expected) { allPresent = false; break; }
        }
        if (allPresent) {
            await cache.put(completeK, new Response('', { headers: { 'Content-Type': 'application/octet-stream' } }));
        } else {
            await cache.delete(completeK);
        }
        // Refresh the SW's cachedKeys snapshot so it knows whether to start
        // (or stop) intercepting this URL — only relevant when the sentinel
        // actually changed.
        if (allPresent !== wasComplete) this.notifySwCacheChanged();
    },

    async saveMeta(item) {
        this._invalidateCoverage();
        const metaCache = await caches.open(this.META_CACHE);
        await metaCache.put(
            this.metaKey(this.oid(item)),
            new Response(JSON.stringify(item), { headers: { 'Content-Type': 'application/json' } })
        );
    },

    // Returns per-track coverage info needed to render chapter cache state.
    // For each audioFile: null (nothing cached), { legacy: true } (whole-file
    // cache, treat as fully covered), or { totalSize, chunkSize, numChunks,
    // cached: Set<int> } for chunked entries. Memoized — see _coverageCache.
    async chunkCoverage(item) {
        const ver = this._coverageVersion;
        const hit = this._coverageCache.get(this.oid(item));
        if (hit && hit.version === ver) return hit.coverage;
        const coverage = await this._computeChunkCoverage(item);
        // Only commit if the version hasn't moved underneath us during the
        // async walk (another chunk wrote mid-compute → next caller rebuilds).
        if (this._coverageVersion === ver) {
            this._coverageCache.set(this.oid(item), { coverage, version: ver });
        }
        return coverage;
    },

    // Compute coverage for many items in one cache.keys() walk. The per-item
    // path walks the entire audio cache *per book*; on a fully-downloaded
    // library that's the dominant cost of cold-open home render. This batch
    // walks once, pre-buckets chunk URLs by their prefix, and looks up each
    // track in O(1). Populates the per-item memo as a side effect so later
    // chunkCoverage(item) callers hit the cache.
    async _coverageBatch(items) {
        const out = new Map();
        if (!items.length) return out;
        try {
            const cache = await caches.open(this.AUDIO_CACHE);
            const allUrls = (await cache.keys()).map(r => r.url);
            const urlSet = new Set(allUrls);

            const chunksByPrefix = new Map();
            for (const u of allUrls) {
                const idx = u.indexOf('__chunk=');
                if (idx === -1) continue;
                const prefix = u.substring(0, idx + '__chunk='.length);
                const n = parseInt(u.substring(idx + '__chunk='.length), 10);
                if (isNaN(n)) continue;
                let set = chunksByPrefix.get(prefix);
                if (!set) { set = new Set(); chunksByPrefix.set(prefix, set); }
                set.add(n);
            }

            const ver = this._coverageVersion;
            for (const item of items) {
                const tracks = item.media?.audioFiles || [];
                const coverage = await Promise.all(tracks.map(async (t) => {
                    const key = this.keyFor(ABS.trackUrl(item.id, t.ino));
                    const metaUrl = this.chunkMetaKey(key);
                    if (urlSet.has(metaUrl)) {
                        try {
                            const metaRes = await cache.match(metaUrl);
                            const meta = await metaRes.json();
                            const chunkPrefix = key + (key.includes('?') ? '&' : '?') + '__chunk=';
                            const cached = chunksByPrefix.get(chunkPrefix) || new Set();
                            return { totalSize: meta.totalSize, chunkSize: meta.chunkSize, numChunks: meta.numChunks, cached };
                        } catch { return null; }
                    }
                    if (urlSet.has(key)) return { legacy: true };
                    return null;
                }));
                out.set(this.oid(item), coverage);
                if (this._coverageVersion === ver) {
                    this._coverageCache.set(this.oid(item), { coverage, version: ver });
                }
            }
            return out;
        } catch {
            return out;
        }
    },

    _isFullyDownloadedFromCoverage(item, coverage) {
        const tracks = item.media?.audioFiles || [];
        if (!tracks.length || !coverage) return false;
        for (let i = 0; i < tracks.length; i++) {
            const cov = coverage[i];
            if (!cov) return false;
            if (cov.legacy) continue;
            if (cov.cached.size !== cov.numChunks) return false;
        }
        return true;
    },

    async _computeChunkCoverage(item) {
        const tracks = item.media?.audioFiles || [];
        if (!tracks.length) return [];
        try {
            const cache = await caches.open(this.AUDIO_CACHE);
            const allUrls = (await cache.keys()).map(r => r.url);
            const urlSet = new Set(allUrls);
            const out = [];
            for (const t of tracks) {
                const key = this.keyFor(ABS.trackUrl(item.id, t.ino));
                const metaUrl = this.chunkMetaKey(key);
                if (urlSet.has(metaUrl)) {
                    const metaRes = await cache.match(metaUrl);
                    let meta;
                    try { meta = await metaRes.json(); } catch { out.push(null); continue; }
                    const chunkPrefix = key + (key.includes('?') ? '&' : '?') + '__chunk=';
                    const cached = new Set();
                    for (const u of allUrls) {
                        if (u.startsWith(chunkPrefix)) {
                            const idx = parseInt(u.substring(chunkPrefix.length), 10);
                            if (!isNaN(idx)) cached.add(idx);
                        }
                    }
                    out.push({ totalSize: meta.totalSize, chunkSize: meta.chunkSize, numChunks: meta.numChunks, cached });
                } else if (urlSet.has(key)) {
                    out.push({ legacy: true });
                } else {
                    out.push(null);
                }
            }
            return out;
        } catch {
            return tracks.map(() => null);
        }
    },

    async deleteBook(item) {
        const audioCache = await caches.open(this.AUDIO_CACHE);
        const metaCache = await caches.open(this.META_CACHE);
        for (const url of this.trackUrls(item)) {
            const key = this.keyFor(url);
            // Legacy whole-file entry
            await audioCache.delete(key);
            // Chunked entries: read meta to know how many, delete each
            const metaRes = await audioCache.match(this.chunkMetaKey(key));
            if (metaRes) {
                try {
                    const m = await metaRes.json();
                    for (let i = 0; i < (m.numChunks || 0); i++) {
                        await audioCache.delete(this.chunkKey(key, i));
                    }
                } catch {}
                await audioCache.delete(this.chunkMetaKey(key));
            }
            await audioCache.delete(this.completeKey(key));
        }
        // A show's cover serves every downloaded episode of it: keep it while
        // another one is still here.
        const sharesCover = item.episodeId
            && (await this.listDownloaded()).some(i => i.id === item.id && this.oid(i) !== this.oid(item));
        if (!sharesCover) await audioCache.delete(this.keyFor(ABS.coverUrl(item.id)));
        await metaCache.delete(this.metaKey(this.oid(item)));
        this._coverageCache.delete(this.oid(item));
        this._invalidateCoverage();
        this.notifySwCacheChanged();
    },

    async bookSize(item) {
        try {
            const cache = await caches.open(this.AUDIO_CACHE);
            const coverage = await this.chunkCoverage(item);
            const tracks = item.media?.audioFiles || [];
            let total = 0;
            for (let i = 0; i < tracks.length; i++) {
                const cov = coverage[i];
                if (!cov) continue;
                if (cov.legacy) {
                    // Whole-file (legacy): trust content-length only. NEVER
                    // load the body — multi-hundred-MB arrayBuffer OOMs iOS PWA.
                    const key = this.keyFor(ABS.trackUrl(item.id, tracks[i].ino));
                    const res = await cache.match(key);
                    const len = res?.headers.get('content-length');
                    if (len) total += parseInt(len, 10);
                    continue;
                }
                // Chunked: count only the chunks actually present, not totalSize
                // from meta (which describes the full file even when we only
                // hold a sliding window of it).
                const fullChunks = Math.max(0, cov.numChunks - 1);
                const lastIdx = cov.numChunks - 1;
                for (const idx of cov.cached) {
                    if (idx === lastIdx) {
                        total += cov.totalSize - lastIdx * cov.chunkSize;
                    } else if (idx >= 0 && idx < fullChunks) {
                        total += cov.chunkSize;
                    }
                }
            }
            // Cover (small, always whole-file)
            const coverKey = this.keyFor(ABS.coverUrl(item.id));
            const coverRes = await cache.match(coverKey);
            const coverLen = coverRes?.headers.get('content-length');
            if (coverLen) total += parseInt(coverLen, 10);
            return total;
        } catch { return 0; }
    },

    async downloadedIds() {
        try {
            const cache = await caches.open(this.META_CACHE);
            const keys = await cache.keys();
            return new Set(keys.map(req => req.url.split('/').pop()));
        } catch { return new Set(); }
    },

    // IDs of books where every audio file is fully cached (every chunk present
    // for chunked entries, or the whole-file legacy entry exists). Uses the
    // batch coverage walk to avoid per-book cache.keys() scans.
    // "Which books are fully downloaded" is asked on every tab paint (the
    // green dots) and by the home render, and each answer used to re-read
    // and JSON-parse every downloaded item's record plus list every audio
    // cache key — about a second on an iPhone, which is how long the dots
    // lagged behind a tab switch and most of the launch's fresh-shelves
    // delay (2026-09-20). Memoised on the coverage version (bumped by
    // every page-side chunk write/delete) with a short TTL as a backstop
    // for writes the page doesn't see. A dot a minute late is harmless.
    _fullyMemo: null,
    _fullyLast: null,   // last completed scan this page load, current or not
    FULLY_MEMO_TTL_MS: 60000,
    async _fullyScan() {
        const ver = this._coverageVersion;
        const m = this._fullyMemo;
        if (m && m.version === ver && Date.now() - m.ts < this.FULLY_MEMO_TTL_MS) return m;
        if (m?.pending) return m.pending;
        const pending = (async () => {
            const items = await this.listDownloaded();
            const ids = new Set();
            let full = [];
            if (items.length) {
                const coverages = await this._coverageBatch(items);
                full = items.filter(item => this._isFullyDownloadedFromCoverage(item, coverages.get(this.oid(item))));
                for (const item of full) ids.add(this.oid(item));
            }
            const out = { version: ver, ts: Date.now(), items: full, ids };
            this._fullyLast = out;
            if (this._coverageVersion === ver) this._fullyMemo = out;
            else this._fullyMemo = null;
            return out;
        })();
        this._fullyMemo = { version: -1, ts: 0, items: [], ids: new Set(), pending };
        try { return await pending; } catch { this._fullyMemo = null; throw new Error('scan failed'); }
    },
    async fullyDownloadedIds() {
        try { return (await this._fullyScan()).ids; } catch { return new Set(); }
    },

    async fullyDownloaded() {
        try { return (await this._fullyScan()).items; } catch { return []; }
    },

    // What the last completed scan said, without waiting for one. null
    // until a scan has finished in this page load; sameVersion is false
    // when a chunk has been written or deleted since (the answer may be
    // missing a book).
    fullyDownloadedKnown() {
        const m = this._fullyLast;
        if (!m) return null;
        return { items: m.items, sameVersion: m.version === this._coverageVersion };
    },

    // Drops meta entries (and the cover) for books where no audio is cached.
    // Cleans up after SW activate purges of legacy oversized entries — those
    // leave the metadata behind, which then shows up as a 0-byte phantom in
    // the settings list.
    // Drop meta entries (and the cover) for books where no audio chunk is
    // cached anymore. Partial caches (sliding-window in progress, or after
    // window-eviction) are valid and preserved — only fully-orphaned metadata
    // is cleaned up.
    async cleanupPhantoms() {
        try {
            const metaCache = await caches.open(this.META_CACHE);
            const audioCache = await caches.open(this.AUDIO_CACHE);
            const allUrls = (await audioCache.keys()).map(r => r.url);
            const urlSet = new Set(allUrls);
            const keys = await metaCache.keys();
            const phantoms = [];
            const kept = new Set();
            for (const req of keys) {
                const res = await metaCache.match(req);
                if (!res) continue;
                let item;
                try { item = await res.json(); } catch { await metaCache.delete(req); continue; }
                const tracks = item.media?.audioFiles || [];
                if (!tracks.length) { await metaCache.delete(req); continue; }

                let hasAny = false;
                for (const t of tracks) {
                    const k = this.keyFor(ABS.trackUrl(item.id, t.ino));
                    if (urlSet.has(k)) { hasAny = true; break; }
                    const chunkPrefix = k + (k.includes('?') ? '&' : '?') + '__chunk=';
                    if (allUrls.some(u => u.startsWith(chunkPrefix))) { hasAny = true; break; }
                }

                if (!hasAny) {
                    await metaCache.delete(req);
                    phantoms.push(item);
                    // Also drop any orphan meta/chunk entries (none expected,
                    // but be safe).
                    for (const t of tracks) {
                        const k = this.keyFor(ABS.trackUrl(item.id, t.ino));
                        await audioCache.delete(this.chunkMetaKey(k));
                    }
                } else {
                    kept.add(item.id);
                }
            }
            // Covers last: episodes of one show share it.
            for (const item of phantoms) {
                if (!kept.has(item.id)) await audioCache.delete(this.keyFor(ABS.coverUrl(item.id)));
            }
        } catch {}
    },

    async listDownloaded() {
        try {
            const cache = await caches.open(this.META_CACHE);
            const keys = await cache.keys();
            const items = [];
            for (const req of keys) {
                const res = await cache.match(req);
                if (res) {
                    try { items.push(await res.json()); } catch {}
                }
            }
            return items;
        } catch {
            return [];
        }
    },
};

// Utilities
// Text AND attribute values: it's used inside quoted attributes all over
// (data-show="${esc(title)}", href), so quotes are escaped too, or a podcast
// title or a link in show notes could close the attribute and add its own.
function esc(str) {
    if (!str) return '';
    const d = document.createElement('div'); d.textContent = str;
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

document.addEventListener('DOMContentLoaded', () => App.init());
