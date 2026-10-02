<?php

namespace Tests\Feature\WhatsApp;

use App\Models\Category;
use App\Models\WaHandoffTicket;
use App\Models\WhatsAppSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use RuntimeException;
use Tests\TestCase;

class WaHandoffTicketTest extends TestCase
{
    use RefreshDatabase;

    public function test_codes_have_eight_characters_from_the_unambiguous_alphabet(): void
    {
        for ($i = 0; $i < 200; $i++) {
            $this->assertMatchesRegularExpression('/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/D', WaHandoffTicket::generateCode());
        }

        $this->assertSame('ABCDEFGHJKMNPQRSTUVWXYZ23456789', WaHandoffTicket::ALPHABET);

        foreach (['I', 'L', 'O', '0', '1'] as $ambiguous) {
            $this->assertStringNotContainsString($ambiguous, WaHandoffTicket::ALPHABET);
        }
    }

    public function test_a_candidate_that_is_taken_is_skipped(): void
    {
        $tries = [];

        $code = WaHandoffTicket::generateCode(function (string $candidate) use (&$tries): bool {
            $tries[] = $candidate;

            return count($tries) < 3;
        });

        $this->assertCount(3, $tries);
        $this->assertSame($tries[2], $code);
        $this->assertCount(3, array_unique($tries), 'each attempt is a fresh candidate');
    }

    public function test_it_gives_up_when_every_candidate_is_taken(): void
    {
        $tries = 0;

        try {
            WaHandoffTicket::generateCode(function () use (&$tries): bool {
                $tries++;

                return true;
            });
            $this->fail('a code was returned although every candidate was taken');
        } catch (RuntimeException) {
            $this->assertSame(10, $tries);
        }
    }

    public function test_the_default_check_looks_at_every_ticket_live_or_not(): void
    {
        $taken = WaHandoffTicket::factory()->expired()->create();

        for ($i = 0; $i < 50; $i++) {
            $this->assertNotSame($taken->code, WaHandoffTicket::generateCode());
        }
    }

    public function test_a_ticket_gets_its_code_on_creation_but_keeps_one_it_was_given(): void
    {
        $generated = WaHandoffTicket::factory()->create();
        $given = WaHandoffTicket::factory()->create(['code' => 'ABCD2345']);

        $this->assertMatchesRegularExpression('/^[A-Z2-9]{8}$/D', $generated->code);
        $this->assertSame('ABCD2345', $given->fresh()?->code);
    }

    public function test_a_live_ticket_is_neither_used_nor_expired(): void
    {
        $live = WaHandoffTicket::factory()->create();
        $expired = WaHandoffTicket::factory()->expired()->create();
        $consumed = WaHandoffTicket::factory()->consumed()->create();

        $this->assertTrue($live->isLive());
        $this->assertFalse($expired->isLive());
        $this->assertTrue($expired->isExpired());
        $this->assertFalse($consumed->isLive());
        $this->assertTrue($consumed->isConsumed());

        $this->assertSame([$live->id], WaHandoffTicket::query()->live()->pluck('id')->all());
    }

    public function test_the_time_to_live_is_a_day_by_default(): void
    {
        $ticket = WaHandoffTicket::factory()->create();

        $this->assertEqualsWithDelta(1440 * 60, now()->diffInSeconds($ticket->expires_at), 5);
    }

    public function test_a_code_is_found_the_way_a_person_types_it(): void
    {
        $ticket = WaHandoffTicket::factory()->create(['code' => 'K7M2QX3P']);
        WaHandoffTicket::factory()->create();

        $this->assertSame([$ticket->id], WaHandoffTicket::query()->withCode('k7m2qx3p')->pluck('id')->all());
        $this->assertSame([$ticket->id], WaHandoffTicket::query()->withCode("  K7M2QX3P \n")->pluck('id')->all());
        $this->assertSame([], WaHandoffTicket::query()->withCode('K7M2QX3Q')->pluck('id')->all());
    }

    public function test_a_ticket_knows_where_it_comes_from(): void
    {
        $category = Category::factory()->create();
        $session = WhatsAppSession::factory()->ready()->create();
        $ticket = WaHandoffTicket::factory()->forCategory($category)->create(['session_id' => $session->id]);

        $this->assertTrue($ticket->session->is($session));
        $this->assertTrue($ticket->category?->is($category));
        $this->assertTrue($ticket->visitor?->widget?->is($ticket->widget), 'the visitor belongs to the ticket\'s widget');
        $this->assertNull($ticket->chat);
    }
}
