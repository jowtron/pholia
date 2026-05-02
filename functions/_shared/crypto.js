import { bytesToBase64Url, base64UrlToBytes, bytesToHex, hexToBytes } from './encoding.js';

export async function hashToken(token) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return bytesToHex(new Uint8Array(digest));
}

export function generateToken() {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// WebAuthn produces DER-encoded ECDSA signatures, but Web Crypto verify()
// expects IEEE P1363 (raw r || s).
export function derToP1363(der, componentLength) {
    let offset = 0;
    if (der[offset++] !== 0x30) throw new Error('Invalid DER signature');
    offset++;
    if (der[offset++] !== 0x02) throw new Error('Invalid DER: expected integer for r');
    const rLen = der[offset++];
    const rStart = offset;
    offset += rLen;
    if (der[offset++] !== 0x02) throw new Error('Invalid DER: expected integer for s');
    const sLen = der[offset++];
    const sStart = offset;

    const result = new Uint8Array(componentLength * 2);
    const rBytes = der.slice(rStart, rStart + rLen);
    if (rLen > componentLength) result.set(rBytes.slice(rLen - componentLength), 0);
    else result.set(rBytes, componentLength - rLen);
    const sBytes = der.slice(sStart, sStart + sLen);
    if (sLen > componentLength) result.set(sBytes.slice(sLen - componentLength), componentLength);
    else result.set(sBytes, componentLength * 2 - sLen);
    return result;
}

// AES-GCM encrypt/decrypt for stored ABS passwords. Key comes from the
// ENCRYPTION_KEY Pages secret (64 hex chars = 32 bytes). Nonce is prepended
// to the ciphertext.
async function importKey(hexKey) {
    if (!hexKey || hexKey.length !== 64) {
        throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    }
    return crypto.subtle.importKey(
        'raw', hexToBytes(hexKey),
        { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    );
}

export async function encryptSecret(plaintext, hexKey) {
    const key = await importKey(hexKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
    ));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv); out.set(ct, iv.length);
    return bytesToBase64Url(out);
}

export async function decryptSecret(b64url, hexKey) {
    const key = await importKey(hexKey);
    const buf = base64UrlToBytes(b64url);
    const iv = buf.slice(0, 12);
    const ct = buf.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
}
