/**
 * Which browser origins may drive the panel: the TypeScript twin of `App\Domain\Widgets\Origin\OriginMatcher::matches()` for
 * entries that are already normalised (lower-case, punycode, `http://` kept, `https://` dropped), as the Blade shell inlines them
 * in `window.__PNE_EMBED__.allowedHosts`. Rules (docs/contracts/widget-config.md, "Domain whitelist entries"):
 *
 * - an entry is `host`, `host:port` or `*.host[:port]`, optionally prefixed `http://` / `https://`;
 * - no port means the scheme's default port; a port means exactly that port;
 * - a wildcard matches subdomains at any depth by label boundary, never the apex;
 * - an `http:` origin is admitted only when the entry carries the `http://` prefix or the host is a development host;
 * - `null`, userinfo, paths, backslashes, whitespace and percent escapes never match.
 */

type Scheme = 'http' | 'https';

type ParsedEntry = {
    scheme: Scheme | null;
    host: string;
    port: number | null;
    wildcard: boolean;
};

type ParsedOrigin = { scheme: Scheme; host: string; port: number | null };

const MAX_LENGTH = 260;
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function defaultPort(scheme: Scheme): number {
    return scheme === 'https' ? 443 : 80;
}

function isDevelopmentHost(host: string): boolean {
    return (
        DEV_HOSTS.has(host) ||
        host.endsWith('.localhost') ||
        host.endsWith('.test')
    );
}

/** `host`, `host:port`, `[v6]` or `[v6]:port` (no wildcard, no scheme). */
function parseAuthority(
    value: string,
): { host: string; port: number | null } | null {
    const match =
        /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i.exec(
            value,
        );

    if (match === null) {
        return null;
    }

    const port = match[2] === undefined ? null : Number(match[2]);

    if (port !== null && (port < 1 || port > 65535)) {
        return null;
    }

    return { host: match[1].toLowerCase(), port };
}

function parseOrigin(origin: string): ParsedOrigin | null {
    if (
        origin === '' ||
        origin.length > MAX_LENGTH ||
        origin.toLowerCase() === 'null'
    ) {
        return null;
    }

    const match = /^(https?):\/\/([^/?#@\\\s%\p{Cc}]+)$/iu.exec(origin);

    if (match === null) {
        return null;
    }

    const scheme = match[1].toLowerCase() as Scheme;
    const authority = parseAuthority(match[2]);

    if (authority === null) {
        return null;
    }

    return {
        scheme,
        host: authority.host,
        port: authority.port === defaultPort(scheme) ? null : authority.port,
    };
}

function parseEntry(input: string): ParsedEntry | null {
    let value = input.trim();

    if (
        value === '' ||
        value.length > MAX_LENGTH ||
        /[\s\p{Cc}\\%@?#]/u.test(value)
    ) {
        return null;
    }

    let scheme: Scheme | null = null;
    const prefix = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);

    if (prefix !== null) {
        const name = prefix[1].toLowerCase();

        if (name !== 'http' && name !== 'https') {
            return null;
        }

        scheme = name;
        value = prefix[2];
    }

    if (value.endsWith('/')) {
        value = value.slice(0, -1);
    }

    const wildcard = value.startsWith('*.');

    if (wildcard) {
        value = value.slice(2);
    }

    const authority = parseAuthority(value);

    if (authority === null || (wildcard && authority.host.startsWith('['))) {
        return null;
    }

    return { scheme, wildcard, ...authority };
}

function covers(entry: ParsedEntry, origin: ParsedOrigin): boolean {
    if (
        origin.scheme === 'http' &&
        entry.scheme !== 'http' &&
        !isDevelopmentHost(origin.host)
    ) {
        return false;
    }

    const originPort = origin.port ?? defaultPort(origin.scheme);
    const entryPort = entry.port ?? defaultPort(origin.scheme);

    if (originPort !== entryPort) {
        return false;
    }

    return entry.wildcard
        ? origin.host.endsWith(`.${entry.host}`)
        : origin.host === entry.host;
}

/** Whether `origin` (an `event.origin`) is covered by one of the whitelist entries. */
export function originMatches(
    origin: string,
    entries: readonly string[],
): boolean {
    const parsed = parseOrigin(origin);

    if (parsed === null) {
        return false;
    }

    return entries.some((entry) => {
        const candidate = parseEntry(entry);

        return candidate !== null && covers(candidate, parsed);
    });
}

/** The bare origin (`scheme://host[:port]`) of a URL such as `document.referrer`, or `null`. */
export function originOf(url: string | null | undefined): string | null {
    if (url === null || url === undefined || url === '') {
        return null;
    }

    try {
        const { origin } = new URL(url);

        return origin === 'null' ? null : origin;
    } catch {
        return null;
    }
}
