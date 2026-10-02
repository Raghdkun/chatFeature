<?php

namespace Tests\Support;

use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Jobs\SendPushToUser;
use App\Domain\Notifications\Support\PushMessage;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\NotificationSetting;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Support\Facades\Bus;
use Tests\TestCase;

/**
 * A push test world: VAPID configured, a widget with one category, nobody looking at the dashboard (`$this->visibility`), and the push
 * jobs recorded instead of run (`Bus::fake`), so a test reads what would have been sent to whom.
 *
 * @mixin TestCase
 */
trait PushScenario
{
    use ChatFixtures, InteractsWithWebPush;

    protected Widget $widget;

    protected Category $billing;

    protected FakeDashboardVisibility $visibility;

    /** The bearer token of the visitor who started the latest chat (`visitorStartsChat`). */
    protected string $visitorToken = '';

    protected function arrangePushScenario(): void
    {
        $this->useFortifyMode();
        $this->useVapid();
        [$this->widget, $this->billing] = $this->chatWidget();
        $this->visibility = new FakeDashboardVisibility;
        $this->app->instance(DashboardVisibility::class, $this->visibility);
        Bus::fake([SendPushToUser::class]);
    }

    /**
     * An agent who serves the category, is reachable for routing and has a browser registered.
     *
     * @param  array<string, mixed>  $settings  `notification_settings` columns (a row is only created when given)
     */
    protected function pushableAgent(array $settings = [], bool $withDevice = true): User
    {
        $agent = $this->availableAgent($this->billing);

        if ($withDevice) {
            $this->subscribe($agent);
        }

        if ($settings !== []) {
            NotificationSetting::factory()->create(['user_id' => $agent->id] + $settings);
        }

        return $agent;
    }

    /**
     * Every push job recorded so far.
     *
     * @return list<array{user: int, message: PushMessage}>
     */
    protected function pushed(?PushType $type = null): array
    {
        $jobs = [];

        foreach (Bus::dispatched(SendPushToUser::class) as $job) {
            /** @var SendPushToUser $job */
            $message = PushMessage::fromArray($job->message);

            if ($type === null || $message->type === $type) {
                $jobs[] = ['user' => $job->userId, 'message' => $message];
            }
        }

        return $jobs;
    }

    /**
     * The users a push of this type went to, sorted.
     *
     * @return list<int>
     */
    protected function pushedTo(PushType $type): array
    {
        $ids = array_map(fn (array $job): int => $job['user'], $this->pushed($type));
        sort($ids);

        return $ids;
    }

    /** A visitor starts a chat in the category through the public API (the real routing, the real `ChatOffered`). */
    protected function visitorStartsChat(string $message = 'Hello, I was charged twice', ?string $name = 'Ann'): Conversation
    {
        $this->visitorToken = $this->visitorSession($this->widget)->plaintext;
        $response = $this->withToken($this->visitorToken)
            ->postJson('/api/v1/public/conversations', array_filter(['category' => $this->billing->slug, 'name' => $name, 'message' => $message]))
            ->assertCreated();

        return Conversation::query()->where('ulid', $response->json('data.ulid'))->firstOrFail();
    }
}
