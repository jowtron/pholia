const App = {
    currentLibraryId: null,
    libraries: [],
    currentTab: 'home',
    navStack: [],

    init() {
        Player.init();
        this.bindEvents();
        this.tryAutoLogin();
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

        // Library selector
        document.getElementById('library-select').addEventListener('change', e => {
            this.currentLibraryId = e.target.value;
            localStorage.setItem('cadence_library', this.currentLibraryId);
            this.switchTab(this.currentTab);
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
    async tryAutoLogin() {
        const savedServer = localStorage.getItem('cadence_server');
        const savedUser = localStorage.getItem('cadence_username');
        if (savedServer) document.getElementById('server-url').value = savedServer;
        if (savedUser) document.getElementById('username').value = savedUser;

        const creds = ABS.loadCredentials();
        if (creds) {
            try {
                this.libraries = await ABS.getLibraries();
                this.setupLibrarySelector();
                this.showMain();
                this.switchTab('home');
            } catch {
                ABS.token = '';
                localStorage.removeItem('cadence_token');
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
            errorEl.textContent = e.message;
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
    },

    // ── Navigation ──
    switchTab(tab) {
        this.currentTab = tab;
        this.navStack = [];
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.getElementById('back-btn').classList.add('hidden');

        switch (tab) {
            case 'home': this.showHome(); break;
            case 'library': this.showLibrary(); break;
            case 'series': this.showSeries(); break;
            case 'collections': this.showCollections(); break;
            case 'authors': this.showAuthors(); break;
        }
    },

    pushNav(title) {
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

        try {
            const sections = await ABS.request(`/api/libraries/${this.currentLibraryId}/personalized`);
            let html = '';
            for (const section of sections) {
                if (!section.entities?.length) continue;
                html += `<div class="section-title">${esc(section.label)}</div>`;
                html += '<div class="h-scroll">';
                for (const entity of section.entities) {
                    const itemId = entity.id || entity.libraryItemId;
                    const meta = entity.media?.metadata || entity.metadata || {};
                    const title = meta.title || entity.title || 'Unknown';
                    const author = meta.authorName || '';
                    const progress = entity.mediaProgress?.progress || entity.progress?.progress || 0;
                    html += `<div class="card" data-id="${itemId}" data-type="${section.type}">`;
                    html += `<img src="${ABS.coverUrl(itemId)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
                    html += `<div class="card-title">${esc(title)}</div>`;
                    html += `<div class="card-sub">${esc(author)}</div>`;
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
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
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

    // ── Series ──
    async showSeries() {
        document.getElementById('header-title').textContent = 'Series';
        this.showLoading();
        try {
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/series?limit=200&sort=name`);
            const series = data.results || [];
            let html = '<div class="list-view">';
            for (const s of series) {
                const books = s.books || [];
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

    async showSeriesDetail(seriesId, seriesName) {
        this.pushNav(seriesName);
        this.showLoading();
        try {
            // Get all items in this library filtered by series
            const encoded = btoa(unescape(encodeURIComponent(seriesName)));
            const data = await ABS.request(`/api/libraries/${this.currentLibraryId}/items?filter=series.${encodeURIComponent(encoded)}&sort=media.metadata.title&limit=100`);
            const books = data.results || [];
            if (books.length) {
                this.renderGrid(books);
            } else {
                // Fallback: try series detail endpoint
                const data2 = await ABS.request(`/api/libraries/${this.currentLibraryId}/series/${seriesId}`);
                const raw = data2.books || data2.libraryItems || data2.results || [];
                this.renderGrid(raw.map(b => b.libraryItem || b));
            }
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
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
        if (progress > 0) {
            html += `<div class="item-progress"><div class="item-progress-fill" style="width:${progress*100}%"></div></div>`;
        }
        html += '<div class="item-info">';
        html += `<div class="item-title">${esc(title || 'Unknown')}</div>`;
        html += `<div class="item-subtitle">${esc(author || '')}</div>`;
        html += '</div></div>';
        return html;
    },

    bindCardClicks() {
        document.querySelectorAll('.grid-item[data-id], .card[data-id]').forEach(el => {
            el.addEventListener('click', () => this.showItem(el.dataset.id));
        });
    },

    // ── Item detail ──
    async showItem(itemId) {
        this.pushNav('Loading...');
        this.showLoading();
        try {
            const item = await ABS.getItem(itemId);
            const meta = item.media?.metadata || {};
            const chapters = item.media?.chapters || [];
            const duration = item.media?.duration || 0;
            const progress = await ABS.getProgress(itemId);
            const currentTime = progress?.currentTime || 0;

            this.navStack[this.navStack.length - 1] = meta.title || 'Unknown';
            document.getElementById('header-title').textContent = meta.title || 'Unknown';

            let html = '<div class="detail-view">';
            html += '<div class="detail-header">';
            html += `<img class="detail-cover" src="${ABS.coverUrl(itemId)}" alt="" onerror="this.style.visibility='hidden'">`;
            html += '<div class="detail-meta">';
            html += `<h3>${esc(meta.title || 'Unknown')}</h3>`;
            if (meta.authorName) html += `<div class="author">${esc(meta.authorName)}</div>`;
            if (meta.narratorName) html += `<div class="narrator">Narrated by ${esc(meta.narratorName)}</div>`;
            html += `<div class="duration">${formatTime(duration)}`;
            if (progress) html += ` &bull; ${Math.round(progress.progress * 100)}% complete`;
            html += '</div>';
            if (meta.description) html += `<div class="description">${esc(meta.description)}</div>`;
            html += '</div></div>';

            const btnText = currentTime > 0 ? `Resume from ${formatTime(currentTime)}` : 'Play';
            html += `<button class="play-btn-large" id="detail-play">${btnText}</button>`;

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

            document.getElementById('detail-play').addEventListener('click', () => {
                Player.startItem(item, currentTime > 0 ? currentTime : null);
                // Scroll to active chapter
                setTimeout(() => {
                    const active = document.querySelector('.tracklist-item.is-active');
                    if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }, 100);
            });
            document.querySelectorAll('.tracklist-item').forEach(el => {
                el.querySelector('.tracklist-play').addEventListener('click', () => {
                    Player.startItem(item, chapters[parseInt(el.dataset.index)].start);
                });
            });
        } catch (e) {
            this.setContent(`<div class="loading">Error: ${esc(e.message)}</div>`);
        }
    },

    // ── Settings ──
    showSettings() {
        document.getElementById('setting-server').textContent = ABS.serverUrl;
        document.getElementById('setting-user').textContent = localStorage.getItem('cadence_username') || '';
        document.getElementById('setting-speed').value = Player.audio.playbackRate;
        document.getElementById('setting-skip').value = Player.skipDuration;
        document.getElementById('settings-modal').classList.remove('hidden');
    },
    hideSettings() { document.getElementById('settings-modal').classList.add('hidden'); },

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
            el.querySelector('.tracklist-play').addEventListener('click', () => {
                Player.goToChapter(parseInt(el.dataset.ch));
            });
        });
        // Scroll to current chapter
        const activeEl = document.getElementById(`fs-ch-${Player.currentChapterIndex}`);
        if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

document.addEventListener('DOMContentLoaded', () => App.init());
