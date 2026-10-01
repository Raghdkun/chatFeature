<?php

namespace Tests\Unit\Widgets;

use App\Domain\Widgets\Origin\PublicSuffixes;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class PublicSuffixesTest extends TestCase
{
    /**
     * @return array<string, array{0: string, 1: bool}>
     */
    public static function hosts(): array
    {
        return [
            'generic tld' => ['com', true],
            'another generic tld' => ['net', true],
            'org' => ['org', true],
            'a single label is always a suffix' => ['localhost', true],
            'upper case and trailing dot' => ['.CO.UK.', true],
            'uk second level' => ['co.uk', true],
            'uk academic' => ['ac.uk', true],
            'australian commercial' => ['com.au', true],
            'japanese company' => ['co.jp', true],
            'indian government' => ['gov.in', true],
            'regular country shape without a list entry' => ['com.xx', true],
            'irregular country suffix' => ['me.uk', true],
            'hosting platform' => ['github.io', true],
            'another platform' => ['herokuapp.com', true],
            'cloud platform' => ['vercel.app', true],
            'registrable name under a country second level' => ['example.co.uk', false],
            'registrable name under a platform' => ['team.github.io', false],
            'plain registrable name' => ['example.com', false],
            'registrable name under a country code' => ['example.de', false],
            'a co label that is not under a country code' => ['co.example.com', false],
            'a two-label name whose first label is merely similar' => ['company.uk', false],
            'a real name that starts like a second level' => ['go.dev', false],
        ];
    }

    #[DataProvider('hosts')]
    public function test_public_suffixes_are_recognised(string $host, bool $expected): void
    {
        $this->assertSame($expected, PublicSuffixes::isPublicSuffix($host));
    }
}
