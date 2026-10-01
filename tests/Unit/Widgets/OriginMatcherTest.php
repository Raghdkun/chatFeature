<?php

namespace Tests\Unit\Widgets;

use App\Domain\Widgets\Origin\OriginMatcher;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class OriginMatcherTest extends TestCase
{
    private OriginMatcher $matcher;

    protected function setUp(): void
    {
        parent::setUp();

        $this->matcher = new OriginMatcher;
    }

    /**
     * @return array<string, array{0: string, 1: string}>
     */
    public static function normalisedEntries(): array
    {
        return [
            'lower-cased' => ['Example.COM', 'example.com'],
            'scheme and trailing slash dropped' => ['https://example.com/', 'example.com'],
            'default http port dropped' => ['http://example.com:80', 'example.com'],
            'default https port dropped' => ['https://example.com:443/', 'example.com'],
            'explicit port kept' => ['https://example.com:8443', 'example.com:8443'],
            'wildcard' => ['*.Example.com', '*.example.com'],
            'wildcard with port' => ['*.example.com:8443', '*.example.com:8443'],
            'localhost with port' => ['localhost:3000', 'localhost:3000'],
            'punycode' => ['münchen.de', 'xn--mnchen-3ya.de'],
            'punycode wildcard' => ['*.bücher.example', '*.xn--bcher-kva.example'],
            'already punycode' => ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de'],
            'ipv4' => ['127.0.0.1', '127.0.0.1'],
            'ipv6' => ['[::1]:3000', '[::1]:3000'],
            'trailing dot' => ['example.com.', 'example.com'],
            'surrounding whitespace' => ['  example.com  ', 'example.com'],
        ];
    }

    #[DataProvider('normalisedEntries')]
    public function test_entries_are_normalised(string $input, string $expected): void
    {
        $this->assertSame($expected, $this->matcher->normalizeEntry($input));
    }

    /**
     * @return array<string, array{0: string}>
     */
    public static function rejectedEntries(): array
    {
        return [
            'empty' => [''],
            'blank' => ['   '],
            'ftp scheme' => ['ftp://example.com'],
            'javascript uri' => ['javascript:alert(1)'],
            'userinfo' => ['https://user@example.com'],
            'userinfo with password' => ['https://user:pw@example.com'],
            'at sign' => ['a@b.example'],
            'path' => ['example.com/path'],
            'query' => ['example.com?x=1'],
            'fragment' => ['example.com#x'],
            'backslash' => ['example.com\\evil.com'],
            'percent escape' => ['exam%70le.com'],
            'whitespace inside' => ['exa mple.com'],
            'wildcard on a tld' => ['*.com'],
            'wildcard on localhost' => ['*.localhost'],
            'wildcard not a whole label' => ['*example.com'],
            'wildcard in the middle' => ['foo.*.example.com'],
            'double wildcard' => ['*.*.example.com'],
            'wildcard inside a label' => ['exa*mple.com'],
            'wildcard on an ip' => ['*.127.0.0.1'],
            'empty label' => ['example..com'],
            'leading hyphen' => ['-example.com'],
            'trailing hyphen' => ['example-.com'],
            'port zero' => ['example.com:0'],
            'port too large' => ['example.com:99999'],
            'port not numeric' => ['example.com:abc'],
            'numeric tld' => ['example.123'],
            'bad ipv6' => ['[::zz]:3000'],
            'too long' => [str_repeat('a', 300).'.com'],
        ];
    }

    #[DataProvider('rejectedEntries')]
    public function test_unacceptable_entries_are_rejected(string $input): void
    {
        $this->assertNull($this->matcher->normalizeEntry($input));
    }

    /**
     * @return array<string, array{0: list<string>, 1: string|null, 2: bool}>
     */
    public static function originCases(): array
    {
        return [
            // exact host
            'exact https' => [['example.com'], 'https://example.com', true],
            'exact http' => [['example.com'], 'http://example.com', true],
            'exact is case-insensitive' => [['example.com'], 'https://EXAMPLE.com', true],
            'entry is case-insensitive' => [['Example.COM'], 'https://example.com', true],
            'explicit default port' => [['example.com'], 'https://example.com:443', true],
            'explicit default http port' => [['example.com'], 'http://example.com:80', true],
            'other port without entry port' => [['example.com'], 'https://example.com:8443', false],
            'subdomain of exact entry' => [['example.com'], 'https://www.example.com', false],
            'suffix trick' => [['example.com'], 'https://example.com.evil.com', false],
            'prefix look-alike' => [['example.com'], 'https://evil-example.com', false],
            'glued look-alike' => [['example.com'], 'https://evilexample.com', false],
            'cyrillic homograph' => [['example.com'], "https://ex\u{0430}mple.com", false],

            // wildcard
            'wildcard one label' => [['*.example.com'], 'https://a.example.com', true],
            'wildcard many labels' => [['*.example.com'], 'https://a.b.example.com', true],
            'wildcard never matches the apex' => [['*.example.com'], 'https://example.com', false],
            'wildcard hyphen look-alike' => [['*.example.com'], 'https://evil-example.com', false],
            'wildcard glued look-alike' => [['*.example.com'], 'https://xexample.com', false],
            'wildcard suffix trick' => [['*.example.com'], 'https://a.example.com.evil.com', false],
            'wildcard empty label' => [['*.example.com'], 'https://.example.com', false],
            'wildcard other port' => [['*.example.com'], 'https://a.example.com:8443', false],
            'wildcard with port' => [['*.example.com:8443'], 'https://a.example.com:8443', true],
            'wildcard with port, default port used' => [['*.example.com:8443'], 'https://a.example.com', false],

            // ports
            'port entry matches' => [['localhost:3000'], 'http://localhost:3000', true],
            'port entry vs default port' => [['localhost:3000'], 'http://localhost', false],
            'port entry vs other port' => [['localhost:3000'], 'http://localhost:3001', false],
            'port entry equal to the default port' => [['example.com:443'], 'https://example.com', true],

            // punycode
            'idn entry vs punycode origin' => [['münchen.de'], 'https://xn--mnchen-3ya.de', true],
            'idn entry vs unicode origin' => [['münchen.de'], 'https://münchen.de', true],
            'idn wildcard' => [['*.bücher.example'], 'https://shop.xn--bcher-kva.example', true],

            // ip literals
            'ipv6' => [['[::1]:3000'], 'http://[::1]:3000', true],
            'ipv4' => [['127.0.0.1:8000'], 'http://127.0.0.1:8000', true],

            // hostile / malformed origins
            'null origin' => [['example.com'], 'null', false],
            'NULL origin, any case' => [['example.com'], 'NULL', false],
            'missing origin' => [['example.com'], null, false],
            'empty origin' => [['example.com'], '', false],
            'userinfo before the host' => [['example.com'], 'https://evil.com@example.com', false],
            'userinfo after the host' => [['example.com'], 'https://example.com@evil.com', false],
            'userinfo with colon' => [['example.com'], 'https://example.com:pw@evil.com', false],
            'trailing slash' => [['example.com'], 'https://example.com/', false],
            'path' => [['example.com'], 'https://example.com/path', false],
            'query' => [['example.com'], 'https://example.com?x', false],
            'backslash trick' => [['example.com'], 'https://example.com\\@evil.com', false],
            'percent-encoded dot' => [['example.com'], 'https://example.com%2eevil.com', false],
            'no scheme' => [['example.com'], 'example.com', false],
            'ftp scheme' => [['example.com'], 'ftp://example.com', false],
            'javascript scheme' => [['example.com'], 'javascript://example.com', false],
            'control characters' => [['example.com'], "https://example.com\n", false],
            'whitespace' => [['example.com'], 'https://example.com ', false],

            // entry sets
            'no entries' => [[], 'https://example.com', false],
            'second entry matches' => [['a.com', 'example.com'], 'https://example.com', true],
            'invalid entries are skipped' => [['*.com', 'bad entry', 'example.com'], 'https://example.com', true],
            'only invalid entries' => [['*.com', 'https://u@example.com'], 'https://example.com', false],
        ];
    }

    /**
     * @param  list<string>  $entries
     */
    #[DataProvider('originCases')]
    public function test_origin_matching(array $entries, ?string $origin, bool $expected): void
    {
        $this->assertSame($expected, $this->matcher->matches($origin, $entries));
    }

    public function test_the_origin_of_a_referer_url(): void
    {
        $this->assertSame('https://example.com', $this->matcher->originFromUrl('https://example.com/some/page?x=1#y'));
        $this->assertSame('http://localhost:3000', $this->matcher->originFromUrl('http://localhost:3000/'));
        $this->assertNull($this->matcher->originFromUrl('https://user@example.com/'));
        $this->assertNull($this->matcher->originFromUrl('/relative/path'));
        $this->assertNull($this->matcher->originFromUrl(null));
        $this->assertNull($this->matcher->originFromUrl(''));
    }

    public function test_frame_ancestors_lists_normalised_sources_or_none(): void
    {
        $this->assertSame("'none'", $this->matcher->frameAncestors([]));
        $this->assertSame("'none'", $this->matcher->frameAncestors(['*.com', 'bad entry']));
        $this->assertSame(
            'example.com *.example.org:8443 xn--mnchen-3ya.de',
            $this->matcher->frameAncestors(['Example.com', '*.example.org:8443', 'münchen.de', 'example.com', 'bad entry']),
        );
    }
}
