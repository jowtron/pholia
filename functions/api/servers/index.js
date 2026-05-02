// Saved ABS server credentials for the authenticated Pholia account.
//   GET  /api/servers       — list saved servers (no passwords)
//   POST /api/servers       — add or update (server_url + username is the key)

import { encryptSecret } from '../../_shared/crypto.js';
import { getSessionUser, jsonResponse, errorResponse } from '../../_shared/auth.js';

function normalizeUrl(u) {
    try {
        const url = new URL(u);
        return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
    } catch { return null; }
}

export async function onRequestGet({ request, env }) {
    const userId = await getSessionUser(request, env);
    if (!userId) return errorResponse('Not authenticated', 401);
    const { results } = await env.DB.prepare(
        'SELECT id, server_url, username, label, created_at, last_used_at FROM abs_servers WHERE user_id = ? ORDER BY last_used_at DESC NULLS LAST, created_at DESC'
    ).bind(userId).all();
    return jsonResponse({ servers: results || [] });
}

export async function onRequestPost({ request, env }) {
    const userId = await getSessionUser(request, env);
    if (!userId) return errorResponse('Not authenticated', 401);

    let body;
    try { body = await request.json(); } catch { return errorResponse('Invalid JSON'); }

    const serverUrl = normalizeUrl(body.server_url);
    if (!serverUrl) return errorResponse('Invalid server_url');
    if (!body.username) return errorResponse('Missing username');
    if (!body.password) return errorResponse('Missing password');

    if (!env.ENCRYPTION_KEY) return errorResponse('Server misconfigured (no ENCRYPTION_KEY)', 500);
    const encryptedPassword = await encryptSecret(body.password, env.ENCRYPTION_KEY);

    const id = crypto.randomUUID();
    try {
        await env.DB.prepare(
            'INSERT INTO abs_servers (id, user_id, server_url, username, encrypted_password, label) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, userId, serverUrl, body.username, encryptedPassword, body.label || null).run();
    } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) {
            // Same (user, url, username) already exists — update password + label instead.
            await env.DB.prepare(
                'UPDATE abs_servers SET encrypted_password = ?, label = COALESCE(?, label), last_used_at = datetime(\'now\') WHERE user_id = ? AND server_url = ? AND username = ?'
            ).bind(encryptedPassword, body.label || null, userId, serverUrl, body.username).run();
            return jsonResponse({ ok: true, updated: true });
        }
        return errorResponse(`DB error: ${e.message}`, 500);
    }
    return jsonResponse({ ok: true, id });
}
