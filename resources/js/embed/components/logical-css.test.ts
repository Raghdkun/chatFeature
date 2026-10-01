import { describe, expect, it } from 'vite-plus/test';

const sources = import.meta.glob<string>(['/resources/js/embed/**/*.tsx', '!/resources/js/embed/**/*.test.tsx'], {
    query: '?raw',
    import: 'default',
    eager: true,
});
const css = import.meta.glob<string>('/resources/js/embed/embed.css', { query: '?raw', import: 'default', eager: true });

/** Physical-direction Tailwind utilities that would not flip for right-to-left locales. */
const PHYSICAL_UTILITY = /(?<![\w-])(?:-?(?:ml|mr|pl|pr|left|right)-(?:\d|\[|px|auto|full)|border-[lr](?:-|\s|"|')|rounded-(?:l|r|tl|tr|bl|br)(?:-|\s|"|')|text-(?:left|right)(?![\w-])|float-(?:left|right)|scroll-(?:ml|mr|pl|pr)-|space-x-|divide-x(?![\w-]))/;

describe('RTL safety (logical CSS only)', () => {
    it('the guard really catches physical utilities (and lets logical ones through)', () => {
        for (const bad of ['className="ml-2"', 'className="flex pl-4"', 'className="-mr-1"', 'className="text-left"', 'className="rounded-l-md"', 'className="border-r"', 'className="left-0"', 'className="space-x-2"']) {
            expect(PHYSICAL_UTILITY.test(bad), bad).toBe(true);
        }

        for (const good of ['className="ms-2 me-1 ps-3 pe-3 text-start end-0 start-0"', 'className="rounded-ee-sm rounded-es-sm border-s"', 'className="overflow-hidden mt-2 pt-3 px-4 inset-x-0"', 'className="self-start"']) {
            expect(PHYSICAL_UTILITY.test(good), good).toBe(false);
        }
    });

    it('scans the panel components', () => {
        expect(Object.keys(sources).length).toBeGreaterThan(15);
    });

    it('uses no physical-direction utilities in any component', () => {
        const offenders: string[] = [];

        for (const [path, source] of Object.entries(sources)) {
            for (const [index, line] of source.split('\n').entries()) {
                if (PHYSICAL_UTILITY.test(line)) {
                    offenders.push(`${path.split('/').pop()}:${index + 1}: ${line.trim()}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('uses no physical properties in the stylesheet', () => {
        const stylesheet = Object.values(css)[0];
        const physical = /(?:margin|padding)-(?:left|right)\s*:|(?<![\w-])(?:left|right)\s*:|border-(?:left|right)\b|text-align\s*:\s*(?:left|right)|(?:width|height)\s*:\s*\d/;
        const offenders = stylesheet
            .split('\n')
            .map((line, index) => ({ line: line.trim(), index }))
            .filter(({ line }) => physical.test(line) && !line.startsWith('/*') && !line.startsWith('*'));

        // `translateX` would also be physical
        expect(stylesheet).not.toMatch(/translateX|rotateY/);
        expect(offenders.map((o) => `${o.index + 1}: ${o.line}`)).toEqual([]);
    });
});
