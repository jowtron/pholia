// Returns the current account's user_id + the count of registered passkeys.
// Used by the frontend to check whether the stored session token is still
// valid on PWA launch.

import { getSessionUser, jsonResponse, errorResponse } from '../../_shared/auth.js';

export async function onRequestGet({ request, env }) {
    const userId = await getSessionUser(request, env);
    if (!userId) return errorResponse('Not authenticated', 401);
    const row = await env.DB.prepare(
        'SELECT COUNT(*) as n FROM webauthn_credentials WHERE user_id = ?'
    ).bind(userId).first();
    return jsonResponse({ userId, passkeys: row?.n || 0 });
}
