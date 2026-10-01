<?php

namespace Tests\Feature\Chat;

use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use App\Models\Visitor;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The text search of `GET /conversations` (and the export) is the one the admin history page runs: the same words find the same
 * conversations, including by the visitor's name, e-mail address or phone number and by part of a ticket number.
 */
class ConversationSearchParityTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private User $admin;

    /** @var array<string, Conversation> */
    private array $chats = [];

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
        $this->admin = User::factory()->admin()->create();

        $make = function (string $key, array $visitor, string $body, string $ticket): void {
            $conversation = Conversation::factory()->closed()->create([
                'visitor_id' => Visitor::factory()->create($visitor)->id,
                'ticket_no' => $ticket,
            ]);
            Message::factory()->for($conversation)->create(['body' => $body]);
            $this->chats[$key] = $conversation;
        };

        $make('ann', ['name' => 'Ann Archer', 'email' => 'ann.archer@mail.example', 'phone' => '+49 30 1234567'], 'Where is my refund for the invoice?', 'AAB234');
        $make('bob', ['name' => 'Bob Builder', 'email' => 'bob@builder.example', 'phone' => null], 'The password reset mail never arrived', 'BCD567');
        $make('cat', ['name' => 'Cat 100% Sure', 'email' => 'cat_sure@mail.example', 'phone' => '+1 555 0100'], 'Nothing special here', 'CDE899');
    }

    /**
     * @return list<string>
     */
    private function viaHistory(string $q): array
    {
        $props = $this->actingAs($this->admin)->get('/history?'.http_build_query(['q' => $q]))->assertOk()->viewData('page')['props'];

        return array_column($props['conversations'], 'ulid');
    }

    /**
     * @return list<string>
     */
    private function viaApi(string $q): array
    {
        return array_column($this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations?limit=100&q='.urlencode($q))->assertOk()->json('data'), 'ulid');
    }

    /**
     * @return iterable<string, array{string, list<string>}>
     */
    public static function searches(): iterable
    {
        yield 'visitor e-mail' => ['ann.archer@mail.example', ['ann']];
        yield 'part of an e-mail' => ['builder.example', ['bob']];
        yield 'visitor name' => ['Archer', ['ann']];
        yield 'visitor name, other case' => ['bob builder', ['bob']];
        yield 'phone number' => ['555 0100', ['cat']];
        yield 'whole ticket number' => ['BCD567', ['bob']];
        yield 'ticket number, lower case' => ['cde899', ['cat']];
        yield 'part of a ticket number' => ['CD5', ['bob']];
        yield 'message text' => ['refund', ['ann']];
        yield 'a literal percent sign' => ['100%', ['cat']];
        yield 'a literal underscore' => ['cat_sure', ['cat']];
        yield 'nothing' => ['no such thing anywhere', []];
    }

    /**
     * @param  list<string>  $expected
     */
    #[DataProvider('searches')]
    public function test_the_same_text_finds_the_same_conversations_in_the_api_and_on_the_history_page(string $q, array $expected): void
    {
        $ulids = array_map(fn (string $key): string => $this->chats[$key]->ulid, $expected);

        $api = $this->viaApi($q);
        $history = $this->viaHistory($q);

        $this->assertEqualsCanonicalizing($ulids, $api, 'API');
        $this->assertEqualsCanonicalizing($ulids, $history, 'history page');
        $this->assertEqualsCanonicalizing($history, $api, 'parity');
    }
}
