<?php

namespace Tests\Feature\Privacy;

use App\Domain\Privacy\Actions\PruneConversations;
use App\Models\Attachment;
use App\Models\AuditLog;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\Support\ChatFixtures;
use Tests\Support\PrivacyWorld;
use Tests\TestCase;

/**
 * `chat:prune-conversations` and `chat.retention_days`: closed and missed conversations older than the retention go with their messages, images
 * (files first) and ratings; open conversations and recent ones stay; visitors nothing is left of go too; 0 keeps everything; the API sets it.
 */
class ConversationRetentionTest extends TestCase
{
    use ChatFixtures, PrivacyWorld, RefreshDatabase;

    private Widget $widget;

    private Category $category;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        Storage::fake('local');
        [$this->widget, $this->category] = $this->chatWidget();
    }

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function conversation(string $state, int $closedDaysAgo, array $attributes = [], ?Visitor $visitor = null): Conversation
    {
        $visitor ??= Visitor::factory()->create(['widget_id' => $this->widget->id, 'last_seen_at' => now()->subDays(400)]);
        $factory = Conversation::factory()->forCategory($this->category);
        $factory = match ($state) {
            'closed' => $factory->closed(),
            'missed' => $factory->missed(),
            'active' => $factory->active(),
            default => $factory,
        };
        $conversation = $factory->create(['widget_id' => $this->widget->id, 'visitor_id' => $visitor->id, 'visitor_session_id' => null] + $attributes);

        if ($state === 'closed' || $state === 'missed') {
            $conversation->forceFill(['closed_at' => now()->subDays($closedDaysAgo)])->saveQuietly();
        }

        Message::factory()->for($conversation)->create(['seq' => 1, 'body' => 'hello '.$conversation->ulid]);
        Rating::factory()->create(['conversation_id' => $conversation->id]);

        return $conversation;
    }

    private function withFile(Conversation $conversation): string
    {
        $path = 'chat/attachments/2026/10/'.strtolower($conversation->ulid).'.png';
        Storage::disk('local')->put($path, 'png');
        Storage::disk('local')->put(str_replace('.png', '_t.png', $path), 'png');
        Attachment::factory()->create(['conversation_id' => $conversation->id, 'path' => $path, 'thumb_path' => str_replace('.png', '_t.png', $path)]);

        return $path;
    }

    public function test_old_closed_and_missed_conversations_go_with_their_rows_and_files_and_the_rest_stays(): void
    {
        settings()->set('chat.retention_days', 30);
        $old = $this->conversation('closed', 40);
        $older = $this->conversation('closed', 400);
        $missed = $this->conversation('missed', 90);
        $recent = $this->conversation('closed', 10);
        $active = $this->conversation('active', 0);
        $queued = $this->conversation('queued', 0);
        $oldQueued = $this->conversation('queued', 0, ['created_at' => now()->subDays(100)]);
        $files = [$old->id => $this->withFile($old), $recent->id => $this->withFile($recent), $active->id => $this->withFile($active)];

        $this->artisan('chat:prune-conversations')->assertSuccessful();

        $this->assertEqualsCanonicalizing([$recent->id, $active->id, $queued->id, $oldQueued->id], Conversation::query()->pluck('id')->all());
        $this->assertEqualsCanonicalizing([$recent->id, $active->id, $queued->id, $oldQueued->id], Message::query()->pluck('conversation_id')->all());
        $this->assertSame(4, Rating::query()->count());
        $this->assertSame([$recent->id, $active->id], Attachment::query()->orderBy('conversation_id')->pluck('conversation_id')->map(fn ($id): int => (int) $id)->sort()->values()->all());

        Storage::disk('local')->assertMissing($files[$old->id]);
        Storage::disk('local')->assertMissing(str_replace('.png', '_t.png', $files[$old->id]));
        Storage::disk('local')->assertExists($files[$recent->id]);
        Storage::disk('local')->assertExists($files[$active->id]);
        $this->assertNull(Conversation::query()->find($older->id));
        $this->assertNull(Conversation::query()->find($missed->id));

        $entry = AuditLog::query()->where('action', 'conversations.pruned')->sole();
        $this->assertSame(3, $entry->changes['conversations']);
        $this->assertSame(1, $entry->changes['attachments']);
        $this->assertStringNotContainsString('hello', (string) json_encode($entry->changes));
    }

    public function test_a_retention_of_zero_keeps_everything_and_the_default_is_zero(): void
    {
        $this->conversation('closed', 4000);

        $this->assertSame(0, settings()->int('chat.retention_days', 0));
        $this->artisan('chat:prune-conversations')->expectsOutputToContain('Retention is off')->assertSuccessful();
        $this->assertSame(1, Conversation::query()->count());
        $this->assertSame(0, AuditLog::query()->where('action', 'conversations.pruned')->count());
    }

    public function test_a_retention_that_would_beat_the_analytics_rollups_is_refused(): void
    {
        $this->conversation('closed', 4);

        $this->artisan('chat:prune-conversations', ['--days' => 3])->expectsOutputToContain('at least 7 days')->assertFailed();
        $this->assertSame(1, Conversation::query()->count());

        $this->artisan('chat:prune-conversations', ['--days' => 7])->assertSuccessful();
        $this->assertSame(1, Conversation::query()->count(), 'a conversation closed 4 days ago is not older than 7');
    }

    public function test_the_days_option_overrides_the_setting_for_one_run(): void
    {
        settings()->set('chat.retention_days', 365);
        $this->conversation('closed', 20);

        $this->artisan('chat:prune-conversations')->assertSuccessful();
        $this->assertSame(1, Conversation::query()->count());

        $this->artisan('chat:prune-conversations', ['--days' => 10])->assertSuccessful();
        $this->assertSame(0, Conversation::query()->count());
    }

    public function test_it_is_idempotent_and_works_through_more_than_one_batch(): void
    {
        settings()->set('chat.retention_days', 30);

        for ($i = 0; $i < 130; $i++) {
            $this->conversation('closed', 60 + $i);
        }

        $kept = $this->conversation('closed', 5);

        $this->artisan('chat:prune-conversations')->assertSuccessful();
        $this->assertSame([$kept->id], Conversation::query()->pluck('id')->all());

        $this->artisan('chat:prune-conversations')->assertSuccessful();
        $this->assertSame([$kept->id], Conversation::query()->pluck('id')->all());
    }

    public function test_a_conversation_whose_file_cannot_be_deleted_is_kept_and_reported(): void
    {
        settings()->set('chat.retention_days', 30);
        $stuck = $this->conversation('closed', 90);
        $free = $this->conversation('closed', 90);
        $this->withFile($stuck);
        $path = Attachment::query()->where('conversation_id', $stuck->id)->value('path');
        $disk = Storage::disk('local');
        Storage::shouldReceive('disk')->andReturn(new class($disk, $path)
        {
            public function __construct(private $disk, private string $stuckPath) {}

            public function delete(string $path): bool
            {
                return $path === $this->stuckPath ? false : $this->disk->delete($path);
            }

            public function exists(string $path): bool
            {
                return $path === $this->stuckPath || $this->disk->exists($path);
            }
        });

        $this->artisan('chat:prune-conversations')->assertFailed();

        $this->assertSame([$stuck->id], Conversation::query()->pluck('id')->all(), 'only the conversation whose file is stuck is kept');
        $this->assertNotNull(Message::query()->where('conversation_id', $stuck->id)->first());
        $this->assertNull(Conversation::query()->find($free->id));
    }

    public function test_visitors_nothing_is_left_of_are_pruned_verified_ones_included_and_others_stay(): void
    {
        settings()->set('chat.retention_days', 30);
        $gone = Visitor::factory()->verified('cust-9')->create(['widget_id' => $this->widget->id, 'last_seen_at' => now()->subDays(100), 'created_at' => now()->subDays(200)]);
        $recentlySeen = Visitor::factory()->create(['widget_id' => $this->widget->id, 'last_seen_at' => now()->subDays(2), 'created_at' => now()->subDays(200)]);
        $withChat = Visitor::factory()->create(['widget_id' => $this->widget->id, 'last_seen_at' => now()->subDays(100), 'created_at' => now()->subDays(200)]);
        $this->conversation('closed', 5, [], $withChat);
        $withSession = $this->visitorSession($this->widget)->session->visitor;
        $withSession->forceFill(['last_seen_at' => now()->subDays(100), 'created_at' => now()->subDays(200)])->save();

        $this->artisan('chat:prune-conversations')->assertSuccessful();

        $this->assertNull(Visitor::query()->find($gone->id));
        $this->assertNotNull(Visitor::query()->find($recentlySeen->id), 'seen recently');
        $this->assertNotNull(Visitor::query()->find($withChat->id), 'a conversation is left');
        $this->assertNotNull(Visitor::query()->find($withSession->id), 'a session is left');
    }

    public function test_it_is_scheduled_daily_and_the_setting_refuses_values_the_prune_would_refuse(): void
    {
        $events = collect(app(Schedule::class)->events())->filter(fn ($event): bool => str_contains((string) $event->command, 'chat:prune-conversations'));

        $this->assertCount(1, $events);
        $this->assertSame('30 4 * * *', $events->first()->expression);

        $admin = User::factory()->admin()->create();

        foreach ([1, 3, 6] as $tooShort) {
            $this->actingAs($admin, 'sanctum')->putJson('/api/v1/privacy/retention', ['days' => $tooShort])->assertUnprocessable();
            $this->app['auth']->forgetGuards();
        }

        $this->assertSame(0, settings()->int('chat.retention_days', 0));
        $this->assertSame(7, PruneConversations::MIN_DAYS);
    }

    public function test_the_retention_api_reads_and_writes_the_setting_audited_and_for_administrators_only(): void
    {
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->agent()->create();

        $this->actingAs($admin, 'sanctum')->getJson('/api/v1/privacy/retention')->assertOk()->assertJsonPath('data.days', 0)->assertJsonPath('data.minimumDays', 7);
        $this->app['auth']->forgetGuards();
        $this->actingAs($admin, 'sanctum')->putJson('/api/v1/privacy/retention', ['days' => 90])->assertOk()->assertJsonPath('data.days', 90);
        $this->assertSame(90, settings()->int('chat.retention_days', 0));
        $this->assertSame(['old' => 0, 'new' => 90], AuditLog::query()->where('action', 'settings.updated')->latest('id')->first()->changes['chat.retention_days']);

        foreach ([['days' => 5000], ['days' => -1], ['days' => 'x'], []] as $bad) {
            $this->app['auth']->forgetGuards();
            $this->actingAs($admin, 'sanctum')->putJson('/api/v1/privacy/retention', $bad)->assertUnprocessable();
        }

        $this->app['auth']->forgetGuards();
        $this->actingAs($agent, 'sanctum')->getJson('/api/v1/privacy/retention')->assertForbidden();
        $this->app['auth']->forgetGuards();
        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/privacy/retention', ['days' => 30])->assertForbidden();
        $this->assertSame(90, settings()->int('chat.retention_days', 0));
    }
}
