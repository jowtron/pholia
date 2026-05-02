// Generate options for passkey authentication. Public — no auth required,
// since the user isn't logged in yet. Discoverable credentials mean the
// browser shows the user's stored passkeys and they pick one; the server
// learns who they are from the assertion's credentialId.

import { bytesToBase64Url } from '../../../_shared/encoding.js';
import { jsonResponse } from '../../../_shared/auth.js';
import { CHALLENGE_EXPIRY_MS, rpIdFor } from '../../../_shared/webauthn.js';

export async function onRequestPost({ request, env }) {
    const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
    const challenge = bytesToBase64Url(challengeBytes);
    const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_MS).toISOString();
    await env.DB.prepare(
        "INSERT INTO webauthn_challenges (id, challenge, type, expires_at) VALUES (?, ?, 'authenticate', ?)"
    ).bind(crypto.randomUUID(), challenge, expiresAt).run();

    const origin = request.headers.get('origin') || '';
    return jsonResponse({
        challenge,
        rpId: rpIdFor(origin),
        allowCredentials: [], // discoverable — let browser pick
        userVerification: 'required',
        timeout: 60000,
    });
}
