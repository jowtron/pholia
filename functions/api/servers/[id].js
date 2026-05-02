// Per-server operations.
//   GET    /api/servers/:id  — return decrypted credentials (for the client
//                              to log in to ABS directly; the worker can't
//                              reach Tailscale-hosted ABS itself, so it
//                              hands the password back over HTTPS)
//   DELETE /api/servers/:id  — remove

import { decryptSecret } from '../../_shared/crypto.js';
import { getSessionUser, jsonResponse, errorResponse } from '../../_shared/auth.js';

export async function onRequestGet({ request, env, params }) {
    const userId = await getSessionUser(request, env);
    if (!userId) return errorResponse('Not authenticated', 401);

    const row = await env.DB.prepare(
        'SELECT server_url, username, encrypted_password, label FROM abs_servers WHERE id = ? AND user_id = ?'
    ).bind(params.id, userId).first();
    if (!row) return errorResponse('Not found', 404);

    if (!env.ENCRYPTION_KEY) return errorResponse('Server misconfigured (no ENCRYPTION_KEY)', 500);
    let password;
    try {
        password = await decryptSecret(row.encrypted_password, env.ENCRYPTION_KEY);
    } catch (e) {
        return errorResponse(`Decrypt failed: ${e.message}`, 500);
    }

    await env.DB.prepare(
        "UPDATE abs_servers SET last_used_at = datetime('now') WHERE id = ?"
    ).bind(params.id).run();

    return jsonResponse({
        id: params.id,
        server_url: row.server_url,
        username: row.username,
        password,
        label: row.label,
    });
}

export async function onRequestDelete({ request, env, params }) {
    const userId = await getSessionUser(request, env);
    if (!userId) return errorResponse('Not authenticated', 401);

    const result = await env.DB.prepare(
        'DELETE FROM abs_servers WHERE id = ? AND user_id = ?'
    ).bind(params.id, userId).run();
    if ((result.meta?.changes || 0) === 0) return errorResponse('Not found', 404);
    return jsonResponse({ ok: true });
}
