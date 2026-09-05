// One-time localStorage migration from the legacy cadence_ prefix to pholia_.
// Runs before anything reads keys. Safe to leave indefinitely — cheap on
// every load, no-op once migrated.
(function migratePholiaKeys() {
    try {
        // Earliest Pholia-account drafts stored the account session bearer
        // under cadence_pholia_token, then briefly under pholia_token. The
        // big rename below makes pholia_token mean "the ABS JWT" — so we
        // need to move any pre-existing account session bearer out of the
        // way to pholia_session BEFORE the cadence_token → pholia_token
        // rename overwrites it.
        const veryOld = localStorage.getItem('cadence_pholia_token');
        if (veryOld && !localStorage.getItem('pholia_session')) {
            localStorage.setItem('pholia_session', veryOld);
        }
        if (veryOld !== null) localStorage.removeItem('cadence_pholia_token');

        // Was pholia_token actually a Pholia account session (yesterday's
        // build) or already an ABS JWT? Distinguish by length: account
        // sessions are exactly 64 hex chars; ABS JWTs are ~200+ chars.
        const ambiguous = localStorage.getItem('pholia_token');
        if (ambiguous && /^[0-9a-f]{64}$/.test(ambiguous) && !localStorage.getItem('pholia_session')) {
            localStorage.setItem('pholia_session', ambiguous);
            localStorage.removeItem('pholia_token');
        }

        const renames = {
            'cadence_server': 'pholia_server',
            'cadence_username': 'pholia_username',
            'cadence_token': 'pholia_token',
            'cadence_device_id': 'pholia_device_id',
            'cadence_theme': 'pholia_theme',
            'cadence_speed': 'pholia_speed',
            'cadence_skip': 'pholia_skip',
            'cadence_auto_cache': 'pholia_auto_cache',
            'cadence_library': 'pholia_library',
        };
        for (const [oldK, newK] of Object.entries(renames)) {
            const v = localStorage.getItem(oldK);
            if (v !== null && localStorage.getItem(newK) === null) {
                localStorage.setItem(newK, v);
            }
            localStorage.removeItem(oldK);
        }

        const oldPasskeyFlag = localStorage.getItem('cadence_passkey_registered');
        if (oldPasskeyFlag && !localStorage.getItem('pholia_passkey_registered')) {
            localStorage.setItem('pholia_passkey_registered', oldPasskeyFlag);
        }
        if (oldPasskeyFlag !== null) localStorage.removeItem('cadence_passkey_registered');
    } catch {}
})();

