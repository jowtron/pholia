// Verify the assertion and issue a session token.

import { base64UrlToBytes } from '../../../_shared/encoding.js';
import { generateToken, hashToken } from '../../../_shared/crypto.js';
import { jsonResponse, errorResponse } from '../../../_shared/auth.js';
import {
    rpIdFor, isOriginTrusted, verifyAssertion,
    SESSION_DURATION_DAYS,
} from '../../../_shared/webauthn.js';

export async function onRequestPost({ request, env }) {
    let body;
    try { body = await request.json(); } catch { return errorResponse('Invalid JSON'); }

    const clientDataBytes = base64UrlToBytes(body.response.clientDataJSON);
    const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
    if (clientData.type !== 'webauthn.get') return errorResponse('Wrong ceremony type');

    const challenge = await env.DB.prepare(
        "SELECT id FROM webauthn_challenges WHERE challenge = ? AND type = 'authenticate' AND expires_at > datetime('now')"
    ).bind(clientData.challenge).first();
    if (!challenge) return errorResponse('Invalid or expired challenge');

    const origin = request.headers.get('origin') || '';
    const rpId = rpIdFor(origin);
    if (!isOriginTrusted(clientData.origin, rpId)) {
        return errorResponse('Origin mismatch');
    }

    const credential = await env.DB.prepare(
        'SELECT user_id, public_key FROM webauthn_credentials WHERE id = ?'
    ).bind(body.id).first();
    if (!credential) return errorResponse('Unknown credential');

    const publicKeyCOSE = base64UrlToBytes(credential.public_key);
    const authData = base64UrlToBytes(body.response.authenticatorData);
    const signature = base64UrlToBytes(body.response.signature);

    let valid = false;
    try {
        valid = await verifyAssertion(publicKeyCOSE, authData, clientDataBytes, signature);
    } catch (e) {
        return errorResponse(`Signature verify failed: ${e.message}`);
    }
    if (!valid) return errorResponse('Invalid signature');

    const flags = authData[32];
    if ((flags & 0x01) === 0 || (flags & 0x04) === 0) {
        return errorResponse('User verification failed');
    }

    const newSignCount = (authData[33] << 24) | (authData[34] << 16) |
                         (authData[35] << 8) | authData[36];
    await env.DB.prepare(
        "UPDATE webauthn_credentials SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?"
    ).bind(newSignCount, body.id).run();

    await env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?')
        .bind(challenge.id).run();

    const sessionToken = generateToken();
    const tokenHash = await hashToken(sessionToken);
    const expiresAt = new Date(
        Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    await env.DB.prepare(
        'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), credential.user_id, tokenHash, expiresAt).run();

    return jsonResponse({ token: sessionToken, userId: credential.user_id });
}
