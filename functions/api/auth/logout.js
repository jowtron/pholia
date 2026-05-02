// Revoke the current session token. Called when the user explicitly logs out
// of their Pholia account (separate from logging out of an ABS server).

import { hashToken } from '../../_shared/crypto.js';
import { jsonResponse } from '../../_shared/auth.js';

export async function onRequestPost({ request, env }) {
    const auth = request.headers.get('Authorization');
    if (auth?.startsWith('Bearer ')) {
        const token = auth.slice(7);
        if (token && token !== 'null' && token !== 'undefined') {
            const tokenHash = await hashToken(token);
            await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
                .bind(tokenHash).run();
        }
    }
    return jsonResponse({ ok: true });
}