// Audiobookshelf API client
const ABS = {
    serverUrl: '',
    token: '',

    // Desktop mode (Wails): route API calls through local Go proxy
    _isDesktop: !location.protocol.startsWith('http'),

    // Convert a full URL to a proxy path: /proxy/{scheme}/{host}/{path}?query
    _proxyUrl(fullUrl) {
        if (!this._isDesktop) return fullUrl;
        try {
            const u = new URL(fullUrl);
            const p = `/proxy/${u.protocol.replace(':', '')}/${u.host}${u.pathname}`;
            return u.search ? p + u.search : p;
        } catch {
            return fullUrl;
        }
    },

    init(serverUrl, token) {
        this.serverUrl = serverUrl.replace(/\/+$/, '');
        this.token = token;
    },

    // Build URL with token as query param (avoids CORS preflight issues)
    apiUrl(path) {
        const sep = path.includes('?') ? '&' : '?';
        return this._proxyUrl(`${this.serverUrl}${path}${sep}token=${this.token}`);
    },

    async request(path, options = {}) {
        const url = this.apiUrl(path);
        const headers = {};
        if (options.body) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetch(url, {
                credentials: 'omit',
                ...options,
                headers: { ...headers, ...options.headers },
            });
        } catch (e) {
            // Network error (offline, DNS not ready, CORS block, etc.)
            const err = new Error(`Network error: ${e.message}`);
            err.isNetwork = true;
            throw err;
        }
        if (!res.ok) {
            const err = new Error(`API error ${res.status}: ${res.statusText}`);
            err.status = res.status;
            err.isNetwork = false;
            throw err;
        }
        // ABS returns 200/204 with no body for progress-sync endpoints —
        // res.json() on an empty body throws SyntaxError. Treat empty
        // responses as null rather than letting them surface as errors.
        if (res.status === 204) return null;
        const text = await res.text();
        if (!text) return null;
        return JSON.parse(text);
    },

    // Auth
    async login(serverUrl, username, password) {
        const url = this._proxyUrl(`${serverUrl.replace(/\/+$/, '')}/login`);
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
        } catch (e) {
            const cleanUrl = serverUrl.replace(/\/+$/, '');
            throw new Error(
                `Could not connect to server. <a href="${cleanUrl}" target="_blank" style="color:var(--accent)">Tap here to open your server</a> first, then try again.`
            );
        }
        if (!res.ok) {
            throw new Error('Login failed. Check your credentials and server URL.');
        }
        const data = await res.json();
        this.serverUrl = serverUrl.replace(/\/+$/, '');
        this.token = data.user.token;
        return data;
    },

    // Sign in with an existing ABS access token instead of a password —
    // the shape a saved token-only server (ABS_shim hand-off) needs. ABS's
    // /api/authorize re-validates the token and hands back a fresh one.
    async authorize(serverUrl, token) {
        const clean = serverUrl.replace(/\/+$/, '');
        const url = this._proxyUrl(`${clean}/api/authorize?token=${encodeURIComponent(token)}`);
        let res;
        try {
            res = await fetch(url, { method: 'POST', credentials: 'omit' });
        } catch (e) {
            throw new Error(
                `Could not connect to server. <a href="${clean}" target="_blank" style="color:var(--accent)">Tap here to open your server</a> first, then try again.`
            );
        }
        if (!res.ok) {
            const err = new Error(res.status === 401 || res.status === 403
                ? 'Your saved sign-in has expired. Enter your password to sign in again.'
                : `Sign-in failed (${res.status}).`);
            err.status = res.status;
            throw err;
        }
        const data = await res.json();
        this.serverUrl = clean;
        this.token = (data.user && (data.user.accessToken || data.user.token)) || token;
        return data;
    },

    // Libraries
    async getLibraries() {
        const data = await this.request('/api/libraries');
        return data.libraries;
    },

    // Library items with pagination
    async getLibraryItems(libraryId, page = 0, limit = 50, sort = 'media.metadata.title', desc = false, filter = null) {
        let path = `/api/libraries/${libraryId}/items?limit=${limit}&page=${page}&sort=${sort}&desc=${desc ? 1 : 0}&minified=1`;
        if (filter) path += `&filter=${filter}`;
        return this.request(path);
    },

    // Search within a library
    async searchLibrary(libraryId, query) {
        return this.request(`/api/libraries/${libraryId}/search?q=${encodeURIComponent(query)}&limit=20`);
    },

    // Single item with full details. Pass includeProgress: true to fold the
    // user's mediaProgress into the same round trip — saves a separate
    // /api/me/progress/:id call for "open book + show resume position".
    async getItem(itemId, { includeProgress = false } = {}) {
        const inc = includeProgress ? '&include=progress' : '';
        return this.request(`/api/items/${itemId}?expanded=1${inc}`);
    },

    // Cover art URL (direct — img tags don't need CORS proxy)
    coverUrl(itemId) {
        return `${this.serverUrl}/api/items/${itemId}/cover?token=${this.token}`;
    },

    // Author photo URL — different endpoint from item covers.
    authorImageUrl(authorId) {
        return `${this.serverUrl}/api/authors/${authorId}/image?token=${this.token}`;
    },

    // Audio track URL (direct — audio tags don't need CORS proxy)
    trackUrl(itemId, ino) {
        return `${this.serverUrl}/api/items/${itemId}/file/${ino}?token=${this.token}`;
    },

    // Start playback session
    async startSession(itemId, episodeId = null) {
        const body = {
            deviceInfo: this.deviceInfo(),
            forceDirectPlay: true,
            forceTranscode: false,
            supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm'],
        };
        const path = episodeId
            ? `/api/items/${itemId}/play/${episodeId}`
            : `/api/items/${itemId}/play`;
        return this.request(path, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    // Sync playback progress
    // opts.keepalive lets the request outlive the page (background / kill).
    async syncSession(sessionId, currentTime, duration, timeListened = 0, opts = {}) {
        return this.request(`/api/session/${sessionId}/sync`, {
            method: 'POST',
            body: JSON.stringify({ currentTime, duration, timeListened }),
            ...(opts.keepalive ? { keepalive: true } : {}),
        });
    },

    // Close playback session
    async closeSession(sessionId, currentTime, duration, timeListened = 0) {
        return this.request(`/api/session/${sessionId}/close`, {
            method: 'POST',
            body: JSON.stringify({ currentTime, duration, timeListened }),
        });
    },

    // Get user's media progress for an item. Uses the single-item endpoint
    // (/api/me/progress/:id) which is much cheaper than fetching the full
    // /api/me payload (all mediaProgress + bookmarks). 404 means no progress
    // recorded yet — return null, not an error.
    async getProgress(itemId) {
        try {
            return await this.request(`/api/me/progress/${itemId}`);
        } catch (e) {
            if (e.status === 404) return null;
            return null;
        }
    },

    // Update progress directly
    async updateProgress(itemId, progress, opts = {}) {
        return this.request(`/api/me/progress/${itemId}`, {
            method: 'PATCH',
            body: JSON.stringify(progress),
            ...(opts.keepalive ? { keepalive: true } : {}),
        });
    },

    // Get a stable device ID
    getDeviceId() {
        let id = localStorage.getItem('pholia_device_id');
        if (!id) {
            id = 'pholia_' + Math.random().toString(36).substring(2, 15);
            localStorage.setItem('pholia_device_id', id);
        }
        return id;
    },

    // Build the deviceInfo payload sent with playback sessions. Richer info
    // (clientVersion, osName, model) makes ABS's session history readable —
    // ShelfPlayer/Plappa do this; previously Pholia rows just said "Pholia".
    // Coarse-grained on purpose: don't fingerprint beyond client + OS family.
    deviceInfo() {
        const ua = navigator.userAgent || '';
        let osName = 'Unknown', manufacturer = 'Unknown', model = 'Browser';
        if (/iPhone|iPad|iPod/i.test(ua)) { osName = 'iOS'; manufacturer = 'Apple'; model = /iPad/i.test(ua) ? 'iPad' : 'iPhone'; }
        else if (/Mac OS X|Macintosh/i.test(ua)) { osName = 'macOS'; manufacturer = 'Apple'; model = 'Mac'; }
        else if (/Android/i.test(ua)) { osName = 'Android'; manufacturer = 'Android'; model = 'Phone'; }
        else if (/Windows/i.test(ua)) { osName = 'Windows'; manufacturer = 'Microsoft'; model = 'PC'; }
        else if (/Linux/i.test(ua)) { osName = 'Linux'; manufacturer = 'Linux'; model = 'PC'; }
        const clientVersion = document.getElementById('build-version')?.textContent?.trim() || 'dev';
        return {
            clientName: 'Pholia',
            clientVersion,
            deviceId: this.getDeviceId(),
            manufacturer, model, osName,
        };
    },

    // Save/load credentials from localStorage
    saveCredentials(serverUrl, username, token) {
        localStorage.setItem('pholia_server', serverUrl);
        localStorage.setItem('pholia_username', username);
        localStorage.setItem('pholia_token', token);
        this.setInstallHint(serverUrl, username);
    },

    // Tell the manifest which server to open on. An iOS home-screen app has
    // its own storage partition — none of the localStorage above reaches
    // it — but the manifest's start_url does, so functions/manifest.json.js
    // bakes `?server=&u=` into it. The hint travels both as the manifest
    // link's query and as a cookie (see that file for why both). The link
    // itself is written by the inline head script in index.html, which is
    // what "Add to Home Screen" actually reads; this keeps it current if
    // the user switches server in the same page load. Never cleared on
    // logout: the login form prefills the last server there too.
    setInstallHint(serverUrl, username) {
        const payload = JSON.stringify({ s: serverUrl, u: username || '' });
        try {
            const link = document.querySelector('link[rel="manifest"]');
            if (link) {
                const qs = new URLSearchParams({ s: serverUrl });
                if (username) qs.set('u', username);
                link.href = 'manifest.json?' + qs.toString();
            }
        } catch (e) { /* no DOM (tests) */ }
        try {
            document.cookie = 'pholia_install=' + encodeURIComponent(payload) +
                '; Path=/; Max-Age=31536000; SameSite=Lax' +
                (location.protocol === 'https:' ? '; Secure' : '');
        } catch (e) { /* cookies blocked */ }
    },

    loadCredentials() {
        const serverUrl = localStorage.getItem('pholia_server');
        const username = localStorage.getItem('pholia_username');
        const token = localStorage.getItem('pholia_token');
        if (serverUrl && token) {
            this.init(serverUrl, token);
            return { serverUrl, username, token };
        }
        return null;
    },

    clearCredentials() {
        localStorage.removeItem('pholia_server');
        localStorage.removeItem('pholia_username');
        localStorage.removeItem('pholia_token');
        this.serverUrl = '';
        this.token = '';
    },
};
