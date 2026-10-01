/** A client-side ULID (26 Crockford base32 characters: 48-bit time + 80 random bits) for `client_msg_id`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);

    if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    return bytes;
}

export function newUlid(now: number = Date.now()): string {
    let time = '';
    let remaining = Math.max(0, Math.floor(now));

    for (let i = 0; i < 10; i++) {
        time = ALPHABET[remaining % 32] + time;
        remaining = Math.floor(remaining / 32);
    }

    let random = '';

    for (const byte of randomBytes(16)) {
        random += ALPHABET[byte % 32];
    }

    return time + random.slice(0, 16);
}
