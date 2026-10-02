import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { resetGlobals } from './helpers';

/** Runs the built IIFE in the jsdom window, the way a <script> tag would. */
function runBundle(): void {
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function(code)();
}

/** Same budget as .size-limit.json (`npm run size`): the loader must stay tiny on every host page. */
const BUDGET_BYTES = 18_000;
/** First line of the bundle (vite.widget.config.ts `postBanner`). */
const MARKER = '/*! pne-chat-loader v1 */';

let code = '';

beforeAll(async () => {
    // Build the real production bundle in memory with the widget config (no files are written).
    const out = (await build({
        configFile: 'vite.widget.config.ts',
        logLevel: 'silent',
        build: { write: false },
    })) as { output: { type: string; fileName: string; code?: string }[] };
    const chunks = out.output.filter((o) => o.type === 'chunk');

    expect(chunks.map((c) => c.fileName)).toEqual(['loader.js']);
    code = chunks[0].code ?? '';
}, 60_000);

afterEach(() => {
    vi.restoreAllMocks();
    resetGlobals();
});

describe('production bundle (vite.widget.config.ts)', () => {
    it(`is a single IIFE of at most ${BUDGET_BYTES} bytes gzipped`, () => {
        const gz = gzipSync(code, { level: 9 }).length;
        console.info(
            `widget loader: ${code.length} B raw, ${gz} B gzip (budget ${BUDGET_BYTES})`,
        );

        expect(gz).toBeLessThanOrEqual(BUDGET_BYTES);
        expect(code.startsWith(`${MARKER}\n(function(){`)).toBe(true);
        expect(code.trimEnd().endsWith('})();')).toBe(true);
        expect(code).not.toMatch(/^\s*(import|export)\s/m);
    });

    it('opens with the recognisable marker banner and runs in strict mode', () => {
        // The dashboard's "is the widget bundle built?" probe fetches /widget/v1/loader.js and looks for this;
        // the server's "bundle not built" stub contains it nowhere.
        expect(code.startsWith(MARKER)).toBe(true);
        expect(code).toContain('(function(){"use strict";');
        expect(code.split(MARKER)).toHaveLength(2);
    });

    it('matches the .size-limit.json budget', () => {
        const [entry] = JSON.parse(
            readFileSync('.size-limit.json', 'utf8'),
        ) as { limit: string; path: string; gzip: boolean }[];
        expect(entry.path).toBe('public/widget/v1/loader.js');
        expect(entry.gzip).toBe(true);
        expect(entry.limit).toBe('18 KB');
    });

    it('contains the stylesheet inline and no dangerous DOM sinks', () => {
        expect(code).toContain('.launcher');
        expect(code).toContain('data-motion');

        for (const sink of [
            'innerHTML',
            'outerHTML',
            'insertAdjacentHTML',
            'document.write',
            'eval(',
            'new Function',
            'srcdoc',
            'createContextualFragment',
        ]) {
            expect(code, `bundle uses ${sink}`).not.toContain(sink);
        }
    });

    it('has no source map reference and no embedded secrets or absolute dev paths', () => {
        expect(code).not.toContain('sourceMappingURL');
        expect(code).not.toMatch(/\/Volumes\/|\/Users\/|node_modules/);
        expect(code).not.toMatch(/(?:secret|password|api[_-]?key)\s*[:=]/i);
    });

    it('installs window.ChatFeature and no other global when executed', () => {
        const before = new Set(Object.getOwnPropertyNames(window));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        runBundle();

        const added = Object.getOwnPropertyNames(window).filter(
            (k) => !before.has(k),
        );
        expect(added).toEqual(['ChatFeature']);
        expect(
            typeof (window as unknown as { ChatFeature: unknown }).ChatFeature,
        ).toBe('function');
    });

    it('is idempotent when executed twice', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        runBundle();
        const first = (window as unknown as { ChatFeature: unknown })
            .ChatFeature;
        runBundle();
        expect(
            (window as unknown as { ChatFeature: unknown }).ChatFeature,
        ).toBe(first);
    });
});
