// Minimal CBOR decoder for WebAuthn attestation objects. Implements only the
// major types that show up in CTAP2 / WebAuthn payloads (uint, negint, byte
// string, text string, array, map, simple values). No external deps — npm
// packages like @simplewebauthn/server use Node Buffer internally and break
// on Workers/Pages runtime.

export function decodeCBOR(buffer) {
    let offset = 0;

    function readByte() { return buffer[offset++]; }
    function readBytes(n) {
        const slice = buffer.slice(offset, offset + n);
        offset += n;
        return slice;
    }
    function readUint16() {
        const val = (buffer[offset] << 8) | buffer[offset + 1];
        offset += 2;
        return val;
    }
    function readUint32() {
        const val = (buffer[offset] << 24) | (buffer[offset + 1] << 16) |
                    (buffer[offset + 2] << 8) | buffer[offset + 3];
        offset += 4;
        return val >>> 0;
    }
    function readArgument(additional) {
        if (additional < 24) return additional;
        if (additional === 24) return readByte();
        if (additional === 25) return readUint16();
        if (additional === 26) return readUint32();
        throw new Error(`CBOR: unsupported additional info ${additional}`);
    }
    function decode() {
        const initial = readByte();
        const major = initial >> 5;
        const additional = initial & 0x1f;
        switch (major) {
            case 0: return readArgument(additional);
            case 1: return -1 - readArgument(additional);
            case 2: return readBytes(readArgument(additional));
            case 3: return new TextDecoder().decode(readBytes(readArgument(additional)));
            case 4: {
                const arr = [];
                for (let i = 0, len = readArgument(additional); i < len; i++) arr.push(decode());
                return arr;
            }
            case 5: {
                const map = {};
                for (let i = 0, len = readArgument(additional); i < len; i++) {
                    map[decode()] = decode();
                }
                return map;
            }
            case 7:
                if (additional === 20) return false;
                if (additional === 21) return true;
                if (additional === 22) return null;
                throw new Error(`CBOR: unsupported special ${additional}`);
            default:
                throw new Error(`CBOR: unsupported major type ${major}`);
        }
    }
    return decode();
}
