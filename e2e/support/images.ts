/**
 * Test images without a single dependency: the browser draws JPEG / PNG / WebP (a canvas, `toBlob`), the byte strings of a valid
 * still GIF, an ANIMATED GIF (two frames; the product refuses those), an SVG and a few disguised files are built by hand.
 * `file()` is the shape `locator.setInputFiles()` and the multipart upload of `VisitorApi.upload()` take.
 */
import type { Page } from '@playwright/test';

export type UploadFile = { name: string; mimeType: string; buffer: Buffer };

export type RasterType = 'image/jpeg' | 'image/png' | 'image/webp';

const EXTENSION: Record<RasterType, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
};

/** A real picture of `width` x `height` (a gradient with a few shapes) encoded by Chrome. */
export async function rasterImage(
    page: Page,
    type: RasterType,
    width = 800,
    height = 600,
    name?: string,
): Promise<UploadFile> {
    const base64 = await page.evaluate(
        async ([mime, w, h]) => {
            const canvas = document.createElement('canvas');

            canvas.width = w as number;
            canvas.height = h as number;

            const context = canvas.getContext('2d')!;
            const gradient = context.createLinearGradient(
                0,
                0,
                w as number,
                h as number,
            );

            gradient.addColorStop(0, '#2563eb');
            gradient.addColorStop(1, '#f59e0b');
            context.fillStyle = gradient;
            context.fillRect(0, 0, w as number, h as number);
            context.fillStyle = '#ffffff';
            context.beginPath();
            context.arc(
                (w as number) / 2,
                (h as number) / 2,
                Math.min(w as number, h as number) / 4,
                0,
                Math.PI * 2,
            );
            context.fill();

            const blob: Blob = await new Promise((resolve) =>
                canvas.toBlob(
                    (result) => resolve(result!),
                    mime as string,
                    0.9,
                ),
            );
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = '';

            for (let index = 0; index < bytes.length; index += 0x8000) {
                binary += String.fromCharCode(
                    ...bytes.subarray(index, index + 0x8000),
                );
            }

            return btoa(binary);
        },
        [type, width, height] as const,
    );

    return {
        name: name ?? `picture-${width}x${height}.${EXTENSION[type]}`,
        mimeType: type,
        buffer: Buffer.from(base64, 'base64'),
    };
}

// A valid 1x1 GIF: header + logical screen + two-colour table, then one frame (graphic control, image descriptor, data).
const GIF_HEADER = Buffer.from(
    '47494638396101000100800000' + '000000ffffff',
    'hex',
);
const GIF_FRAME = Buffer.from(
    '21f9040100000000' + '2c000000000100010000' + '0202440100',
    'hex',
);

/** A still GIF (one frame): allowed. */
export function stillGif(name = 'still.gif'): UploadFile {
    return {
        name,
        mimeType: 'image/gif',
        buffer: Buffer.concat([
            GIF_HEADER,
            GIF_FRAME,
            Buffer.from('3b', 'hex'),
        ]),
    };
}

/** An animated GIF (two frames): refused by the server, a chat image is a still. */
export function animatedGif(name = 'animated.gif'): UploadFile {
    return {
        name,
        mimeType: 'image/gif',
        buffer: Buffer.concat([
            GIF_HEADER,
            GIF_FRAME,
            GIF_FRAME,
            Buffer.from('3b', 'hex'),
        ]),
    };
}

/** An SVG with a script in it: refused by the client (type) and by the server (content). */
export function svg(name = 'logo.svg', mimeType = 'image/svg+xml'): UploadFile {
    return {
        name,
        mimeType,
        buffer: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
        ),
    };
}

/** An HTML page named and declared as a PNG: passes the client precheck, the server judges the content and refuses it. */
export function htmlAsPng(name = 'invoice.png'): UploadFile {
    return {
        name,
        mimeType: 'image/png',
        buffer: Buffer.from(
            '<!doctype html><html><body><script>alert(1)</script></body></html>',
        ),
    };
}

/** Bytes that are not a picture, named and declared as a JPEG. */
export function garbageAsJpeg(name = 'holiday.jpg'): UploadFile {
    return {
        name,
        mimeType: 'image/jpeg',
        buffer: Buffer.from(
            'this is not an image at all, only text pretending to be one',
        ),
    };
}

/** A file of `bytes` bytes that claims to be a PNG (the PNG signature, then zeros): over the size limit it is refused before any decoding. */
export function oversizedPng(bytes: number, name = 'huge.png'): UploadFile {
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');

    return {
        name,
        mimeType: 'image/png',
        buffer: Buffer.concat([
            signature,
            Buffer.alloc(Math.max(0, bytes - signature.length)),
        ]),
    };
}
