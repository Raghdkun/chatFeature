const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function randomValues(length: number): Uint8Array {
    const bytes = new Uint8Array(length);

    if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
        crypto.getRandomValues(bytes);

        return bytes;
    }

    for (let i = 0; i < length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
    }

    return bytes;
}

/**
 * A ULID (26 characters of Crockford base32: 48 bits of time, 80 bits of randomness), the `client_msg_id` of an optimistic
 * message. It has to be a real ULID because the server validates the format and uses it for idempotent replays. LOWER case, like every
 * id the server sends: the lists compare ids as strings (an upper-case client id sorts before every lower-case server id).
 */
export function newClientMsgId(
    nowMs: number = Date.now(),
    random: (length: number) => Uint8Array = randomValues,
): string {
    let time = '';
    let remaining = Math.floor(nowMs);

    for (let i = 0; i < 10; i++) {
        time = ALPHABET[remaining % 32] + time;
        remaining = Math.floor(remaining / 32);
    }

    const bytes = random(16);
    let tail = '';

    for (let i = 0; i < 16; i++) {
        tail += ALPHABET[bytes[i] % 32];
    }

    return time + tail;
}
