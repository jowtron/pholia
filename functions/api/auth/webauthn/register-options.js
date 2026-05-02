// Generate WebAuthn registration options — called when a user wants to add
// a passkey to a brand-new (or existing) Pholia account. Creates the user
// row on demand: a Pholia account is just "the user with this passkey," so
// we can create the user row here and bind the credential to it on the
// /register call.
//
// The frontend must POST { newAccount: true } to create a new Pholia
// account, OR include a Bearer session token to add a passkey to an
// existing account.

import { bytesToBase64Url } from '../../../_shared/encoding.js';
import { getSessionUser, jsonResponse, errorResponse } from '../../../_shared/auth.js';
import {
    RP_NAME, CHALLENGE_EXPIRY_MS, rpIdFor,
    publicKeyCredParams, authenticatorSelection,
} from '../../../_shared/webauthn.js';

export async function onRequestPost({ request, env }) {
    let body = {};
    try { body = await request.json(); } catch {}

    let userId;
    if (body.newAccount) {
        userId = crypto.randomUUID();
        await env.DB.prepare('INSERT INTO users (id) VALUES (?)').bind(userId).run();
    } else {
        userId = await getSessionUser(request, env);
        if (!userId) return errorResponse('Not authenticated', 401);
    }

    const { results: existing } = await env.DB.prepare(
        'SELECT id FROM webauthn_credentials WHERE user_id = ?'
    ).bind(userId).all();

    const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
    const challenge = bytesToBase64Url(challengeBytes);
    const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_MS).toISOString();
    await env.DB.prepare(
        "INSERT INTO webauthn_challenges (id, challenge, user_id, type, expires_at) VALUES (?, ?, ?, 'register', ?)"
    ).bind(crypto.randomUUID(), challenge, userId, expiresAt).run();

    const origin = request.headers.get('origin') || '';
    const rpId = rpIdFor(origin);

    return jsonResponse({
        challenge,
        rp: { name: RP_NAME, id: rpId },
        user: {
            // Opaque to the user — they never see this, just a binding handle
            // that ties the credential to the account row.
            id: bytesToBase64Url(new TextEncoder().encode(userId)),
            name: `pholia-${userId.slice(0, 8)}`,
            displayName: 'Pholia',
        },
        pubKeyCredParams: publicKeyCredParams(),
        authenticatorSelection: authenticatorSelection(),
        excludeCredentials: (existing || []).map(c => ({
            id: c.id, type: 'public-key', transports: ['internal'],
        })),
        timeout: 60000,
        attestation: 'none',
    });
}
