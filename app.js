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

    // Awaits update() then polls reg.waiting. updatefound/statechange events
    // aren't fired reliably for in-session update() calls on iOS PWA, so we
    // also check the registration directly.
    async _pollForUpdate() {
        if (!('serviceWorker' in navigator)) return;
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return;
        try { await reg.update(); } catch {}
        if (reg.waiting) this._showUpdateBanner(reg);
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

        // Reload when new SW takes control. Skip the first-install case so we
        // don't blow away in-memory state.
        const hadController = !!navigator.serviceWorker.controller;
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (hadController && !refreshing) { refreshing = true; window.location.reload(); }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this._pollForUpdate();
        });
    },

    bindEvents() {
        // Login
        document.getElementById('login-form').addEventListener('submit', e => {
            e.preventDefault(); this.handleLogin();
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
        document.getElementById('logout-btn').addEventListener('click', () => this.logout());
        document.getElementById('setting-speed').addEventListener('change', e => Player.setSpeed(parseFloat(e.target.value)));
        document.getElementById('setting-skip').addEventListener('change', e => Player.setSkipDuration(parseInt(e.target.value)));
        document.getElementById('setting-theme').addEventListener('change', e => {
            document.documentElement.setAttribute('data-theme', e.target.value);
            localStorage.setItem('cadence_theme', e.target.value);
        });
        document.getElementById('setting-auto-cache').addEventListener('change', e => {
            localStorage.setItem('cadence_auto_cache', e.target.checked ? 'true' : 'false');
            if (e.target.checked && Player.item) Player._startAutoCache();
            else if (!e.target.checked && Player._autoCacheController) {
                Player._autoCacheController.abort();
                Player._autoCacheController = null;
            }
        });
        // Apply saved theme
        const savedTheme = localStorage.getItem('cadence_theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);

        // Library selector
        document.getElementById('library-select').addEventListener('change', e => {
            this.currentLibraryId = e.target.value;
            localStorage.setItem('cadence_library', this.currentLibraryId);
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
            if (ch) {
                const chDur = ch.end - ch.start;
                const t = (fsSeek.value / 100) * chDur;
                document.getElementById('fs-elapsed').textContent = formatTime(t);
            }
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
        const savedServer = localStorage.getItem('cadence_server');
        const savedUser = localStorage.getItem('cadence_username');
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
            } catch (e) {
                if (e.status === 401 || e.status === 403) {
                    // Token is expired or invalid — clear credentials
                    ABS.token = '';
                    localStorage.removeItem('cadence_token');
                } else {
                    // Network error or server down — keep credentials, show main UI
                    this._offlineMode = true;
                    this.showMain();
                    const serverLink = ABS.serverUrl || localStorage.getItem('cadence_server') || '';
                    this.setContent(
                        '<div class="loading">' +
                        'Could not reach server. Your session is saved.' +
                        (serverLink ? `<br><a href="${serverLink}" target="_blank" style="color:var(--accent);font-size:0.85rem">Open server to wake connection</a>` : '') +
                        '<br><button id="retry-connect" class="text-btn" style="margin-top:1rem;font-size:1rem">Retry</button>' +
                        '</div>'
                    );
                    document.getElementById('retry-connect')?.addEventListener('click', () => this.retryConnect());
                }
            }
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
                localStorage.removeItem('cadence_token');
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
        } catch (e) {
            errorEl.innerHTML = e.message;
        }
    },

    showMain() {
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('main-screen').classList.add('active');
    },

    logout() {
        Player.pause();
        Player.closeCurrentSession();
        const savedServer = localStorage.getItem('cadence_server');
        const savedUser = localStorage.getItem('cadence_username');
        ABS.clearCredentials();
        this.hideSettings();
        document.getElementById('main-screen').classList.remove('active');
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('login-form').reset();
        if (savedServer) document.getElementById('server-url').value = savedServer;
        if (savedUser) document.getElementById('username').value = savedUser;
        this.navStack = [];
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
        const saved = localStorage.getItem('cadence_library');
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
        document.querySelectorAll('.play-overlay[data-offline-play]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = byId[btn.dataset.offlinePlay];
                if (item) Player.startItem(item);
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

    async quickPlay(itemId) {
        try {
            const item = await ABS.getItem(itemId);
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
        const mask = await Offline.cachedTracksMask(item);
        if (!mask.some(Boolean)) return;
        const ranges = [];
        let elapsed = 0;
        for (let i = 0; i < audioFiles.length; i++) {
            ranges.push({ start: elapsed, end: elapsed + (audioFiles[i].duration || 0), cached: mask[i] });
            elapsed += audioFiles[i].duration || 0;
        }
        document.querySelectorAll('#content .tracklist-item[data-index]').forEach(el => {
            const idx = parseInt(el.dataset.index);
            const ch = chapters[idx];
            if (!ch) return;
            const r = ranges.find(r => ch.start >= r.start && ch.start < r.end);
            if (r?.cached) {
                el.classList.add('is-cached');
                const fill = el.querySelector('.tracklist-cache-fill');
                if (fill) fill.style.width = '100%';
            }
        });
    },

    // Live update: stream a track's cache progress into the matching chapter rows.
    onCacheProgress({ itemId, trackIndex, received, total, done }) {
        const item = this._currentDetailItem;
        if (!item || item.id !== itemId) return;
        const audioFiles = item.media?.audioFiles || [];
        const chapters = item.media?.chapters || [];
        const track = audioFiles[trackIndex];
        if (!track) return;

        let trackStart = 0;
        for (let i = 0; i < trackIndex; i++) trackStart += audioFiles[i].duration || 0;
        const trackEnd = trackStart + (track.duration || 0);
        const trackDur = trackEnd - trackStart;
        if (trackDur <= 0) return;

        const fileFrac = total > 0 ? Math.min(1, received / total) : (done ? 1 : 0);
        const cachedTimeUpTo = trackStart + fileFrac * trackDur;

        document.querySelectorAll('#content .tracklist-item[data-index]').forEach(el => {
            const idx = parseInt(el.dataset.index);
            const ch = chapters[idx];
            if (!ch || ch.start < trackStart || ch.start >= trackEnd) return;
            const chEnd = Math.min(ch.end, trackEnd);
            const chDur = chEnd - ch.start;
            const frac = chDur > 0 ? Math.max(0, Math.min(1, (cachedTimeUpTo - ch.start) / chDur)) : 0;
            const fill = el.querySelector('.tracklist-cache-fill');
            if (fill) fill.style.width = (frac * 100) + '%';
            if (done && frac >= 0.999) el.classList.add('is-cached');
        });
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
                el.innerHTML = `<span class="offline-status">Downloading 0/${trackCount}…</span>`;
                try {
                    await Offline.downloadBook(item, (done, total) => {
                        const status = el.querySelector('.offline-status');
                        if (status) status.textContent = `Downloading ${done}/${total}…`;
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
        document.getElementById('setting-user').textContent = localStorage.getItem('cadence_username') || '';
        document.getElementById('setting-speed').value = Player.audio.playbackRate;
        document.getElementById('setting-skip').value = Player.skipDuration;
        document.getElementById('setting-theme').value = localStorage.getItem('cadence_theme') || 'dark';
        document.getElementById('setting-auto-cache').checked = localStorage.getItem('cadence_auto_cache') !== 'false';
        document.getElementById('settings-modal').classList.remove('hidden');
        this.renderDownloadsList();
    },
    hideSettings() { document.getElementById('settings-modal').classList.add('hidden'); },

    async renderDownloadsList() {
        const list = document.getElementById('downloads-list');
        const clearBtn = document.getElementById('downloads-clear');
        if (!list) return;
        list.innerHTML = '<div class="downloads-empty">Loading…</div>';
        const items = await Offline.listDownloaded();
        if (!items.length) {
            list.innerHTML = '<div class="downloads-empty">No downloads yet</div>';
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
            if (!confirm(`Remove all ${items.length} downloaded book${items.length === 1 ? '' : 's'}?`)) return;
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
            html += `<li class="tracklist-item ${isActive ? 'is-active' : ''}" data-ch="${i}" id="fs-ch-${i}">`;
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
                Player.seekChapterByTap(parseInt(el.dataset.ch), fraction);
            });
        });
        // Scroll to current chapter
        const activeEl = document.getElementById(`fs-ch-${Player.currentChapterIndex}`);
        if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
};

// Offline download manager — stores audio + cover in Cache Storage,
// keyed with the auth token stripped so cache survives token rotation.
const Offline = {
    AUDIO_CACHE: 'pholia-offline-audio-v1',
    META_CACHE: 'pholia-offline-meta-v1',

    keyFor(url) {
        const u = new URL(url);
        u.searchParams.delete('token');
        return u.toString();
    },

    metaKey(itemId) { return `https://pholia.local/meta/${itemId}`; },

    trackUrls(item) {
        return (item.media?.audioFiles || []).map(t => ABS.trackUrl(item.id, t.ino));
    },

    async isDownloaded(item) {
        const urls = this.trackUrls(item);
        if (!urls.length) return false;
        const cache = await caches.open(this.AUDIO_CACHE);
        for (const url of urls) {
            if (!(await cache.match(this.keyFor(url)))) return false;
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
            if (!(await audioCache.match(key))) {
                const res = await fetch(urls[i], { credentials: 'omit' });
                if (!res.ok) throw new Error(`Track ${i + 1} failed: ${res.status}`);
                await audioCache.put(key, res);
            }
            onProgress?.(i + 1, urls.length);
        }

        await this.saveMeta(item);
    },

    async saveMeta(item) {
        const metaCache = await caches.open(this.META_CACHE);
        await metaCache.put(
            this.metaKey(item.id),
            new Response(JSON.stringify(item), { headers: { 'Content-Type': 'application/json' } })
        );
    },

    // Returns one boolean per audioFile: true if cached
    async cachedTracksMask(item) {
        const tracks = item.media?.audioFiles || [];
        if (!tracks.length) return [];
        try {
            const cache = await caches.open(this.AUDIO_CACHE);
            const out = [];
            for (const t of tracks) {
                const m = await cache.match(this.keyFor(ABS.trackUrl(item.id, t.ino)));
                out.push(!!m);
            }
            return out;
        } catch {
            return tracks.map(() => false);
        }
    },

    async deleteBook(item) {
        const audioCache = await caches.open(this.AUDIO_CACHE);
        const metaCache = await caches.open(this.META_CACHE);
        for (const url of this.trackUrls(item)) {
            await audioCache.delete(this.keyFor(url));
        }
        await audioCache.delete(this.keyFor(ABS.coverUrl(item.id)));
        await metaCache.delete(this.metaKey(item.id));
    },

    async bookSize(item) {
        try {
            const cache = await caches.open(this.AUDIO_CACHE);
            const urls = [...this.trackUrls(item), ABS.coverUrl(item.id)];
            let total = 0;
            for (const url of urls) {
                const res = await cache.match(this.keyFor(url));
                if (!res) continue;
                const len = res.headers.get('content-length');
                if (len) { total += parseInt(len, 10); continue; }
                const buf = await res.clone().arrayBuffer();
                total += buf.byteLength;
            }
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

    // IDs of books where every audio file is in the cache.
    async fullyDownloadedIds() {
        try {
            const metaCache = await caches.open(this.META_CACHE);
            const audioCache = await caches.open(this.AUDIO_CACHE);
            const keys = await metaCache.keys();
            const ids = new Set();
            for (const req of keys) {
                const res = await metaCache.match(req);
                if (!res) continue;
                let item;
                try { item = await res.json(); } catch { continue; }
                const tracks = item.media?.audioFiles || [];
                if (!tracks.length) continue;
                let all = true;
                for (const t of tracks) {
                    const m = await audioCache.match(this.keyFor(ABS.trackUrl(item.id, t.ino)));
                    if (!m) { all = false; break; }
                }
                if (all) ids.add(item.id);
            }
            return ids;
        } catch { return new Set(); }
    },

    async fullyDownloaded() {
        const all = await this.listDownloaded();
        const ids = await this.fullyDownloadedIds();
        return all.filter(i => ids.has(i.id));
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
