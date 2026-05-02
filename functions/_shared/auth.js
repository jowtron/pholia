import { hashToken } from './crypto.js';

// Session token check — returns user_id or null. Called by authenticated
// endpoints. Tokens come from Authorization: Bearer header (Pholia is a
// PWA so it always has localStorage; we don't fall back to cookies).
export async function getSessionUser(request, env) {
    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    if (!token || token === 'null' || token === 'undefined') return null;
    const tokenHash = await hashToken(token);
    const row = await env.DB.prepare(
        "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')"
    ).bind(tokenHash).first();
    return row?.user_id || null;
}

export function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function errorResponse(message, status = 400) {
    return jsonResponse({ error: message }, status);
}
