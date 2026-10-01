import { describe, expect, it } from 'vite-plus/test';
import { originMatches, originOf } from '@/embed/protocol/origin';

/** The cases of `tests/Unit/Widgets/OriginMatcherTest.php` that apply to already-normalised entries and browser origins. */
const CASES: [string, string[], string, boolean][] = [
    ['exact https', ['example.com'], 'https://example.com', true],
    [
        'a bare entry admits https only',
        ['example.com'],
        'http://example.com',
        false,
    ],
    ['exact is case-insensitive', ['example.com'], 'https://EXAMPLE.com', true],
    ['entry is case-insensitive', ['Example.COM'], 'https://example.com', true],
    ['explicit default port', ['example.com'], 'https://example.com:443', true],
    [
        'explicit default http port, still plain http',
        ['example.com'],
        'http://example.com:80',
        false,
    ],
    [
        'other port without entry port',
        ['example.com'],
        'https://example.com:8443',
        false,
    ],
    [
        'subdomain of exact entry',
        ['example.com'],
        'https://www.example.com',
        false,
    ],
    ['suffix trick', ['example.com'], 'https://example.com.evil.com', false],
    ['prefix look-alike', ['example.com'], 'https://evil-example.com', false],
    ['glued look-alike', ['example.com'], 'https://evilexample.com', false],
    ['cyrillic homograph', ['example.com'], 'https://exаmple.com', false],
    ['wildcard one label', ['*.example.com'], 'https://a.example.com', true],
    [
        'wildcard many labels',
        ['*.example.com'],
        'https://a.b.example.com',
        true,
    ],
    [
        'wildcard never matches the apex',
        ['*.example.com'],
        'https://example.com',
        false,
    ],
    [
        'wildcard hyphen look-alike',
        ['*.example.com'],
        'https://evil-example.com',
        false,
    ],
    [
        'wildcard glued look-alike',
        ['*.example.com'],
        'https://xexample.com',
        false,
    ],
    [
        'wildcard suffix trick',
        ['*.example.com'],
        'https://a.example.com.evil.com',
        false,
    ],
    ['wildcard empty label', ['*.example.com'], 'https://.example.com', false],
    [
        'wildcard other port',
        ['*.example.com'],
        'https://a.example.com:8443',
        false,
    ],
    [
        'wildcard with port',
        ['*.example.com:8443'],
        'https://a.example.com:8443',
        true,
    ],
    [
        'wildcard with port, default port used',
        ['*.example.com:8443'],
        'https://a.example.com',
        false,
    ],
    ['port entry matches', ['localhost:3000'], 'http://localhost:3000', true],
    [
        'port entry vs default port',
        ['localhost:3000'],
        'http://localhost',
        false,
    ],
    [
        'port entry vs other port',
        ['localhost:3000'],
        'http://localhost:3001',
        false,
    ],
    [
        'port entry equal to the default port',
        ['example.com:443'],
        'https://example.com',
        true,
    ],
    [
        'punycode origin',
        ['xn--mnchen-3ya.de'],
        'https://xn--mnchen-3ya.de',
        true,
    ],
    [
        'punycode wildcard',
        ['*.xn--bcher-kva.example'],
        'https://shop.xn--bcher-kva.example',
        true,
    ],
    ['ipv6', ['[::1]:3000'], 'http://[::1]:3000', true],
    ['ipv4', ['127.0.0.1:8000'], 'http://127.0.0.1:8000', true],
    [
        'http entry admits plain http',
        ['http://example.com'],
        'http://example.com',
        true,
    ],
    [
        'http entry admits https too',
        ['http://example.com'],
        'https://example.com',
        true,
    ],
    [
        'http entry, explicit default http port',
        ['http://example.com'],
        'http://example.com:80',
        true,
    ],
    [
        'http entry never widens the host',
        ['http://example.com'],
        'http://www.example.com',
        false,
    ],
    [
        'http entry never widens the port',
        ['http://example.com'],
        'http://example.com:8080',
        false,
    ],
    [
        'http entry with port',
        ['http://example.com:8080'],
        'http://example.com:8080',
        true,
    ],
    [
        'http entry with port, default port used',
        ['http://example.com:8080'],
        'http://example.com',
        false,
    ],
    [
        'http wildcard entry',
        ['http://*.example.com'],
        'http://a.b.example.com',
        true,
    ],
    [
        'http wildcard never matches the apex',
        ['http://*.example.com'],
        'http://example.com',
        false,
    ],
    [
        'https prefix is the default: no plain http',
        ['https://example.com'],
        'http://example.com',
        false,
    ],
    [
        'plain http to a bare wildcard entry is refused',
        ['*.example.com'],
        'http://a.example.com',
        false,
    ],
    [
        'a second entry with the prefix admits only its own host',
        ['example.com', 'http://other.com'],
        'http://example.com',
        false,
    ],
    ['localhost over plain http', ['localhost'], 'http://localhost', true],
    ['localhost over https', ['localhost'], 'https://localhost', true],
    ['loopback ipv4 over plain http', ['127.0.0.1'], 'http://127.0.0.1', true],
    ['loopback ipv6 over plain http', ['[::1]'], 'http://[::1]', true],
    [
        'a .localhost sub-domain over plain http',
        ['app.localhost'],
        'http://app.localhost',
        true,
    ],
    ['a .test host over plain http', ['shop.test'], 'http://shop.test', true],
    [
        'a .test host under a wildcard over plain http',
        ['*.shop.test'],
        'http://eu.shop.test',
        true,
    ],
    [
        'other private ips are not development hosts',
        ['192.168.1.5'],
        'http://192.168.1.5',
        false,
    ],
    [
        'a name that merely contains localhost is not a development host',
        ['localhost.evil.com'],
        'http://localhost.evil.com',
        false,
    ],
    [
        'a name that merely ends in test is not a development host',
        ['mytest.com'],
        'http://mytest.com',
        false,
    ],
    ['null origin', ['example.com'], 'null', false],
    ['NULL origin, any case', ['example.com'], 'NULL', false],
    ['empty origin', ['example.com'], '', false],
    [
        'userinfo before the host',
        ['example.com'],
        'https://evil.com@example.com',
        false,
    ],
    [
        'userinfo after the host',
        ['example.com'],
        'https://example.com@evil.com',
        false,
    ],
    [
        'userinfo with colon',
        ['example.com'],
        'https://example.com:pw@evil.com',
        false,
    ],
    ['trailing slash', ['example.com'], 'https://example.com/', false],
    ['path', ['example.com'], 'https://example.com/path', false],
    ['query', ['example.com'], 'https://example.com?x', false],
    [
        'backslash trick',
        ['example.com'],
        'https://example.com\\@evil.com',
        false,
    ],
    [
        'percent-encoded dot',
        ['example.com'],
        'https://example.com%2eevil.com',
        false,
    ],
    ['no scheme', ['example.com'], 'example.com', false],
    ['ftp scheme', ['example.com'], 'ftp://example.com', false],
    ['javascript scheme', ['example.com'], 'javascript://example.com', false],
    ['control characters', ['example.com'], 'https://example.com\n', false],
    ['whitespace', ['example.com'], 'https://example.com ', false],
    ['no entries', [], 'https://example.com', false],
    [
        'second entry matches',
        ['a.com', 'example.com'],
        'https://example.com',
        true,
    ],
    [
        'invalid entries are skipped',
        ['*.com.', 'bad entry', 'example.com'],
        'https://example.com',
        true,
    ],
    [
        'only invalid entries',
        ['https://u@example.com', 'ftp://example.com'],
        'https://example.com',
        false,
    ],
    [
        'a port out of range never matches',
        ['example.com:99999'],
        'https://example.com:99999',
        false,
    ],
];

describe('originMatches', () => {
    it.each(CASES)('%s', (_name, entries, origin, expected) => {
        expect(originMatches(origin, entries)).toBe(expected);
    });
});

describe('originOf', () => {
    it('reads the origin of a referrer URL', () => {
        expect(originOf('https://example.com/some/page?x=1#y')).toBe(
            'https://example.com',
        );
        expect(originOf('http://localhost:3000/')).toBe(
            'http://localhost:3000',
        );
        expect(originOf('/relative/path')).toBeNull();
        expect(originOf(null)).toBeNull();
        expect(originOf(undefined)).toBeNull();
        expect(originOf('')).toBeNull();
        expect(originOf('about:blank')).toBeNull();
    });
});
