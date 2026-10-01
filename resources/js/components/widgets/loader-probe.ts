/**
 * Is the real widget loader available for the live preview?
 *
 * `GET /widget/v1/loader.js` answers HTTP 200 even when `npm run build:widget` has not run: the
 * server then serves a stub (a comment and a `console.warn`) so the rest of the stack keeps working.
 * A status check alone would therefore start the live view against a stub that never boots a widget.
 * The built bundle announces itself with a first line comment, `// pne-chat-loader`; anything else
 * (the stub, an HTML error page, an empty body) means "not built" and the static approximation takes
 * over.
 */

/** First line of the real bundle (tolerates a BOM, leading whitespace and a `/*!` banner). */
export const LOADER_MARKER = /^﻿?\s*(?:\/\/|\/\*!?)\s*pne-chat-loader\b/;

/** How much of the answer is looked at: the marker is the very first line. */
const HEAD_BYTES = 256;

/** `true` when `head` (the beginning of the loader response body) is the real bundle. */
export function isBuiltLoader(head: string): boolean {
    return LOADER_MARKER.test(head);
}

async function readHead(response: Response): Promise<string> {
    const reader = response.body?.getReader();

    if (!reader) {
        return (await response.text()).slice(0, HEAD_BYTES);
    }

    const decoder = new TextDecoder();
    let text = '';

    while (text.length < HEAD_BYTES) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        text += decoder.decode(value, { stream: true });
    }

    // The bundle is large and only its first bytes matter: stop the transfer.
    void reader.cancel().catch(() => undefined);

    return text.slice(0, HEAD_BYTES);
}

/**
 * Fetches the start of the loader (no cookies) and says whether it is the built bundle. Any failure
 * (network, abort, non-200, stub) is `false`: the caller then shows the approximation.
 */
export async function probeLoader(
    url: string,
    signal?: AbortSignal,
): Promise<boolean> {
    try {
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'omit',
            signal,
        });

        if (!response.ok) {
            return false;
        }

        return isBuiltLoader(await readHead(response));
    } catch {
        return false;
    }
}
