// Pholia Account: passkey-protected wrapper around saved ABS server creds
// so a user can biometrically log in on a new device and have their server
// list (with passwords for silent ABS JWT renewal) restored.
//
// LocalStorage keys (all kept on the legacy `cadence_` prefix for PWA
// backward-compat — same reason api.js does):
//   cadence_pholia_token       — bearer token for the Pholia API
//   cadence_passkey_registered — '1' once this device has a passkey, used
//                                to decide whether to show the Face ID
//                                button on the login page

const TOKEN_KEY = 'cadence_pholia_token';
const PASSKEY_FLAG = 'cadence_passkey_registered';

function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

const Account = {
    token: () => localStorage.getItem(TOKEN_KEY),
    setToken: (t) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY),
    hasPasskeyOnThisDevice: () => localStorage.getItem(PASSKEY_FLAG) === '1',

    async isPasskeyAvailable() {
        if (!window.PublicKeyCredential) return false;
        try {
            return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        } catch { return false; }
    },

    // Build headers for an authenticated Pholia API request. Skip the Bearer
    // header entirely if no token is stored — sending "Bearer null" would be
    // rejected by the auth middleware as a malformed token rather than
    // falling through to the unauthenticated path.
    _authHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        const t = this.token();
        if (t) headers['Authorization'] = `Bearer ${t}`;
        return headers;
    },

    // Call /api/auth/me to confirm the stored token is still valid. Returns
    // user info on success, null on 401/network failure.
    async whoami() {
        if (!this.token()) return null;
        try {
            const res = await fetch('/api/auth/me', { headers: this._authHeaders() });
            if (!res.ok) {
                if (res.status === 401) this.setToken(null);
                return null;
            }
            return await res.json();
        } catch { return null; }
    },

    // ── WebAuthn ceremonies ──

    async registerPasskey({ newAccount = false } = {}) {
        const optsRes = await fetch('/api/auth/webauthn/register-options', {
            method: 'POST',
            headers: this._authHeaders(),
            body: JSON.stringify({ newAccount }),
        });
        if (!optsRes.ok) {
            const err = await optsRes.json().catch(() => ({}));
            throw new Error(err.error || `register-options ${optsRes.status}`);
        }
        const opts = await optsRes.json();

        const credential = await navigator.credentials.create({
            publicKey: {
                challenge: base64UrlToBytes(opts.challenge).buffer,
                rp: opts.rp,
                user: {
                    id: base64UrlToBytes(opts.user.id).buffer,
                    name: opts.user.name,
                    displayName: opts.user.displayName,
                },
                pubKeyCredParams: opts.pubKeyCredParams,
                authenticatorSelection: opts.authenticatorSelection,
                timeout: opts.timeout,
                attestation: opts.attestation,
                excludeCredentials: (opts.excludeCredentials || []).map(c => ({
                    ...c, id: base64UrlToBytes(c.id).buffer,
                })),
            },
        });
        if (!credential) throw new Error('No credential returned');
        const response = credential.response;

        const regRes = await fetch('/api/auth/webauthn/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: credential.id,
                rawId: bytesToBase64Url(new Uint8Array(credential.rawId)),
                response: {
                    attestationObject: bytesToBase64Url(new Uint8Array(response.attestationObject)),
                    clientDataJSON: bytesToBase64Url(new Uint8Array(response.clientDataJSON)),
                },
                type: credential.type,
            }),
        });
        if (!regRes.ok) {
            const err = await regRes.json().catch(() => ({}));
            throw new Error(err.error || `register ${regRes.status}`);
        }
        const data = await regRes.json();
        if (data.token) this.setToken(data.token);
        localStorage.setItem(PASSKEY_FLAG, '1');
        return data;
    },

    async authenticateWithPasskey() {
        const optsRes = await fetch('/api/auth/webauthn/authenticate-options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!optsRes.ok) {
            const err = await optsRes.json().catch(() => ({}));
            throw new Error(err.error || `authenticate-options ${optsRes.status}`);
        }
        const opts = await optsRes.json();

        const credential = await navigator.credentials.get({
            publicKey: {
                challenge: base64UrlToBytes(opts.challenge).buffer,
                rpId: opts.rpId,
                allowCredentials: (opts.allowCredentials || []).map(c => ({
                    ...c, id: base64UrlToBytes(c.id).buffer,
                })),
                userVerification: opts.userVerification,
                timeout: opts.timeout,
            },
        });
        if (!credential) throw new Error('No credential returned');
        const response = credential.response;

        const authRes = await fetch('/api/auth/webauthn/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: credential.id,
                rawId: bytesToBase64Url(new Uint8Array(credential.rawId)),
                response: {
                    authenticatorData: bytesToBase64Url(new Uint8Array(response.authenticatorData)),
                    clientDataJSON: bytesToBase64Url(new Uint8Array(response.clientDataJSON)),
                    signature: bytesToBase64Url(new Uint8Array(response.signature)),
                    userHandle: response.userHandle ? bytesToBase64Url(new Uint8Array(response.userHandle)) : undefined,
                },
                type: credential.type,
            }),
        });
        if (!authRes.ok) {
            const err = await authRes.json().catch(() => ({}));
            throw new Error(err.error || `authenticate ${authRes.status}`);
        }
        const data = await authRes.json();
        if (data.token) this.setToken(data.token);
        localStorage.setItem(PASSKEY_FLAG, '1');
        return data;
    },

    async logout() {
        try {
            if (this.token()) {
                await fetch('/api/auth/logout', { method: 'POST', headers: this._authHeaders() });
            }
        } catch {}
        this.setToken(null);
        // Keep the passkey flag — the credential is still on the device, the
        // user can re-authenticate. Only clear it if they explicitly remove
        // the passkey.
    },

    // ── Saved ABS servers ──

    async listServers() {
        const res = await fetch('/api/servers', { headers: this._authHeaders() });
        if (!res.ok) {
            if (res.status === 401) this.setToken(null);
            throw new Error(`listServers ${res.status}`);
        }
        const data = await res.json();
        return data.servers || [];
    },

    async saveServer({ server_url, username, password, label }) {
        const res = await fetch('/api/servers', {
            method: 'POST',
            headers: this._authHeaders(),
            body: JSON.stringify({ server_url, username, password, label }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `saveServer ${res.status}`);
        }
        return await res.json();
    },

    async getServerCredentials(id) {
        const res = await fetch(`/api/servers/${encodeURIComponent(id)}`, { headers: this._authHeaders() });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `getServerCredentials ${res.status}`);
        }
        return await res.json();
    },

    async deleteServer(id) {
        const res = await fetch(`/api/servers/${encodeURIComponent(id)}`, {
            method: 'DELETE', headers: this._authHeaders(),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `deleteServer ${res.status}`);
        }
        return await res.json();
    },
};

window.Account = Account;
