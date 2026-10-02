<?php

namespace Tests\Feature\Performance;

use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\Widget;
use Closure;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * N+1 guards for the lists the dashboard and the visitor panel call all the time (P7 query review): the number of SQL statements an
 * endpoint issues must not depend on how many rows it returns. Each test runs the same request over a small and a large set of rows
 * (different visitors, widgets, categories, agents, attachments per row) and compares the statement counts.
 */
class QueryCountGuardTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    /** @param Closure(): mixed $request */
    private function statements(Closure $request): int
    {
        DB::flushQueryLog();
        DB::enableQueryLog();
        $request();
        $count = count(DB::getQueryLog());
        DB::disableQueryLog();

        return $count;
    }

    /**
     * @param  array<string, Closure(): mixed>  $requests
     * @param  Closure(int): void  $grow  adds that many rows of every kind the requests return
     */
    private function assertConstant(array $requests, Closure $grow): void
    {
        $grow(2);
        $small = [];

        foreach ($requests as $what => $request) {
            $this->app['auth']->forgetGuards();
            $request(); // warm: settings, schema caches
            $this->app['auth']->forgetGuards();
            $small[$what] = $this->statements($request);
        }

        $grow(14);

        foreach ($requests as $what => $request) {
            $this->app['auth']->forgetGuards();
            $large = $this->statements($request);

            $this->assertSame($small[$what], $large, "{$what}: {$small[$what]} statements with 2 rows, {$large} with 16: a per-row query crept in");
        }
    }

    /** @return array{0: Widget, 1: Category, 2: User} */
    private function staffWorld(): array
    {
        [$widget, $category] = $this->chatWidget();

        return [$widget, $category, $this->availableAgent($category)];
    }

    public function test_the_staff_conversation_list_and_the_queue_do_not_query_per_row(): void
    {
        [$widget, $category, $agent] = $this->staffWorld();
        $admin = User::factory()->admin()->create();
        $grow = function (int $rows) use ($widget, $category, $agent): void {
            for ($i = 0; $i < $rows; $i++) {
                $other = Category::factory()->create();
                $this->activeChat($this->visitorSession($widget), $other, $this->availableAgent($category));
                $this->queuedChat($this->visitorSession($widget), $category, [$agent]);
            }
        };

        $this->assertConstant([
            'GET /conversations (admin)' => fn () => $this->actingAs($admin, 'sanctum')->getJson('/api/v1/conversations?limit=100')->assertOk(),
            'GET /conversations (agent, queued)' => fn () => $this->actingAs($agent, 'sanctum')->getJson('/api/v1/conversations?status=queued&limit=100')->assertOk(),
            'GET /conversations/queue' => fn () => $this->actingAs($agent, 'sanctum')->getJson('/api/v1/conversations/queue')->assertOk(),
        ], $grow);
    }

    public function test_the_history_search_and_the_export_do_not_query_per_row(): void
    {
        [$widget, $category] = $this->chatWidget();
        $admin = User::factory()->admin()->create();
        $grow = function (int $rows) use ($widget, $category): void {
            for ($i = 0; $i < $rows; $i++) {
                $token = $this->visitorSession($widget, ['name' => 'Searchable '.$i]);
                $chat = $this->activeChat($token, $category, $this->availableAgent($category));
                Message::factory()->for($chat)->create(['body' => 'invoice question '.$i]);
            }
        };

        $this->assertConstant([
            'GET /conversations?q=' => fn () => $this->actingAs($admin, 'sanctum')->getJson('/api/v1/conversations?q=invoice&limit=100')->assertOk()->assertJsonCount(Conversation::query()->count(), 'data'),
            'GET /conversations/export' => fn () => $this->actingAs($admin, 'sanctum')->getJson('/api/v1/conversations/export?format=json')->assertOk(),
        ], $grow);
    }

    public function test_the_message_lists_do_not_query_per_message(): void
    {
        [$widget, $category, $agent] = $this->staffWorld();
        $token = $this->visitorSession($widget);
        $chat = $this->activeChat($token, $category, $agent);
        $seq = 0;
        $grow = function (int $rows) use ($chat, &$seq): void {
            for ($i = 0; $i < $rows; $i++) {
                $message = Message::factory()->for($chat)->create(['seq' => ++$seq, 'sender_type' => $i % 2 === 0 ? 'agent' : 'visitor', 'sender_user_id' => $i % 2 === 0 ? User::factory()->agent()->create()->id : null, 'body' => 'line '.$seq]);
                Attachment::factory()->create(['conversation_id' => $chat->id, 'message_id' => $message->id]);
            }

            $chat->forceFill(['last_seq' => $seq])->save();
        };

        $this->assertConstant([
            'staff GET messages' => fn () => $this->actingAs($agent, 'sanctum')->getJson('/api/v1/conversations/'.$chat->ulid.'/messages?limit=100')->assertOk(),
            'visitor GET messages' => fn () => $this->withHeaders($this->bearer($token))->getJson('/api/v1/public/conversations/'.$chat->ulid.'/messages?after_seq=0')->assertOk(),
            'visitor GET conversation' => fn () => $this->withHeaders($this->bearer($token))->getJson('/api/v1/public/conversation')->assertOk(),
        ], $grow);
    }

    public function test_the_whatsapp_inbox_does_not_query_per_chat(): void
    {
        $admin = User::factory()->admin()->create();
        $widget = Widget::factory()->enabled()->create();
        $grow = function (int $rows) use ($widget): void {
            for ($i = 0; $i < $rows; $i++) {
                $visitor = Visitor::factory()->create(['widget_id' => $widget->id]);
                $chat = WaChat::factory()->create(['visitor_id' => $visitor->id, 'widget_id' => $widget->id, 'push_name' => 'Customer '.$i]);
                WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'body' => 'refund request '.$i]);
            }
        };

        $this->assertConstant([
            'GET /whatsapp/chats' => fn () => $this->actingAs($admin, 'sanctum')->getJson('/api/v1/whatsapp/chats?limit=100')->assertOk(),
            'GET /whatsapp/chats?q=' => fn () => $this->actingAs($admin, 'sanctum')->getJson('/api/v1/whatsapp/chats?q=refund&limit=100')->assertOk(),
        ], $grow);
    }

    public function test_listing_the_transfer_targets_does_not_query_per_agent(): void
    {
        [$widget, $category, $agent] = $this->staffWorld();
        $chat = $this->activeChat($this->visitorSession($widget), $category, $agent);
        $grow = function (int $rows) use ($category): void {
            for ($i = 0; $i < $rows; $i++) {
                $this->availableAgent($category);
            }
        };

        $this->assertConstant([
            'GET transfer-targets' => fn () => $this->actingAs($agent, 'sanctum')->getJson('/api/v1/conversations/'.$chat->ulid.'/transfer-targets')->assertOk(),
        ], $grow);
    }
}
