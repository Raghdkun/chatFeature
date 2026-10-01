<?php

namespace Tests\Unit\Chat;

use App\Domain\Chat\Support\TicketNumberGenerator;
use PHPUnit\Framework\TestCase;
use RuntimeException;

class TicketNumberGeneratorTest extends TestCase
{
    public function test_codes_have_six_characters_from_the_unambiguous_alphabet(): void
    {
        for ($i = 0; $i < 200; $i++) {
            $code = TicketNumberGenerator::random();

            $this->assertSame(6, strlen($code));
            $this->assertMatchesRegularExpression('/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/D', $code);
        }
    }

    public function test_the_alphabet_has_no_look_alikes(): void
    {
        foreach (['I', 'L', 'O', '0', '1'] as $ambiguous) {
            $this->assertStringNotContainsString($ambiguous, TicketNumberGenerator::ALPHABET);
        }
    }

    public function test_length_is_bounded_by_the_column(): void
    {
        $this->assertSame(TicketNumberGenerator::MAX_LENGTH, strlen(TicketNumberGenerator::random(99)));
        $this->assertSame(1, strlen(TicketNumberGenerator::random(0)));
    }

    public function test_unique_skips_codes_that_are_taken(): void
    {
        $tries = 0;

        $code = TicketNumberGenerator::unique(function (string $candidate) use (&$tries): bool {
            $tries++;

            return $tries < 3;
        });

        $this->assertSame(3, $tries);
        $this->assertSame(6, strlen($code));
    }

    public function test_unique_widens_the_code_when_collisions_keep_happening(): void
    {
        $lengths = [];

        $code = TicketNumberGenerator::unique(function (string $candidate) use (&$lengths): bool {
            $lengths[] = strlen($candidate);

            return count($lengths) < 8;
        });

        $this->assertSame([6, 6, 6, 6, 6, 8, 8, 8], $lengths);
        $this->assertSame(8, strlen($code));
    }

    public function test_unique_gives_up_instead_of_looping_forever(): void
    {
        $this->expectException(RuntimeException::class);

        TicketNumberGenerator::unique(fn (): bool => true);
    }
}
