import { decodeCBOR } from './cbor.js';
import { bytesToBase64Url, base64UrlToBytes } from './encoding.js';
import { derToP1363 } from './crypto.js';

export const RP_NAME = 'Pholia';
export const CHALLENGE_EXPIRY_MS = 5 * 60_000;
export const SESSION_DURATION_DAYS = 90;

// RP ID is the registrable domain. WebAuthn restricts credentials to a
// specific RP ID — pholia.pages.dev creds won't work on cadence-6re.pages.dev.
// localhost is allowed for dev.
export function rpIdFor(origin) {
    if (!origin) return 'pholia.pages.dev';
    try {
        const u = new URL(origin);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return 'localhost';
        return u.hostname;
    } catch { return 'pholia.pages.dev'; }
}

// Allow same-host + the registered RP ID host for cross-subdomain edge cases.
export function isOriginTrusted(origin, rpId) {
    if (!origin) return false;
    try {
        const u = new URL(origin);
        if (u.hostname === rpId) return true;
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
        return false;
    } catch { return false; }
}

// Parse the WebAuthn attestation authData blob and pull out the credential
// ID and COSE-encoded public key. Layout per spec:
//   rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | pubKeyCOSE
export function parseAttestationAuthData(authData) {
    if (!authData || authData.length < 37) throw new Error('Invalid authData');
    const flags = authData[32];
    const userPresent = (flags & 0x01) !== 0;
    const userVerified = (flags & 0x04) !== 0;
    const attestedCred = (flags & 0x40) !== 0;
    if (!userPresent || !userVerified || !attestedCred) {
        throw new Error('Missing UP/UV/AT flags');
    }
    let pos = 37 + 16; // rpIdHash + flags + signCount + aaguid
    const credIdLen = (authData[pos] << 8) | authData[pos + 1];
    pos += 2;
    const credentialId = authData.slice(pos, pos + credIdLen);
    pos += credIdLen;
    const publicKeyCOSE = authData.slice(pos);
    return { credentialId, publicKeyCOSE };
}

// Verify a WebAuthn assertion signature against a stored COSE public key.
// Currently only ES256 (alg -7, P-256) is supported — that's all we generate
// during registration (pubKeyCredParams below).
export async function verifyAssertion(publicKeyCOSE, authData, clientDataJSON, signature) {
    const coseMap = decodeCBOR(publicKeyCOSE);
    const publicKey = await crypto.subtle.importKey('jwk', {
        kty: 'EC', crv: 'P-256',
        x: bytesToBase64Url(coseMap[-2]),
        y: bytesToBase64Url(coseMap[-3]),
    }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const signedData = new Uint8Array(authData.length + clientDataHash.length);
    signedData.set(authData);
    signedData.set(clientDataHash, authData.length);

    const p1363Sig = derToP1363(signature, 32);
    return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, publicKey, p1363Sig, signedData
    );
}

export function publicKeyCredParams() {
    return [{ type: 'public-key', alg: -7 }]; // ES256
}

export function authenticatorSelection() {
    return {
        authenticatorAttachment: 'platform', // device biometrics
        userVerification: 'required',
        residentKey: 'required', // discoverable credential — true passwordless
    };
}
