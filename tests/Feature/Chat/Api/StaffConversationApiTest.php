<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Queries\ConversationListQuery;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `GET /conversations` (filters, search, cursor paging, visibility), `GET /conversations/queue` and `GET /conversations/{ulid}`.
 */
class StaffConversationApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private Category $sales;

    private User $admin;

    private User $agent;

    private User $colleague;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->sales = Category::factory()->create(['slug' => 'sales', 'name' => 'Sales']);
        $this->widget->categories()->attach($this->sales->id, ['sort_order' => 1]);
        $this->admin = User::factory()->admin()->create();
        $this->agent = User::factory()->agent()->create(['name' => 'Agent One']);
        $this->colleague = User::factory()->agent()->create(['name' => 'Agent Two']);
        $this->billing->users()->attach([$this->agent->id, $this->colleague->id]);
    }

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function chat(string $state = 'queued', ?User $agent = null, ?Category $category = null, array $attributes = []): Conversation
    {
        $factory = Conversation::factory()->forCategory($category ?? $this->billing);
        $factory = match ($state) {
            'active' => $factory->active($agent),
            'ended' => $factory->ended($agent),
            'closed' => $factory->closed($agent),
            'missed' => $factory->missed(),
            'offline' => $factory->offline(),
            default => $factory,
        };

        $visitor = Visitor::factory()->create(['widget_id' => $this->widget->id]);

        return $factory->create(['widget_id' => $this->widget->id, 'visitor_id' => $visitor->id] + $attributes);
    }

    /**
     * @return list<string>
     */
    private function ulids(TestResponse $response): array
    {
        return array_column($response->json('data'), 'ulid');
    }

    public function test_the_endpoints_need_a_signed_in_member_of_staff(): void
    {
        $chat = $this->chat();

        foreach (['/api/v1/conversations', '/api/v1/conversations/queue', "/api/v1/conversations/{$chat->ulid}", "/api/v1/conversations/{$chat->ulid}/messages"] as $url) {
            $this->getJson($url)->assertUnauthorized();
        }

        $noRole = User::factory()->withoutChatAccess()->create();
        $this->actingAs($noRole, 'sanctum')->getJson('/api/v1/conversations')->assertForbidden();
        $this->actingAs(User::factory()->agent()->inactive()->create(), 'sanctum')->getJson('/api/v1/conversations')->assertStatus(401);
    }

    public function test_an_agent_sees_exactly_what_the_visibility_rule_gives_them(): void
    {
        $assigned = $this->chat('active', $this->agent);
        $closedOfMine = $this->chat('closed', $this->agent);
        $offered = $this->chat('queued');
        ConversationOffer::factory()->create(['conversation_id' => $offered->id, 'user_id' => $this->agent->id]);
        $expiredOffer = $this->chat('queued');
        ConversationOffer::factory()->expired()->create(['conversation_id' => $expiredOffer->id, 'user_id' => $this->agent->id]);
        $offeredToColleague = $this->chat('queued');
        ConversationOffer::factory()->create(['conversation_id' => $offeredToColleague->id, 'user_id' => $this->colleague->id]);
        $colleaguesChat = $this->chat('active', $this->colleague);
        $ticketInMyCategory = $this->chat('offline');
        $ticketElsewhere = $this->chat('offline', category: $this->sales);
        $missed = $this->chat('missed');

        $response = $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations')->assertOk();

        $this->assertEqualsCanonicalizing(
            [$assigned->ulid, $closedOfMine->ulid, $offered->ulid, $ticketInMyCategory->ulid],
            $this->ulids($response),
        );
        $this->assertNull($response->json('meta.next_cursor'));

        $all = $this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations?limit=100')->assertOk();
        $this->assertCount(9, $all->json('data'));
    }

    public function test_the_list_items_are_staff_conversations(): void
    {
        $chat = $this->chat('active', $this->agent);
        Message::factory()->for($chat)->create(['body' => 'Hello there']);
        $chat->forceFill(['last_message_preview' => 'Hello there', 'last_message_at' => now(), 'unseen_by_agent' => 2])->save();

        $item = $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations')->assertOk()->json('data.0');

        $this->assertEqualsCanonicalizing([
            'ulid', 'ticketNo', 'status', 'type', 'category', 'agent', 'createdAt', 'endedAt', 'ratingRequested', 'lastSeq',
            'visitor', 'widget', 'assignedAgent', 'unseenByAgent', 'claimedAt', 'lastMessageAt', 'lastMessagePreview',
            'queueExpiresAt', 'pageUrl', 'pageTitle',
        ], array_keys($item));
        $this->assertSame(['id' => $this->agent->id, 'name' => 'Agent One'], $item['assignedAgent']);
        $this->assertSame(2, $item['unseenByAgent']);
        $this->assertSame('Hello there', $item['lastMessagePreview']);
        $this->assertSame($this->widget->ulid, $item['widget']['ulid']);
        $this->assertIsArray($item['visitor']['meta']);
    }

    public function test_the_list_is_filtered(): void
    {
        $queued = $this->chat('queued');
        $active = $this->chat('active', $this->agent);
        $closed = $this->chat('closed', $this->colleague, $this->sales);
        $missed = $this->chat('missed');
        $ticket = $this->chat('offline');
        $other = Widget::factory()->enabled()->create();
        $elsewhere = Conversation::factory()->create(['widget_id' => $other->id]);
        $get = fn (string $query): array => $this->ulids($this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations?limit=100&'.$query)->assertOk());

        $this->assertEqualsCanonicalizing([$queued->ulid, $active->ulid], array_values(array_intersect($get('status=queued,active'), [$queued->ulid, $active->ulid, $missed->ulid])));
        $this->assertSame([$closed->ulid], $get('status=closed'));
        $this->assertEqualsCanonicalizing([$closed->ulid], $get('category='.$this->sales->ulid));
        $this->assertEqualsCanonicalizing([$closed->ulid], $get('category=sales'));
        $this->assertSame([$elsewhere->ulid], $get('widget='.$other->ulid));
        $this->assertSame([$ticket->ulid], $get('type=offline'));
        $this->assertSame([$active->ulid], $get('agent='.$this->agent->id));
        $this->assertSame([$closed->ulid], $get('agent='.$this->colleague->id));
        $this->assertSame([], $get('status=active&type=offline'));

        // "me" is the caller.
        $mine = $this->ulids($this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations?agent=me')->assertOk());
        $this->assertSame([$active->ulid], $mine);

        // Time windows.
        $old = $this->chat('closed', $this->agent);
        Conversation::query()->whereKey($old->id)->update(['created_at' => '2026-01-05 10:00:00', 'updated_at' => '2026-01-06 10:00:00']);
        $this->assertSame([$old->ulid], $get('from=2026-01-01&to=2026-01-31'));
        $this->assertSame([$old->ulid], $get('from=2026-01-05&to=2026-01-05'), 'a bare end date includes that whole day');
        $this->assertSame([], $get('from=2026-01-01&to=2026-01-04'));
        $this->assertSame([$old->ulid], $get('from=2026-01-05T09:59:00Z&to=2026-01-05T10:01:00Z'));
        $this->assertNotContains($old->ulid, $get('from=2026-02-01'));
        $this->assertNotContains($old->ulid, $get('updated_after=2026-01-07'));
        $this->assertContains($old->ulid, $get('updated_after=2026-01-05'));
    }

    public function test_time_filters_compare_instants_not_wall_clock_digits(): void
    {
        $get = fn (string $query): array => $this->ulids($this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations?limit=100&'.$query)->assertOk());
        $old = $this->chat('closed', $this->agent);
        Conversation::query()->whereKey($old->id)->update(['created_at' => '2026-01-05 10:00:00', 'updated_at' => '2026-01-05 10:00:00']);
        $at = fn (string $instant): string => urlencode($instant);

        // 10:00 UTC is 13:00 at +03:00 and 05:00 at -05:00.
        $this->assertSame([$old->ulid], $get('from='.$at('2026-01-05T13:00:00+03:00').'&to='.$at('2026-01-05T13:00:00+03:00')));
        $this->assertSame([$old->ulid], $get('from='.$at('2026-01-05T05:00:00-05:00').'&to='.$at('2026-01-05T05:00:00-05:00')));
        // The same digits at another offset are another instant: 11:00+03:00 is 08:00Z (before the chat), 09:00-05:00 is 14:00Z (after it).
        $this->assertSame([], $get('from=2026-01-05T00:00:00Z&to='.$at('2026-01-05T11:00:00+03:00')));
        $this->assertSame([], $get('from='.$at('2026-01-05T09:00:00-05:00').'&to=2026-01-06T00:00:00Z'));

        // `updated_after` is inclusive (a change in the same second as the client's last sync is not lost; clients merge idempotently).
        $this->assertContains($old->ulid, $get('updated_after=2026-01-05T10:00:00Z'));
        $this->assertContains($old->ulid, $get('updated_after='.$at('2026-01-05T13:00:00+03:00')));
        $this->assertNotContains($old->ulid, $get('updated_after='.$at('2026-01-05T13:00:01+03:00')));
        $this->assertNotContains($old->ulid, $get('updated_after='.$at('2026-01-05T05:00:01-05:00')));
    }

    public function test_filters_are_validated(): void
    {
        $admin = $this->actingAs($this->admin, 'sanctum');

        $admin->getJson('/api/v1/conversations?status=queued,bogus')->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['status']]]);
        $admin->getJson('/api/v1/conversations?type=whatsapp')->assertStatus(422);
        $admin->getJson('/api/v1/conversations?limit=101')->assertStatus(422);
        $admin->getJson('/api/v1/conversations?limit=0')->assertStatus(422);
        $admin->getJson('/api/v1/conversations?widget=nope')->assertStatus(422);
        $admin->getJson('/api/v1/conversations?agent=abc')->assertStatus(422);
        $admin->getJson('/api/v1/conversations?from=not-a-date')->assertStatus(422);
        $admin->getJson('/api/v1/conversations?q='.str_repeat('x', 201))->assertStatus(422);
    }

    public function test_search_finds_a_ticket_number_or_words_in_messages(): void
    {
        $refund = $this->chat('active', $this->agent);
        $other = $this->chat('active', $this->agent);
        Message::factory()->for($refund)->create(['body' => 'I would like a refund for my invoice']);
        Message::factory()->for($other)->create(['body' => 'How do I reset 9% of my password_hash?']);
        $get = fn (string $q): array => $this->ulids($this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations?q='.urlencode($q))->assertOk());

        $this->assertSame([$refund->ulid], $get($refund->ticket_no));
        $this->assertSame([$refund->ulid], $get(strtolower($refund->ticket_no)));
        $this->assertSame([], $get('ZZZZZZ'));
        // Words under three characters cannot use the full-text index: they run through LIKE on every driver, where % and _ are plain characters.
        $this->assertSame([$other->ulid], $get('9%'));
        $this->assertSame([], $get('%%'));
        $this->assertSame([], $get('p%d'));
        $this->assertSame([$other->ulid], $get('_'));

        // Longer words: LIKE on SQLite; on MySQL the full-text index only sees committed rows and a RefreshDatabase test never commits.
        if (! $this->usesFullText()) {
            $this->assertSame([$refund->ulid], $get('refund'));
            $this->assertSame([$other->ulid], $get('password_hash'));
            $this->assertSame([], $get('pass_ord'));
        }

        // A colleague's conversation is never found, whatever it says.
        $secret = $this->chat('active', $this->colleague);
        Message::factory()->for($secret)->create(['body' => 'refund secret']);
        $this->assertNotContains($secret->ulid, $get('secret'));
        $this->assertNotContains($secret->ulid, $get('9%'));
    }

    private function usesFullText(): bool
    {
        return in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true);
    }

    public function test_word_search_uses_the_full_text_index_on_mysql(): void
    {
        if (! $this->usesFullText()) {
            $this->markTestSkipped('FULLTEXT is a MySQL / MariaDB feature.');
        }

        // InnoDB's full-text index only sees committed rows, and a RefreshDatabase test never commits: assert the generated query instead.
        $sql = (new ConversationListQuery)->build($this->admin, ['q' => 'refund invoice'])->toRawSql();

        $this->assertStringContainsString('MATCH(messages.body) AGAINST', $sql);
        $this->assertStringContainsString('+refund* +invoice*', $sql);
    }

    public function test_the_boolean_expression_keeps_only_words_the_index_can_hold(): void
    {
        $this->assertSame('+refund* +invoice*', ConversationListQuery::booleanExpression('refund, invoice!'));
        $this->assertSame('+hello* +wörld*', ConversationListQuery::booleanExpression('+-hello* ("wörld") ~<>'));
        $this->assertSame('+abc*', ConversationListQuery::booleanExpression('a b abc'));
        $this->assertNull(ConversationListQuery::booleanExpression('a bc'));
        $this->assertNull(ConversationListQuery::booleanExpression('   '));
        $this->assertCount(8, explode(' ', (string) ConversationListQuery::booleanExpression('one two three four five six seven eight nine ten')));
    }

    public function test_the_list_pages_with_an_opaque_cursor_newest_first(): void
    {
        $chats = array_map(fn () => $this->chat('closed', $this->agent), range(1, 5));
        $newestFirst = array_reverse(array_map(fn (Conversation $chat): string => $chat->ulid, $chats));

        $first = $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations?limit=2')->assertOk();
        $this->assertSame(array_slice($newestFirst, 0, 2), $this->ulids($first));
        $cursor = $first->json('meta.next_cursor');
        $this->assertIsString($cursor);

        $second = $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations?limit=2&cursor='.urlencode($cursor))->assertOk();
        $this->assertSame(array_slice($newestFirst, 2, 2), $this->ulids($second));

        $third = $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations?limit=2&cursor='.urlencode($second->json('meta.next_cursor')))->assertOk();
        $this->assertSame(array_slice($newestFirst, 4), $this->ulids($third));
        $this->assertNull($third->json('meta.next_cursor'));
    }

    public function test_the_queue_lists_what_can_be_accepted_oldest_first(): void
    {
        $older = $this->chat('queued', attributes: ['queued_at' => now()->subMinutes(5)]);
        $newer = $this->chat('queued', attributes: ['queued_at' => now()->subMinute()]);
        $notMine = $this->chat('queued');
        foreach ([$older, $newer] as $chat) {
            ConversationOffer::factory()->create(['conversation_id' => $chat->id, 'user_id' => $this->agent->id]);
        }
        ConversationOffer::factory()->create(['conversation_id' => $notMine->id, 'user_id' => $this->colleague->id]);
        $expired = $this->chat('queued');
        ConversationOffer::factory()->expired()->create(['conversation_id' => $expired->id, 'user_id' => $this->agent->id]);
        $ticket = $this->chat('offline');
        $this->chat('active', $this->agent);

        $mine = $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations/queue')->assertOk();
        $this->assertSame([$older->ulid, $newer->ulid, $ticket->ulid], $this->ulids($mine));
        $this->assertNull($mine->json('meta.next_cursor'));

        $this->assertCount(5, $this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations/queue')->json('data'));
    }

    public function test_one_conversation_is_shown_to_those_who_may_see_it(): void
    {
        $assigned = $this->chat('active', $this->agent);
        $offered = $this->chat('queued');
        ConversationOffer::factory()->create(['conversation_id' => $offered->id, 'user_id' => $this->agent->id]);
        $theirs = $this->chat('active', $this->colleague);

        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$assigned->ulid}")->assertOk()->assertJsonPath('data.ulid', $assigned->ulid)->assertJsonPath('data.assignedAgent.id', $this->agent->id);
        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$offered->ulid}")->assertOk();
        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$theirs->ulid}")->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->actingAs($this->admin, 'sanctum')->getJson("/api/v1/conversations/{$theirs->ulid}")->assertOk();
        $this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations/01JABCDEFGHJKMNPQRSTVWXYZ0')->assertNotFound();
        $this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/conversations/not-a-ulid')->assertNotFound();
    }

    public function test_staff_calls_are_rate_limited_per_member_of_staff(): void
    {
        config(['chat.rate_limits.staff_api_user' => 3]);

        foreach (range(1, 3) as $i) {
            $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations/queue')->assertOk();
        }

        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/conversations/queue')->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');
        $this->actingAs($this->colleague, 'sanctum')->getJson('/api/v1/conversations/queue')->assertOk();
    }

    public function test_an_agent_whose_offer_expired_or_was_taken_loses_sight_of_the_chat(): void
    {
        $chat = $this->chat('queued');
        $offer = ConversationOffer::factory()->create(['conversation_id' => $chat->id, 'user_id' => $this->agent->id]);

        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$chat->ulid}")->assertOk();

        $this->travel(2)->minutes();
        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$chat->ulid}")->assertForbidden();
        $this->assertNotNull($offer->fresh());
    }
}
