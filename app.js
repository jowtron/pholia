const App = {
    currentLibraryId: null,
    currentMediaType: 'book',
    libraries: [],
    currentTab: 'home',
    navStack: [],

    init() {
        this.setupCrashLog();
        Player.init();
        this.bindEvents();
        this.applyTabVisibility();
        this._consumePholiaHandoff();
        this.tryAutoLogin();
        this.setupSwUpdate();
        this.setupSwDebugBridge();
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
    _crashLogShipThrottle: 0,

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
    shipCrashLog(reason) {
        const now = performance.now();
        if (reason !== 'prior-session-tail' && now - this._crashLogShipThrottle < 30000) return;
        this._crashLogShipThrottle = now;
        try {
            this._postCrashLog({
                session_id: this._sessionId,
                reason,
                events: this._swLog ? this._swLog.slice() : [],
                audio_state: this._currentAudioState(),
            });
        } catch {}
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

    _postCrashLog(payload) {
        try {
            const body = JSON.stringify({
                ...payload,
                app_version: document.getElementById('build-version')?.textContent || null,
            });
            // Prefer sendBeacon — survives pagehide / app kill.
            if (navigator.sendBeacon) {
                const blob = new Blob([body], { type: 'application/json' });
                if (navigator.sendBeacon('/api/log', blob)) return;
            }
            // Fallback to fetch with keepalive so it can outlive the page.
            fetch('/api/log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            }).catch(() => {});
        } catch {}
    },

    sendSwConfig() {
        // 'pholia_sw_experimental' is the audio debug log; the partial-cache
        // intercept is its own Settings toggle, ON unless switched off.
        const swDebugLog = localStorage.getItem('pholia_sw_experimental') === 'true';
        const experimentalPartialCache = localStorage.getItem('pholia_sw_partial_intercept') !== 'false';
        try {
            navigator.serviceWorker?.controller?.postMessage({
                type: 'SW_CONFIG',
                experimentalPartialCache,
                swDebugLog,
            });
        } catch {}
    },

    _swLog: [],
    _swLogMax: 200,

    // Tell the SW a media load for `url` is about to begin so it pins how it
    // will answer every request for that file (all from the worker, or none):
    // iOS cancels a media load whose CORS status changes between responses.
    // Resolves with the mode, or null if there's no controller / no reply.
    pinMediaMode(url) {
        return new Promise(resolve => {
            const ctrl = navigator.serviceWorker?.controller;
            if (!ctrl) return resolve(null);
            const ch = new MessageChannel();
            const t = setTimeout(() => resolve(null), 500);
            ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data?.mode || null); };
            try { ctrl.postMessage({ type: 'MEDIA_LOAD', url }, [ch.port2]); } catch { clearTimeout(t); resolve(null); }
        });
    },

    setupSwDebugBridge() {
        if (!('serviceWorker' in navigator)) return;
        // Send config now and on every controllerchange (new SW = needs the flag again).
        this.sendSwConfig();
        navigator.serviceWorker.addEventListener('controllerchange', () => this.sendSwConfig());
        // The SW persists its flags, but re-sending on every foreground is
        // cheap insurance for a worker that restarted while we were hidden.
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.sendSwConfig(); });
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

        // Initial poll (covers updates already installed at page load).
        this._pollForUpdate();
        this._checkBuildVersion();

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
        document.getElementById('search-btn').addEventListener('click', () => this.showSearch());
        document.getElementById('abb-btn').addEventListener('click', () => this.toggleAdd());
        document.getElementById('content').addEventListener('scroll', (e) => {
            if (e.target.classList?.contains('h-scroll')) this._markShelves(e.target);
        }, true);
        window.addEventListener('resize', () => this._markShelves());

        // Search
        document.getElementById('search-cancel').addEventListener('click', () => this.hideSearch());
        document.getElementById('search-input').addEventListener('input', debounce(e => this.doSearch(e.target.value), 300));
        this._wireSearchClear(document.getElementById('search-input'), document.getElementById('search-clear'), () => this.doSearch(''));

        // Settings
        document.getElementById('settings-close').addEventListener('click', () => this.hideSettings());
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
        document.getElementById('setting-partial-cache').addEventListener('change', e => {
            localStorage.setItem('pholia_sw_partial_intercept', e.target.checked ? 'true' : 'false');
            this.sendSwConfig();
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
            // Manual sends bypass the throttle so a user can ship twice in a row.
            this._crashLogShipThrottle = 0;
            this.shipCrashLog('manual');
            btn.textContent = 'Sent';
            setTimeout(() => { btn.textContent = orig; }, 2000);
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

        // FS chapters
        document.getElementById('fs-toggle-chapters').addEventListener('click', () => {
            const el = document.getElementById('fs-chapter-list');
            el.classList.toggle('hidden');
            if (!el.classList.contains('hidden')) this.renderFsChapters();
        });

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
            }
        });
        window.addEventListener('online', () => {
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
            try {
                this.libraries = await ABS.getLibraries();
                this._offlineMode = false;
                this.setupLibrarySelector();
                this.showMain();
                this.switchTab('home');
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
                } else {
                    // Network error or server down — keep credentials, show main UI
                    this._offlineMode = true;
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
            this.libraries = await ABS.getLibraries();
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
        if (!item || Player.isPlaying) return;
        let progress;
        try { progress = await ABS.getProgress(item.id); } catch { return; }
        if (!progress) return;
        const serverTime = progress.currentTime || 0;
        // Only reseat the player if the server's time is meaningfully ahead
        // — the forward-only guard. Going backwards is almost always stale
        // data clobbering newer state. 5 s slack covers normal sync jitter.
        if (Player.item?.id === item.id) {
            const localTime = Player.getGlobalTime();
            if (serverTime > localTime + 5) Player.loadTime(serverTime);
        }
        // Re-render the detail view so the resume time / chapter highlight /
        // % complete reflect the new progress.
        if (this._currentDetailItem?.id === item.id && document.querySelector('.detail-view')) {
            this.showBookDetail(item);
        }
    },

    async retryConnect() {
        this.setContent('<div class="loading">Connecting...</div>');
        try {
            this.libraries = await ABS.getLibraries();
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
            await ABS.login(serverUrl, username, password);
            ABS.saveCredentials(serverUrl, username, ABS.token);
            this.libraries = await ABS.getLibraries();
            this.setupLibrarySelector();
            this.showMain();
            this.switchTab('home');
            // Defer the save-prompt slightly so the main UI is visible behind it.
            setTimeout(() => this._maybeOfferSaveToAccount({ serverUrl, username, password }), 400);
        } catch (e) {
            errorEl.innerHTML = e.message;
        }
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
    },

    logout() {
        Player.pause();
        Player.closeCurrentSession();
        const savedServer = localStorage.getItem('pholia_server');
        const savedUser = localStorage.getItem('pholia_username');
        ABS.clearCredentials();
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
    isShim: false,     // server answers /api/admin/abb/settings → ABS_shim (enables delete-from-pCloud)
    abbFolderId: null,
    abbLibraryId: null,
    _abbRoot: null,

    async checkAbbSupport() {
        const btn = document.getElementById('abb-btn');
        let ok = false;
        try {
            const s = await ABS.request('/api/admin/abb/settings');
            this.isShim = !!s;
            if (s && s.rdTokenSet) {
                const st = await ABS.request('/api/admin/storage/status');
                const folders = (st?.folders || []).filter(f => f.provider === 'pcloud_oauth');
                const mine = folders.find(f => f.libraryId === this.currentLibraryId) || folders[0];
                if (mine) { ok = true; this.abbFolderId = mine.id; this.abbLibraryId = mine.libraryId; }
            }
        } catch { this.isShim = false; /* not a shim, or no access */ }
        this.abbAvailable = ok;
        btn.classList.toggle('hidden', !ok);
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
        if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
        return data;
    },

    showAdd() {
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
                    if (ok) { this._tabCache = {}; }  // library/home tabs re-fetch to show the new book
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
                    try { const a = await this._shimCall('/api/admin/abb/torrents', { method: 'POST', body: JSON.stringify({ magnet, fileId: f.id }) }); byFile.set(f.id, a.id); }
                    catch (e) { this._abbRow(listEl, f.path, '').fail('Add failed: ' + e.message); }
                }
            }
            const san = s => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'audiobook';
            const plan = this.abbPlanDest(san(g.filename), chosen.filter(f => byFile.has(f.id)));
            const byTorrent = new Map();
            for (const p of plan) { const tid = byFile.get(p.id); if (!byTorrent.has(tid)) byTorrent.set(tid, p.dest); }
            const torrents = [...byTorrent].map(([id, dest]) => ({ id, dest }));
            if (!torrents.length) throw new Error('Nothing to track');
            row.setStatus(`${torrents.length} torrent(s) — waiting for Real-Debrid`);
            await this.abbTrackTorrents(torrents, this.abbFolderId, listEl, row);
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
                this._tabCache = {};
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
            const plan = this.abbPlanDest(m.folderName, chosen);
            row.setStatus(`Adding ${plan.length} torrent(s) to Real-Debrid…`);
            const add = (fileId) => this._shimCall('/api/admin/abb/torrents', { method: 'POST', body: JSON.stringify({ magnet: m.magnet, fileId }) });
            // Two adds at a time (each is ~10 RD API calls; four in parallel drew a
            // 429 on 2026-09-02). A failed add gets a Retry that re-adds just that
            // file and tracks it to the library on its own.
            const torrents = [];
            const retryAdd = (p) => {
                const r = this._abbRow(listEl, p.dest, '');
                const retry = () => {
                    r.setStatus('Adding to Real-Debrid…');
                    add(p.id)
                        .then((a) => { removeBtn(); return this.abbTrackTorrents([{ id: a.id, dest: p.dest }], folderId, listEl, r); })
                        .then((ok) => { this.abbLoadRdList(); if (ok) this._tabCache = {}; })
                        .catch((e) => r.fail('Add failed: ' + e.message));
                };
                let removeBtn = r.addButton('Retry', retry);
                return r;
            };
            for (let i = 0; i < plan.length; i += 2) {
                const added = await Promise.all(plan.slice(i, i + 2).map(p => add(p.id).then(a => ({ ...a, dest: p.dest, plan: p })).catch(e => ({ error: e.message, dest: p.dest, plan: p }))));
                for (const a of added) {
                    if (a.error) retryAdd(a.plan).fail('Add failed: ' + a.error);
                    else torrents.push({ id: a.id, dest: a.dest });
                }
                row.setStatus(`Added ${torrents.length} / ${plan.length} torrent(s)…`);
            }
            if (!torrents.length) throw new Error('Nothing could be added to Real-Debrid');
            row.setStatus(`${torrents.length} torrent(s) — waiting for Real-Debrid`);
            return await this.abbTrackTorrents(torrents, folderId, listEl, row);
        } catch (e) {
            row.fail(e.message || String(e));
            return false;
        }
    },

    // Shared tail of a grab (also used to resume a torrent this tab didn't
    // start): poll, hand finished files to pCloud, delete on RD, scan.
    async abbTrackTorrents(torrents, folderId, listEl, row) {
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
                                const registered = await this.abbFetchToPcloud(folderId, d.download, p.dest, listEl);
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
    async abbFetchToPcloud(folderId, url, relPath, listEl) {
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
                started = await this._shimCall(base + '/start', { method: 'POST', body: JSON.stringify({ url, relPath }) });
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
    checkForSwUpdate() {
        if (!('serviceWorker' in navigator)) return;
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
        this.currentTab = tab;
        this.navStack = [];
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.getElementById('abb-btn').classList.toggle('active', tab === 'add');
        document.getElementById('back-btn').classList.add('hidden');

        switch (tab) {
            case 'home': this.showHome(); break;
            case 'library': this.showLibrary(); break;
            case 'latest': this.showLatest(); break;
            case 'add': this.showAdd(); break;
            case 'series': this.showSeries(); break;
            case 'collections': this.showCollections(); break;
            case 'authors': this.showAuthors(); break;
        }
    },

    pushNav(title) {
        this.checkForSwUpdate();
        this.navStack.push(title);
        document.getElementById('header-title').textContent = title;
        document.getElementById('back-btn').classList.toggle('hidden', this.navStack.length <= 1);
    },

    goBack() {
        if (this.navStack.length > 1) {
            this.navStack.pop();
            this.switchTab(this.currentTab);
        } else if (this.currentTab === 'add') {
            this.switchTab(this._addReturnTab);
        }
    },

    setContent(html) {
        document.getElementById('content').innerHTML = html;
        this._markShelves();
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
        if (!tab) { this._tabCache = {}; return; }
        for (const k of Object.keys(this._tabCache)) {
            if (k.startsWith(tab + '|')) delete this._tabCache[k];
        }
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
        this.showLoading();
        try {
            const out = this._normalizeProduce(await produce());
            this._tabCache[key] = { ...out, ts: Date.now() };
            if (this._tabStillActive(key)) {
                this.setContent(out.html);
                bind?.(out.bindData);
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
            if (this._tabStillActive(key) && prev !== out.html) {
                this.setContent(out.html);
                bind?.(out.bindData);
            }
        } catch { /* keep cached render on background failure */ }
        finally { this._tabRevalidating[key] = false; }
    },

    _normalizeProduce(v) {
        return typeof v === 'string' ? { html: v, bindData: undefined } : v;
    },

    async showHome() {
        document.getElementById('header-title').textContent = 'Home';
        if (!this.currentLibraryId) { this.showLoading(); return; }
        const targetLib = this.currentLibraryId;
        return this._renderTab('home', async () => {
            // Kick off /personalized in parallel with the offline-cache scan —
            // they're independent and the scan used to dominate cold-open time.
            const personalizedP = ABS.request(`/api/libraries/${targetLib}/personalized`);
            const downloadedItems = await Offline.fullyDownloaded();
            const offlineHtml = this.renderOfflineSection(downloadedItems);
            const sections = await personalizedP;
            if (targetLib !== this.currentLibraryId) throw new Error('library switched');
            let html = offlineHtml;
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
                        subtitle = meta.authorName || '';
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
                    if (section.type === 'book') html += this._seqBadge(meta);
                    if (coverSrc) {
                        html += `<img src="${coverSrc}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
                    }
                    html += `<button class="play-overlay" data-play-id="${itemId}"${episodeId ? ` data-play-episode="${episodeId}"` : ''}>\u25B6</button>`;
                    html += `<div class="card-title">${esc(title)}</div>`;
                    html += `<div class="card-sub">${esc(subtitle)}</div>`;
                    if (progress > 0) {
                        html += `<div class="card-progress"><div class="card-progress-fill" style="width:${progress*100}%"></div></div>`;
                    }
                    html += '</div>';
                }
                html += '</div>';
            }
            if (!html) html = '<div class="empty-state">No items yet</div>';
            return { html, bindData: downloadedItems };
        }, (downloadedItems) => {
            this.bindCardClicks();
            this.bindOfflineCardClicks(downloadedItems || []);
        });
    },

    renderOfflineSection(items) {
        if (!items.length) return '';
        let html = `<div class="section-title">Downloaded</div><div class="h-scroll">`;
        for (const item of items) {
            const meta = item.media?.metadata || {};
            const title = meta.title || 'Unknown';
            const subtitle = meta.authorName || '';
            html += `<div class="card offline-card" data-offline-id="${item.id}">`;
            html += `<img src="${ABS.coverUrl(item.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
            html += `<button class="play-overlay" data-offline-play="${item.id}">▶</button>`;
            html += `<div class="card-title">${esc(title)}</div>`;
            html += `<div class="card-sub">${esc(subtitle)}</div>`;
            html += '</div>';
        }
        html += '</div>';
        return html;
    },

    bindOfflineCardClicks(items) {
        const byId = Object.fromEntries(items.map(i => [i.id, i]));
        document.querySelectorAll('.offline-card[data-offline-id]').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.play-overlay')) return;
                const item = byId[el.dataset.offlineId];
                if (item) this.showBookDetail(item);
            });
        });
        // Funnel through quickPlay so the cache-first lookup is consistent
        // with Continue Listening — both end up using the cached META.
        document.querySelectorAll('.play-overlay[data-offline-play]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.quickPlay(btn.dataset.offlinePlay);
            });
        });
    },

    // ── Library ──
    async showLibrary() {
        document.getElementById('header-title').textContent = 'Library';
        return this._renderTab('library', async () => {
            const data = await ABS.getLibraryItems(this.currentLibraryId, 0, 200);
            return this.gridHtml(data.results);
        }, () => this.bindCardClicks());
    },

    // ── Latest (podcasts) ──
    async showLatest() {
        document.getElementById('header-title').textContent = 'Latest';
        return this._renderTab('latest', async () => {
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/recent-episodes?limit=50`);
            const episodes = data.episodes || [];
            if (!episodes.length) return '<div class="empty-state">No recent episodes</div>';
            let html = '<ul class="tracklist">';
            for (const ep of episodes) {
                const title = ep.title || 'Unknown Episode';
                const podcastTitle = ep.podcast?.metadata?.title || '';
                const dur = ep.duration || 0;
                const pubDate = ep.publishedAt ? new Date(ep.publishedAt).toLocaleDateString() : '';
                html += `<li class="tracklist-item" data-item-id="${ep.libraryItemId}" data-episode-id="${ep.id}">`;
                html += `<div class="tracklist-progress" style="width:0%"></div>`;
                html += `<button class="tracklist-play">`;
                html += `<img class="ep-cover" src="${ABS.coverUrl(ep.libraryItemId)}" alt="" onerror="this.style.visibility='hidden'">`;
                html += `<span class="tracklist-title"><strong>${esc(title)}</strong><br><span class="text-muted">${esc(podcastTitle)} &bull; ${pubDate}</span></span>`;
                html += `<span class="tracklist-duration">${formatTime(dur)}</span>`;
                html += '</button></li>';
            }
            html += '</ul>';
            return html;
        }, () => {
            document.querySelectorAll('.tracklist-item[data-episode-id]').forEach(el => {
                el.addEventListener('click', () => this.playEpisode(el.dataset.itemId, el.dataset.episodeId));
            });
        });
    },

    async playEpisode(itemId, episodeId) {
        try {
            const item = await ABS.getItem(itemId);
            const episode = item.media?.episodes?.find(e => e.id === episodeId);
            if (!episode) { console.warn('Episode not found'); return; }
            // Build a pseudo-item for the player with episode data
            const pseudoItem = {
                id: itemId,
                episodeId: episodeId,
                media: {
                    metadata: {
                        title: episode.title,
                        authorName: item.media?.metadata?.title || '',
                    },
                    duration: episode.duration,
                    chapters: episode.chapters || [],
                    audioFiles: [],
                },
            };
            if (Player.session) await Player.closeCurrentSession();
            // Mirror startItem's teardown: kill any auto-cache loop still
            // running against the previous book (its sliding-window math would
            // otherwise track the podcast's timeline) and reset recovery state.
            if (Player._autoCacheController) { Player._autoCacheController.abort(); Player._autoCacheController = null; }
            Player._audioRecoveryAttempts = 0;
            Player._prewarmedFromTrackIndex = -1;
            Player.item = pseudoItem;
            Player.chapters = episode.chapters || [];
            Player.tracks = [];
            try {
                Player.session = await ABS.startSession(itemId, episodeId);
            } catch (e) {
                console.warn('Could not start session', e);
                Player.session = null;
            }
            const startTime = Player.session?.currentTime || 0;
            Player.loadTime(startTime);
            Player.startSync();
            Player.updateMediaSession();
            Player.updateUI();
            document.getElementById('player-bar').classList.remove('hidden');
            document.getElementById('main-screen').classList.add('player-active');
        } catch (e) {
            console.error('Play episode failed', e);
        }
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

    showSeriesDetail(seriesId, seriesName) {
        this.pushNav(seriesName);
        const books = this._seriesCache[seriesId] || [];
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
        this.showLoading();
        try {
            const data = await ABS.request(`/api/collections/${collectionId}`);
            this.pushNav(data.name || 'Collection');
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
                    html += `<img src="${ABS.serverUrl}/api/authors/${a.id}/image?token=${ABS.token}&width=96" alt="">`;
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
        this.pushNav(authorName);
        this.showLoading();
        try {
            const data = await ABS.request(`/api/authors/${authorId}?include=items`);
            const books = data.libraryItems || [];
            this.renderGrid(books);
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
    },

    // ── Search ──
    showSearch() {
        document.getElementById('search-overlay').classList.remove('hidden');
        document.getElementById('search-input').focus();
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

    async doSearch(query) {
        const resultsEl = document.getElementById('search-results');
        if (!query || query.length < 2) { resultsEl.innerHTML = ''; return; }
        try {
            const data = await ABS.searchLibrary(this.currentLibraryId, query);
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
            if (!html) html = '<div class="empty-state">No results</div>';
            resultsEl.innerHTML = html;
            this.bindSearchClicks(resultsEl);
        } catch (e) {
            resultsEl.innerHTML = `<div class="loading">Error: ${esc(e.message)}</div>`;
        }
    },

    bindSearchClicks(container) {
        container.querySelectorAll('.grid-item').forEach(el => {
            el.addEventListener('click', () => { this.hideSearch(); this.showItem(el.dataset.id); });
        });
        container.querySelectorAll('.play-overlay').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideSearch();
                this.quickPlay(btn.dataset.playId);
            });
        });
        container.querySelectorAll('.list-item[data-author-id]').forEach(el => {
            el.addEventListener('click', () => { this.hideSearch(); this.showAuthorDetail(el.dataset.authorId, el.dataset.authorName); });
        });
        container.querySelectorAll('.list-item[data-series-id]').forEach(el => {
            el.addEventListener('click', () => { this.hideSearch(); this.showSeriesDetail(el.dataset.seriesId, el.dataset.seriesName); });
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
            html += this.gridItemHtml(item.id, meta.title, meta.authorName, progress, meta);
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
        html += this._seqBadge(meta);
        html += `<img src="${ABS.coverUrl(id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
        html += `<button class="play-overlay" data-play-id="${id}">\u25B6</button>`;
        if (progress > 0) {
            html += `<div class="item-progress"><div class="item-progress-fill" style="width:${progress*100}%"></div></div>`;
        }
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
            if (this.isShim && !el.dataset.episodeId && type !== 'series' && type !== 'authors') {
                this._wireLongPress(el, () => this.confirmDeleteItem(el.dataset.id, el.dataset.title || el.querySelector('.card-title, .item-title')?.textContent || 'this book'));
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
                    this.quickPlay(el.dataset.id, true);
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

    // Cache-first: if the book is fully downloaded locally, play from the
    // cached META blob (works offline, immune to server-side ino drift after
    // library rescans). Only hits the network when the book isn't cached.
    async quickPlay(itemId, openPlayer = false) {
        const t0 = Date.now();
        Player._logMark('tap', 0);
        try {
            let item = null;
            // Resume taps come from book tiles, so the /play session can be
            // opened right away instead of after the item fetch.
            const sessionP = openPlayer ? ABS.startSession(itemId) : null;
            // The offline-cache scan and the item fetch don't depend on each
            // other: run both, prefer the cached copy if the book is fully
            // downloaded. Waiting for the scan first put its full cost in
            // front of every tap.
            const netP = ABS.getItem(itemId).catch(() => null);
            const downloadedIds = await Offline.fullyDownloadedIds();
            Player._logMark('cache-scan', Date.now() - t0);
            if (downloadedIds.has(itemId)) {
                const downloaded = await Offline.fullyDownloaded();
                item = downloaded.find(i => i.id === itemId) || null;
            }
            if (!item) item = await netP;
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
        this.pushNav('Loading...');
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
        return parts.filter(Boolean).join(' · ');
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

        this.navStack[this.navStack.length - 1] = meta.title || 'Unknown';
        document.getElementById('header-title').textContent = meta.title || 'Unknown';

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
        if (this.isShim) html += `<button class="text-btn detail-delete-btn" id="detail-delete">Delete from pCloud…</button>`;
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

    showPodcastDetail(item) {
        const meta = item.media?.metadata || {};
        const episodes = (item.media?.episodes || []).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

        this.navStack[this.navStack.length - 1] = meta.title || 'Unknown';
        document.getElementById('header-title').textContent = meta.title || 'Unknown';

        let html = '<div class="detail-view">';
        html += '<div class="detail-header">';
        html += `<img class="detail-cover" src="${ABS.coverUrl(item.id)}" alt="" onerror="this.style.visibility='hidden'">`;
        html += '<div class="detail-meta">';
        html += `<h3>${esc(meta.title || 'Unknown')}</h3>`;
        if (meta.author) html += `<div class="author">${esc(meta.author)}</div>`;
        html += `<div class="duration">${episodes.length} episode${episodes.length !== 1 ? 's' : ''}</div>`;
        if (meta.description) html += `<div class="description">${esc(meta.description)}</div>`;
        html += '</div></div>';

        if (episodes.length) {
            html += '<div class="section-title">Episodes</div><ul class="tracklist">';
            for (const ep of episodes) {
                const dur = ep.duration || 0;
                const pubDate = ep.publishedAt ? new Date(ep.publishedAt).toLocaleDateString() : '';
                html += `<li class="tracklist-item" data-item-id="${item.id}" data-episode-id="${ep.id}">`;
                html += `<div class="tracklist-progress" style="width:0%"></div>`;
                html += `<button class="tracklist-play">`;
                html += `<span class="tracklist-title">${esc(ep.title || 'Unknown')}<br><span class="text-muted">${pubDate}</span></span>`;
                html += `<span class="tracklist-duration">${formatTime(dur)}</span>`;
                html += '</button></li>';
            }
            html += '</ul>';
        }
        html += '</div>';
        this.setContent(html);

        document.querySelectorAll('.tracklist-item[data-episode-id]').forEach(el => {
            el.addEventListener('click', () => this.playEpisode(el.dataset.itemId, el.dataset.episodeId));
        });
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
        document.getElementById('setting-hide-collections').checked = localStorage.getItem('pholia_hide_collections') === 'true';
        document.getElementById('setting-partial-cache').checked = localStorage.getItem('pholia_sw_partial_intercept') !== 'false';
        const swExp = localStorage.getItem('pholia_sw_experimental') === 'true';
        document.getElementById('setting-sw-experimental').checked = swExp;
        document.getElementById('sw-log-section').classList.toggle('hidden', !swExp);
        // Rescan lives here for shim servers only (real ABS has its own UI).
        document.getElementById('shim-section').classList.toggle('hidden', !this.isShim);
        if (!this._shimRescanWired) {
            this._shimRescanWired = true;
            document.getElementById('shim-rescan').addEventListener('click', () => this.shimRescan());
        }
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
            if (r.added) this._tabCache = {};
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
            html += `<div class="downloads-row" data-id="${item.id}">`;
            html += `<div class="downloads-info">`;
            html += `<div class="downloads-title">${esc(title)}</div>`;
            html += `<div class="downloads-sub">${esc(author)} • ${formatBytes(sizes[i])}</div>`;
            html += `</div>`;
            html += `<button class="text-btn downloads-remove" data-id="${item.id}">Remove</button>`;
            html += `</div>`;
        });
        list.innerHTML = html;
        list.querySelectorAll('.downloads-remove').forEach(btn => {
            btn.addEventListener('click', async () => {
                const item = items.find(i => i.id === btn.dataset.id);
                if (!item) return;
                btn.disabled = true; btn.textContent = 'Removing…';
                await Offline.deleteBook(item);
                this._invalidateHomeCache();
                this.renderDownloadsList();
            });
        });
        clearBtn.onclick = async () => {
            if (!confirm(`Remove all ${items.length} cached book${items.length === 1 ? '' : 's'}?`)) return;
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
        const desc = Player.item?.media?.metadata?.description?.trim();
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
        document.getElementById('fs-player').classList.add('hidden');
        document.body.classList.remove('fs-open');
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
        const metaCache = await caches.open(this.META_CACHE);
        await metaCache.put(
            this.metaKey(item.id),
            new Response(JSON.stringify(item), { headers: { 'Content-Type': 'application/json' } })
        );
    },

    // Returns per-track coverage info needed to render chapter cache state.
    // For each audioFile: null (nothing cached), { legacy: true } (whole-file
    // cache, treat as fully covered), or { totalSize, chunkSize, numChunks,
    // cached: Set<int> } for chunked entries. Memoized — see _coverageCache.
    async chunkCoverage(item) {
        const ver = this._coverageVersion;
        const hit = this._coverageCache.get(item.id);
        if (hit && hit.version === ver) return hit.coverage;
        const coverage = await this._computeChunkCoverage(item);
        // Only commit if the version hasn't moved underneath us during the
        // async walk (another chunk wrote mid-compute → next caller rebuilds).
        if (this._coverageVersion === ver) {
            this._coverageCache.set(item.id, { coverage, version: ver });
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
                out.set(item.id, coverage);
                if (this._coverageVersion === ver) {
                    this._coverageCache.set(item.id, { coverage, version: ver });
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
        await audioCache.delete(this.keyFor(ABS.coverUrl(item.id)));
        await metaCache.delete(this.metaKey(item.id));
        this._coverageCache.delete(item.id);
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
    async fullyDownloadedIds() {
        try {
            const items = await this.listDownloaded();
            if (!items.length) return new Set();
            const coverages = await this._coverageBatch(items);
            const ids = new Set();
            for (const item of items) {
                if (this._isFullyDownloadedFromCoverage(item, coverages.get(item.id))) ids.add(item.id);
            }
            return ids;
        } catch { return new Set(); }
    },

    async fullyDownloaded() {
        const all = await this.listDownloaded();
        if (!all.length) return [];
        const coverages = await this._coverageBatch(all);
        return all.filter(item => this._isFullyDownloadedFromCoverage(item, coverages.get(item.id)));
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
                    await audioCache.delete(this.keyFor(ABS.coverUrl(item.id)));
                    // Also drop any orphan meta/chunk entries (none expected,
                    // but be safe).
                    for (const t of tracks) {
                        const k = this.keyFor(ABS.trackUrl(item.id, t.ino));
                        await audioCache.delete(this.chunkMetaKey(k));
                    }
                }
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
function esc(str) {
    if (!str) return '';
    const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
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
