/**
 * Small pure helpers about addresses the WhatsApp settings deal with. No network, no DNS: only what can be told from the text.
 */

/**
 * Whether an OpenWA address points at the machine itself or a private network (`localhost`, loopback, RFC 1918, link-local, `*.local` /
 * `*.internal`, a single-label Docker service name such as `openwa`). The server refuses such an address unless
 * `PORTAL_ALLOW_PRIVATE_HOSTS` (or local development) allows it, so the page says so before the test does.
 */
export function isPrivateAddress(value: string): boolean {
    let host: string;

    try {
        host = new URL(value.trim()).hostname.toLowerCase();
    } catch {
        return false;
    }

    if (host === '') {
        return false;
    }

    host = host.replace(/^\[|\]$/g, '');

    if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) {
        return true;
    }

    if (host.endsWith('.local') || host.endsWith('.internal')) {
        return true;
    }

    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];

        return (
            a === 10 ||
            a === 127 ||
            a === 0 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)
        );
    }

    if (host.includes(':')) {
        // IPv6: loopback is handled above; unique-local (fc00::/7) and link-local (fe80::/10).
        return /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host);
    }

    // A single label (a Docker service name): no dot, so no public DNS name.
    return !host.includes('.');
}

/** A `wa.me` link as the hand-off builds it: `https://wa.me/<digits>?text=<url-encoded text>`; digits only from the number. */
export function waMeUrl(phone: string | null, text: string): string | null {
    const digits = (phone ?? '').replace(/\D/g, '');

    return digits === ''
        ? null
        : `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** The hand-off text with the code filled in (`:code` -> the code), as the visitor's message will read. */
export function handoffPreview(template: string, code: string): string {
    return template.replaceAll(':code', code);
}
