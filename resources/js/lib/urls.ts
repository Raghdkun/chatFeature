/** Only plain web links may be rendered as external `href`s (blocks `javascript:` etc.). */
export function safeExternalUrl(
    value: string | null | undefined,
): string | null {
    if (!value) {
        return null;
    }

    try {
        const url = new URL(value);

        return url.protocol === 'https:' || url.protocol === 'http:'
            ? url.toString()
            : null;
    } catch {
        return null;
    }
}
