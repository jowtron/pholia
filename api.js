// Audiobookshelf API client
const ABS = {
    serverUrl: '',
    token: '',

    init(serverUrl, token) {
        this.serverUrl = serverUrl.replace(/\/+$/, '');
        this.token = token;
    },

    headers() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
        };
    },

    async request(path, options = {}) {
        const url = `${this.serverUrl}${path}`;
        const res = await fetch(url, {
            headers: this.headers(),
            ...options,
        });
        if (!res.ok) {
            throw new Error(`API error ${res.status}: ${res.statusText}`);
        }
        return res.json();
    },

    // Auth
    async login(serverUrl, username, password) {
        const url = `${serverUrl.replace(/\/+$/, '')}/login`;
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
        } catch (e) {
            throw new Error(
                'Could not reach server. This may be a CORS issue. ' +
                'Ensure ALLOW_CORS=1 is set on your Audiobookshelf server. (' + e.message + ')'
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

    // Single item with full details
    async getItem(itemId) {
        return this.request(`/api/items/${itemId}?expanded=1`);
    },

    // Cover art URL
    coverUrl(itemId) {
        return `${this.serverUrl}/api/items/${itemId}/cover?token=${this.token}`;
    },

    // Audio track URL
    trackUrl(itemId, ino) {
        return `${this.serverUrl}/api/items/${itemId}/file/${ino}?token=${this.token}`;
    },

    // Start playback session
    async startSession(itemId, episodeId = null) {
        const body = {
            deviceInfo: {
                clientName: 'Cadence',
                deviceId: this.getDeviceId(),
            },
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
    async syncSession(sessionId, currentTime, duration, timeListened = 0) {
        return this.request(`/api/session/${sessionId}/sync`, {
            method: 'POST',
            body: JSON.stringify({ currentTime, duration, timeListened }),
        });
    },

    // Close playback session
    async closeSession(sessionId, currentTime, duration, timeListened = 0) {
        return this.request(`/api/session/${sessionId}/close`, {
            method: 'POST',
            body: JSON.stringify({ currentTime, duration, timeListened }),
        });
    },

    // Get user's media progress for an item
    async getProgress(itemId) {
        try {
            const me = await this.request('/api/me');
            const progress = me.mediaProgress?.find(p => p.libraryItemId === itemId);
            return progress || null;
        } catch {
            return null;
        }
    },

    // Update progress directly
    async updateProgress(itemId, progress) {
        return this.request(`/api/me/progress/${itemId}`, {
            method: 'PATCH',
            body: JSON.stringify(progress),
        });
    },

    // Get a stable device ID
    getDeviceId() {
        let id = localStorage.getItem('cadence_device_id');
        if (!id) {
            id = 'cadence_' + Math.random().toString(36).substring(2, 15);
            localStorage.setItem('cadence_device_id', id);
        }
        return id;
    },

    // Save/load credentials from localStorage
    saveCredentials(serverUrl, username, token) {
        localStorage.setItem('cadence_server', serverUrl);
        localStorage.setItem('cadence_username', username);
        localStorage.setItem('cadence_token', token);
    },

    loadCredentials() {
        const serverUrl = localStorage.getItem('cadence_server');
        const username = localStorage.getItem('cadence_username');
        const token = localStorage.getItem('cadence_token');
        if (serverUrl && token) {
            this.init(serverUrl, token);
            return { serverUrl, username, token };
        }
        return null;
    },

    clearCredentials() {
        localStorage.removeItem('cadence_server');
        localStorage.removeItem('cadence_username');
        localStorage.removeItem('cadence_token');
        this.serverUrl = '';
        this.token = '';
    },
};
