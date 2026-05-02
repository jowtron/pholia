// Verify the WebAuthn attestation and store the credential. Issues a session
// token in the response so the new account is immediately logged in.

import { bytesToBase64Url, base64UrlToBytes } from '../../../_shared/encoding.js';
import { decodeCBOR } from '../../../_shared/cbor.js';
import { generateToken, hashToken } from '../../../_shared/crypto.js';
import { jsonResponse, errorResponse } from '../../../_shared/auth.js';
import {
    rpIdFor, isOriginTrusted, parseAttestationAuthData,
    SESSION_DURATION_DAYS,
} from '../../../_shared/webauthn.js';

export async function onRequestPost({ request, env }) {
    let body;
    try { body = await request.json(); } catch { return errorResponse('Invalid JSON'); }

    const clientDataBytes = base64UrlToBytes(body.response.clientDataJSON);
    const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
    if (clientData.type !== 'webauthn.create') return errorResponse('Wrong ceremony type');

    const challenge = await env.DB.prepare(
        "SELECT id, user_id FROM webauthn_challenges WHERE challenge = ? AND type = 'register' AND expires_at > datetime('now')"
    ).bind(clientData.challenge).first();
    if (!challenge?.user_id) return errorResponse('Invalid or expired challenge');

    const origin = request.headers.get('origin') || '';
    const rpId = rpIdFor(origin);
    if (!isOriginTrusted(clientData.origin, rpId)) {
        return errorResponse('Origin mismatch');
    }

    let credentialId, publicKeyCOSE;
    try {
        const attestation = decodeCBOR(base64UrlToBytes(body.response.attestationObject));
        ({ credentialId, publicKeyCOSE } = parseAttestationAuthData(attestation.authData));
    } catch (e) {
        return errorResponse(`Attestation parse failed: ${e.message}`);
    }

    try {
        await env.DB.prepare(
            'INSERT INTO webauthn_credentials (id, user_id, public_key, sign_count, transports, label) VALUES (?, ?, ?, 0, ?, ?)'
        ).bind(
            bytesToBase64Url(credentialId),
            challenge.user_id,
            bytesToBase64Url(publicKeyCOSE),
            JSON.stringify(['internal']),
            body.label || null,
        ).run();
    } catch (e) {
        // UNIQUE constraint — credential already registered. Treat as success
        // (idempotent re-registration after PWA reinstall).
        if (!String(e.message || '').includes('UNIQUE')) {
            return errorResponse(`DB error: ${e.message}`, 500);
        }
    }

    await env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?')
        .bind(challenge.id).run();

    // Issue a session immediately so the new account is logged in.
    const sessionToken = generateToken();
    const tokenHash = await hashToken(sessionToken);
    const expiresAt = new Date(
        Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    await env.DB.prepare(
        'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), challenge.user_id, tokenHash, expiresAt).run();

    return jsonResponse({ token: sessionToken, userId: challenge.user_id });
}
