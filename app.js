const App = {
    currentLibraryId: null,
    currentMediaType: 'book',
    libraries: [],
    currentTab: 'home',
    navStack: [],

    init() {
        Player.init();
        this.bindEvents();
        this.tryAutoLogin();
        this.setupSwUpdate();
        document.addEventListener('cacheprogress', (e) => this.onCacheProgress(e.detail));
        // Clear phantom downloads (meta entries with no audio) left behind
        // by SW cleanups of legacy oversized cache entries.
        Offline.cleanupPhantoms();
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
        document.getElementById('search-btn').addEventListener('click', () => this.showSearch());

        // Search
        document.getElementById('search-cancel').addEventListener('click', () => this.hideSearch());
        document.getElementById('search-input').addEventListener('input', debounce(e => this.doSearch(e.target.value), 300));

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
                Player.startSleep(val === 'chapter' ? 'chapter' : parseInt(val));
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
        document.getElementById('fs-rewind').addEventListener('click', () => Player.skip(-Player.skipDuration));
        document.getElementById('fs-forward').addEventListener('click', () => Player.skip(Player.skipDuration));
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
                Player.startSleep(val === 'chapter' ? 'chapter' : parseInt(val));
                document.getElementById('fs-sleep-menu').classList.remove('open');
            });
        });
        document.getElementById('fs-sleep-cancel').addEventListener('click', () => {
            Player.clearSleep();
            document.getElementById('fs-sleep-menu').classList.remove('open');
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

    async tryAutoLogin() {
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
                        (serverLink ? `<br><a href="${serverLink}" target="_blank" style="color:var(--accent);font-size:0.85rem">Open server to wake connection</a>` : '') +
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
            await ABS.login(creds.server_url, creds.username, creds.password);
            ABS.saveCredentials(creds.server_url, creds.username, ABS.token);
            this.libraries = await ABS.getLibraries();
            this._offlineMode = false;
            this.setupLibrarySelector();
            this.showMain();
            this.switchTab('home');
        } catch (e) {
            // Pre-fill the manual form with the saved server + username so
            // the user can submit it as a fallback — typical case is
            // Tailscale needing a warmup tap; once the link in the error
            // wakes the connection, the form is ready to submit, and the
            // browser's password autofill (saved against pholia.pages.dev,
            // not the ABS server URL) handles the password field on focus.
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
        // Render as HTML so the Tailscale-warmup link from ABS.login is
        // tappable. Messages are constructed by our own code, never user
        // input.
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
    async _maybeOfferSaveToAccount({ serverUrl, username, password }) {
        if (Account.token()) {
            try { await Account.saveServer({ server_url: serverUrl, username, password }); } catch {}
            return;
        }
        if (!await Account.isPasskeyAvailable()) return;
        this._pendingServerSave = { serverUrl, username, password };
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
        document.getElementById('back-btn').classList.add('hidden');

        switch (tab) {
            case 'home': this.showHome(); break;
            case 'library': this.showLibrary(); break;
            case 'latest': this.showLatest(); break;
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
        }
    },

    setContent(html) { document.getElementById('content').innerHTML = html; },
    showLoading() { this.setContent('<div class="loading">Loading</div>'); },

    // ── Home ──
    async showHome() {
        document.getElementById('header-title').textContent = 'Home';
        this.showLoading();
        if (!this.currentLibraryId) return;

        const downloaded = await Offline.fullyDownloaded();
        const offlineHtml = this.renderOfflineSection(downloaded);

        try {
            const sections = await ABS.request(`/api/libraries/${this.currentLibraryId}/personalized`);
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
                    const title = isEpisode && ep ? ep.title : (meta.title || entity.title || 'Unknown');
                    const subtitle = isEpisode ? (meta.title || '') : (meta.authorName || '');
                    const progress = entity.mediaProgress?.progress || entity.progress?.progress || 0;
                    const episodeId = isEpisode && ep ? ep.id : '';
                    html += `<div class="card" data-id="${itemId}" data-type="${section.type}"${episodeId ? ` data-episode-id="${episodeId}"` : ''}>`;
                    html += `<img src="${ABS.coverUrl(itemId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
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
            if (!html) html = '<div class="loading">No items yet</div>';
            this.setContent(html);
            this.bindCardClicks();
            this.bindOfflineCardClicks(downloaded);
        } catch (e) {
            // If we have downloaded books, still render those so the user can play offline.
            if (offlineHtml) {
                this.setContent(offlineHtml + `<div class="loading">Server unreachable — offline books only</div>`);
                this.bindOfflineCardClicks(downloaded);
            } else {
                this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
            }
        }
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
        this.showLoading();
        try {
            const data = await ABS.getLibraryItems(this.currentLibraryId, 0, 200);
            this.renderGrid(data.results);
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
    },

    // ── Latest (podcasts) ──
    async showLatest() {
        document.getElementById('header-title').textContent = 'Latest';
        this.showLoading();
        try {
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/recent-episodes?limit=50`);
            const episodes = data.episodes || [];
            if (!episodes.length) { this.setContent('<div class="loading">No recent episodes</div>'); return; }
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
            this.setContent(html);
            document.querySelectorAll('.tracklist-item[data-episode-id]').forEach(el => {
                el.addEventListener('click', () => this.playEpisode(el.dataset.itemId, el.dataset.episodeId));
            });
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
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
        this.showLoading();
        try {
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/series?limit=200&sort=name`);
            const series = data.results || [];
            this._seriesCache = {};
            let html = '<div class="list-view">';
            for (const s of series) {
                const books = s.books || [];
                this._seriesCache[s.id] = books;
                const count = books.length || s.numBooks || 0;
                const bookIds = books.slice(0, 4).map(b => (b.libraryItemId || b.id));
                html += `<div class="list-item" data-series-id="${s.id}" data-series-name="${esc(s.name)}">`;
                html += this.renderSeriesMosaic(bookIds);
                html += `<div><div class="list-name">${esc(s.name)}</div><div class="list-count">${count} book${count !== 1 ? 's' : ''}</div></div>`;
                html += '</div>';
            }
            html += '</div>';
            this.setContent(html);
            document.querySelectorAll('.list-item[data-series-id]').forEach(el => {
                el.addEventListener('click', () => this.showSeriesDetail(el.dataset.seriesId, el.dataset.seriesName));
            });
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
    },

    showSeriesDetail(seriesId, seriesName) {
        this.pushNav(seriesName);
        const books = this._seriesCache[seriesId] || [];
        this.renderGrid(books);
    },

    // ── Collections ──
    async showCollections() {
        document.getElementById('header-title').textContent = 'Collections';
        this.showLoading();
        try {
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
            if (!collections.length) html += '<div class="loading">No collections</div>';
            html += '</div>';
            this.setContent(html);
            document.querySelectorAll('.list-item[data-collection-id]').forEach(el => {
                el.addEventListener('click', () => this.showCollectionDetail(el.dataset.collectionId));
            });
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
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
        this.showLoading();
        try {
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
            this.setContent(html);
            document.querySelectorAll('.list-item[data-author-id]').forEach(el => {
                el.addEventListener('click', () => this.showAuthorDetail(el.dataset.authorId, el.dataset.authorName));
            });
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
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
        document.getElementById('search-results').innerHTML = '';
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
                    html += this.gridItemHtml(item.id, meta.title, meta.authorName, 0);
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
            if (!html) html = '<div class="loading">No results</div>';
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

    renderGrid(items) {
        let html = '<div class="grid">';
        for (const item of items) {
            const meta = item.media?.metadata || {};
            const progress = item.mediaProgress?.progress || 0;
            html += this.gridItemHtml(item.id, meta.title, meta.authorName, progress);
        }
        html += '</div>';
        this.setContent(html);
        this.bindCardClicks();
    },

    gridItemHtml(id, title, author, progress) {
        let html = `<div class="grid-item" data-id="${id}">`;
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
            el.addEventListener('click', () => {
                if (el.dataset.episodeId) {
                    this.playEpisode(el.dataset.id, el.dataset.episodeId);
                } else {
                    this.showItem(el.dataset.id);
                }
            });
        });
        document.querySelectorAll('.play-overlay[data-play-id]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const epId = btn.dataset.playEpisode;
                if (epId) this.playEpisode(btn.dataset.playId, epId);
                else this.quickPlay(btn.dataset.playId);
            });
        });
    },

    // Cache-first: if the book is fully downloaded locally, play from the
    // cached META blob (works offline, immune to server-side ino drift after
    // library rescans). Only hits the network when the book isn't cached.
    async quickPlay(itemId) {
        try {
            let item = null;
            const downloadedIds = await Offline.fullyDownloadedIds();
            if (downloadedIds.has(itemId)) {
                const downloaded = await Offline.fullyDownloaded();
                item = downloaded.find(i => i.id === itemId) || null;
            }
            if (!item) item = await ABS.getItem(itemId);
            if (item.mediaType === 'podcast') {
                this.showItem(itemId);
            } else {
                Player.startItem(item);
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
        if (meta.description) html += `<div class="description">${esc(meta.description)}</div>`;
        html += '</div></div>';

        const btnText = currentTime > 0 ? `Resume from ${formatTime(currentTime)}` : 'Play';
        html += `<button class="play-btn-large" id="detail-play">${btnText}</button>`;
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
        document.getElementById('settings-modal').classList.remove('hidden');
        this.renderDownloadsList();
        this.renderAccountSection();
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
                <button id="account-create" type="button">Set up Pholia account with passkey</button>
            `;
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
                this.renderDownloadsList();
            });
        });
        clearBtn.onclick = async () => {
            if (!confirm(`Remove all ${items.length} cached book${items.length === 1 ? '' : 's'}?`)) return;
            list.innerHTML = '<div class="downloads-empty">Clearing…</div>';
            for (const item of items) await Offline.deleteBook(item);
            this.renderDownloadsList();
        };
    },

    // ── Fullscreen player ──
    openFullscreen() {
        if (!Player.item) return;
        document.getElementById('fs-player').classList.remove('hidden');
        document.body.classList.add('fs-open');
        Player.updateUI();
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

    notifySwCacheChanged() {
        try { navigator.serviceWorker?.controller?.postMessage({ type: 'CACHE_CHANGED' }); } catch {}
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
    // cached: Set<int> } for chunked entries. Single cache.keys() walk for
    // efficiency.
    async chunkCoverage(item) {
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
    // for chunked entries, or the whole-file legacy entry exists).
    async fullyDownloadedIds() {
        try {
            const items = await this.listDownloaded();
            const ids = new Set();
            for (const item of items) {
                if (await this.isDownloaded(item)) ids.add(item.id);
            }
            return ids;
        } catch { return new Set(); }
    },

    async fullyDownloaded() {
        const all = await this.listDownloaded();
        const ids = await this.fullyDownloadedIds();
        return all.filter(i => ids.has(i.id));
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
