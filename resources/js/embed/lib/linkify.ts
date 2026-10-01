/**
 * Turns visitor-facing plain text into text and link segments. Messages are never HTML: React renders `text` segments as text and
 * `link` segments as `<a rel="noopener noreferrer nofollow">`. Only `http:` / `https:` URLs without credentials become links
 * (`javascript:`, `data:` and `user:pass@host` never do).
 */
export type Segment =
    | { type: 'text'; text: string }
    | { type: 'link'; text: string; href: string };

const URL_LIKE = /(?:https?:\/\/|www\.)[^\s<>"'`\p{Cc}]+/giu;
const TRAILING = /[.,;:!?'"’”\]}>]+$/;
const MAX_LINK = 2000;

function trim(candidate: string): string {
    let url = candidate;

    for (;;) {
        const stripped = url.replace(TRAILING, '');

        if (stripped !== url) {
            url = stripped;

            continue;
        }

        // A closing parenthesis belongs to the URL only when it opens one inside it.
        if (url.endsWith(')') && count(url, ')') > count(url, '(')) {
            url = url.slice(0, -1);

            continue;
        }

        return url;
    }
}

function count(value: string, char: string): number {
    return value.split(char).length - 1;
}

/** `https://...` for a URL we are willing to link, else `null`. */
export function safeHref(candidate: string): string | null {
    if (candidate.length > MAX_LINK) {
        return null;
    }

    const absolute = /^www\./i.test(candidate)
        ? `https://${candidate}`
        : candidate;

    try {
        const url = new URL(absolute);

        if (
            (url.protocol !== 'http:' && url.protocol !== 'https:') ||
            url.username !== '' ||
            url.password !== '' ||
            url.hostname === '' ||
            (!url.hostname.includes('.') && url.hostname !== 'localhost')
        ) {
            return null;
        }

        return url.href;
    } catch {
        return null;
    }
}

export function linkify(text: string): Segment[] {
    const segments: Segment[] = [];
    let last = 0;

    for (const match of text.matchAll(URL_LIKE)) {
        const start = match.index ?? 0;
        const raw = match[0];
        const url = trim(raw);
        const href = safeHref(url);

        if (href === null) {
            continue;
        }

        if (start > last) {
            segments.push({ type: 'text', text: text.slice(last, start) });
        }

        segments.push({ type: 'link', text: url, href });
        last = start + url.length;
    }

    if (last < text.length) {
        segments.push({ type: 'text', text: text.slice(last) });
    }

    return segments.length === 0 ? [{ type: 'text', text }] : segments;
}
