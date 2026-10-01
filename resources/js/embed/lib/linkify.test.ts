import { describe, expect, it } from 'vite-plus/test';
import { linkify, safeHref } from '@/embed/lib/linkify';

describe('linkify', () => {
    it('returns plain text untouched', () => {
        expect(linkify('Hello there')).toEqual([
            { type: 'text', text: 'Hello there' },
        ]);
        expect(linkify('')).toEqual([{ type: 'text', text: '' }]);
    });

    it('links http(s) URLs and bare www hosts, keeping the surrounding text', () => {
        expect(
            linkify('See https://example.com/a?b=1#c and www.example.org now'),
        ).toEqual([
            { type: 'text', text: 'See ' },
            {
                type: 'link',
                text: 'https://example.com/a?b=1#c',
                href: 'https://example.com/a?b=1#c',
            },
            { type: 'text', text: ' and ' },
            {
                type: 'link',
                text: 'www.example.org',
                href: 'https://www.example.org/',
            },
            { type: 'text', text: ' now' },
        ]);
    });

    it('does not swallow trailing punctuation, but keeps a balanced closing parenthesis', () => {
        expect(linkify('Go to https://example.com/page.')).toEqual([
            { type: 'text', text: 'Go to ' },
            {
                type: 'link',
                text: 'https://example.com/page',
                href: 'https://example.com/page',
            },
            { type: 'text', text: '.' },
        ]);
        expect(linkify('(see https://example.com/a)')).toEqual([
            { type: 'text', text: '(see ' },
            {
                type: 'link',
                text: 'https://example.com/a',
                href: 'https://example.com/a',
            },
            { type: 'text', text: ')' },
        ]);
        expect(
            linkify('https://en.wikipedia.org/wiki/Foo_(bar)')[0],
        ).toMatchObject({
            type: 'link',
            text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
        });
        expect(linkify('Really? https://example.com!')[1]).toMatchObject({
            text: 'https://example.com',
        });
    });

    it('never links dangerous or credentialed URLs', () => {
        for (const text of [
            'javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'vbscript:msgbox',
            'ftp://example.com/file',
            'https://user:pass@example.com/',
            'https://user@example.com/',
            'http://localhost',
        ]) {
            const hasLink = linkify(text).some(
                (segment) => segment.type === 'link',
            );

            expect(hasLink, text).toBe(text === 'http://localhost');
        }
    });

    it('treats markup as plain text: no HTML ever reaches a segment as a link', () => {
        const segments = linkify(
            '<img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>',
        );

        expect(segments.every((segment) => segment.type === 'text')).toBe(true);
    });

    it('refuses absurdly long URLs', () => {
        expect(
            linkify(`https://example.com/${'a'.repeat(2100)}`).some(
                (s) => s.type === 'link',
            ),
        ).toBe(false);
    });

    it('safeHref normalises or refuses', () => {
        expect(safeHref('www.example.com')).toBe('https://www.example.com/');
        expect(safeHref('https://example.com')).toBe('https://example.com/');
        expect(safeHref('javascript:alert(1)')).toBeNull();
        expect(safeHref('not a url')).toBeNull();
        expect(safeHref('https://nodot')).toBeNull();
    });
});
