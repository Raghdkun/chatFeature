/**
 * Image bytes for the OpenWA mock's inbound media (`openWa.inboundImage(..., { dataBase64 })`), built without a browser.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let n = 0; n < 256; n += 1) {
        let c = n;

        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }

        table[n] = c >>> 0;
    }

    return table;
})();

function crc32(buffer: Buffer): number {
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8);
    const tail = Buffer.alloc(4);

    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);

    return Buffer.concat([head, body, tail]);
}

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** A real, small, valid PNG (`size` x `size`, a diagonal gradient). */
export function smallPng(size = 48): Buffer {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB

    const rows = Buffer.alloc(size * (size * 3 + 1));

    for (let y = 0; y < size; y += 1) {
        const at = y * (size * 3 + 1);

        for (let x = 0; x < size; x += 1) {
            rows[at + 1 + x * 3] = Math.floor((x / size) * 255);
            rows[at + 2 + x * 3] = Math.floor((y / size) * 255);
            rows[at + 3 + x * 3] = 120;
        }
    }

    return Buffer.concat([
        SIGNATURE,
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * A PNG that CLAIMS to be `width` x `height` pixels (a decompression bomb in miniature: a few hundred bytes of file, an image no server
 * should decode). Only the header is honest; the sanitizer must refuse it on the dimensions before it decodes anything.
 */
export function hugeDimensionsPng(width = 30_000, height = 30_000): Buffer {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;

    return Buffer.concat([
        SIGNATURE,
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.alloc(64))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

export const asBase64 = (bytes: Buffer | string): string =>
    Buffer.from(bytes).toString('base64');
