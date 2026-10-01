import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { isBuiltLoader, probeLoader } from '@/components/widgets/loader-probe';

afterEach(() => {
    vi.unstubAllGlobals();
});

const reply = (body: string, status = 200) =>
    vi.fn().mockResolvedValue(new Response(body, { status }));

describe('isBuiltLoader', () => {
    it('recognises the marker line of the real bundle', () => {
        expect(isBuiltLoader('// pne-chat-loader\n(function(){})()')).toBe(
            true,
        );
        expect(isBuiltLoader('// pne-chat-loader v1.2.0\n')).toBe(true);
        expect(isBuiltLoader('/*! pne-chat-loader */\n(function(){})()')).toBe(
            true,
        );
        // Tolerates a BOM and leading whitespace.
        expect(isBuiltLoader('﻿\n  // pne-chat-loader\n')).toBe(true);
    });

    it('rejects the stub the server serves while the bundle is not built, and anything else', () => {
        expect(
            isBuiltLoader(
                '/* PNE Chat widget loader bundle not built: run `npm run build:widget`. */\nwindow.console&&console.warn&&console.warn("[PNE Chat] missing");',
            ),
        ).toBe(false);
        expect(isBuiltLoader('window.console.warn("x")')).toBe(false);
        expect(isBuiltLoader('<!doctype html>')).toBe(false);
        expect(isBuiltLoader('')).toBe(false);
        // The marker has to be the first thing, not buried in the code.
        expect(isBuiltLoader('var a=1; // pne-chat-loader')).toBe(false);
    });
});

describe('probeLoader', () => {
    it('is true for HTTP 200 with the marker, fetched without cookies', async () => {
        const fetchMock = reply('// pne-chat-loader\n(function(){})()');

        vi.stubGlobal('fetch', fetchMock);

        await expect(probeLoader('/widget/v1/loader.js')).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledWith('/widget/v1/loader.js', {
            method: 'GET',
            credentials: 'omit',
            signal: undefined,
        });
    });

    it('is false for the stub, a non-200, an empty body and a network error', async () => {
        vi.stubGlobal('fetch', reply('/* not built */\nconsole.warn(1)'));
        await expect(probeLoader('/x')).resolves.toBe(false);

        vi.stubGlobal('fetch', reply('// pne-chat-loader\n', 404));
        await expect(probeLoader('/x')).resolves.toBe(false);

        vi.stubGlobal('fetch', reply(''));
        await expect(probeLoader('/x')).resolves.toBe(false);

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('off')));
        await expect(probeLoader('/x')).resolves.toBe(false);
    });

    it('only needs the start of a large bundle and stops the transfer', async () => {
        let cancelled = false;
        const chunk = new TextEncoder().encode(
            `// pne-chat-loader\n${'x'.repeat(10_000)}`,
        );
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(chunk);
            },
            cancel() {
                cancelled = true;
            },
        });

        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
        );

        await expect(probeLoader('/x')).resolves.toBe(true);
        expect(cancelled).toBe(true);
    });

    it('is false when aborted', async () => {
        const controller = new AbortController();

        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValue(new DOMException('x', 'AbortError')),
        );
        controller.abort();

        await expect(probeLoader('/x', controller.signal)).resolves.toBe(false);
    });
});
