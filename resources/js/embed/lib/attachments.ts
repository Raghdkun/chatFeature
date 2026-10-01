/** Client-side checks for an image the visitor wants to send (the server re-checks everything and wins). */
export const ALLOWED_IMAGE_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
] as const;

/** Default `chat.attachment_max_bytes`. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
};

export type Precheck = { ok: true } | { ok: false; reason: 'type' | 'size' };

function mimeOf(file: Pick<File, 'type' | 'name'>): string {
    if (file.type !== '') {
        return file.type.toLowerCase();
    }

    // Some browsers leave `type` empty for pasted or dropped files: fall back to the extension.
    return EXTENSIONS[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? '';
}

export function precheckImage(
    file: Pick<File, 'type' | 'name' | 'size'>,
    maxBytes: number = MAX_ATTACHMENT_BYTES,
): Precheck {
    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mimeOf(file))) {
        return { ok: false, reason: 'type' };
    }

    return file.size > maxBytes ? { ok: false, reason: 'size' } : { ok: true };
}
