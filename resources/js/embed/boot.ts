/** `window.__PNE_EMBED__`, inlined by the Blade shell (`resources/views/embed.blade.php`). Never contains secrets. */
export type EmbedBoot = {
    key: string;
    appOrigin: string;
    /** The widget's domain whitelist (normalised entries), for the panel's own origin check. */
    allowedHosts: string[];
    preview: boolean;
    mode: 'launcher' | 'inline' | 'hosted';
};

export function readEmbedBoot(raw: unknown): EmbedBoot | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }

    const value = raw as Record<string, unknown>;

    if (
        typeof value.key !== 'string' ||
        typeof value.appOrigin !== 'string' ||
        value.key === ''
    ) {
        return null;
    }

    return {
        key: value.key,
        appOrigin: value.appOrigin,
        allowedHosts: Array.isArray(value.allowedHosts)
            ? value.allowedHosts.filter(
                  (host): host is string => typeof host === 'string',
              )
            : [],
        preview: value.preview === true,
        mode:
            value.mode === 'inline' || value.mode === 'hosted'
                ? value.mode
                : 'launcher',
    };
}

declare global {
    interface Window {
        __PNE_EMBED__?: unknown;
    }
}
