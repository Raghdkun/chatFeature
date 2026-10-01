<?php

namespace Tests\Unit\Chat;

use App\Domain\Chat\Services\MessageText;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Plain-text message bodies (decision P4-D11): what is kept, what is dropped, how previews are cut.
 */
class MessageTextTest extends TestCase
{
    /**
     * @return iterable<string, array{string|null, string|null}>
     */
    public static function bodies(): iterable
    {
        yield 'trimmed' => ["  hello  \n", 'hello'];
        yield 'line endings normalised' => ["a\r\nb\rc\nd", "a\nb\nc\nd"];
        yield 'tabs and line breaks stay' => ["a\tb\nc", "a\tb\nc"];
        yield 'control characters go' => ["a\x00b\x07c\x1Bd\x7Fe", 'abcde'];
        yield 'C1 controls go' => ["a\u{0085}b\u{009F}c", 'abc'];
        yield 'bidi overrides and isolates go' => ["a\u{202E}b\u{2066}c\u{2069}d\u{202A}e", 'abcde'];
        yield 'byte order mark goes' => ["\u{FEFF}hello", 'hello'];
        yield 'joiners and direction marks stay' => ["\u{200D}\u{200C}a\u{200F}", "\u{200D}\u{200C}a\u{200F}"];
        yield 'markup is just text' => ['<b onclick="x()">hi</b>', '<b onclick="x()">hi</b>'];
        yield 'arabic and emoji' => ['مرحبا 👋', 'مرحبا 👋'];
        yield 'only whitespace' => ["  \t\n ", null];
        yield 'only control characters' => ["\x00\x01\u{202E}", null];
        yield 'empty' => ['', null];
        yield 'null' => [null, null];
    }

    #[DataProvider('bodies')]
    public function test_clean(?string $input, ?string $expected): void
    {
        $this->assertSame($expected, MessageText::clean($input));
    }

    public function test_the_preview_is_one_line_and_cut_at_the_limit(): void
    {
        $this->assertSame('hello big world', MessageText::preview("hello\n  big\tworld"));
        $this->assertNull(MessageText::preview(null));
        $this->assertNull(MessageText::preview(''));

        $long = MessageText::preview(str_repeat('word ', 100));
        $this->assertSame(160, mb_strlen((string) $long));
        $this->assertStringEndsWith('…', (string) $long);

        $this->assertSame(str_repeat('é', 160), MessageText::preview(str_repeat('é', 160)));
        $this->assertSame(10, mb_strlen((string) MessageText::preview(str_repeat('é', 20), 10)));
    }
}
