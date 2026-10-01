<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\Category;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `GET /public/widgets/{key}/availability` must promise exactly what `POST /public/conversations` then delivers: only agents the
 * widget's routing waves can offer a chat to count as "online".
 */
class AvailabilityRoutingAgreementTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
    }

    /**
     * @param  list<array{afterSeconds: int, statuses: list<string>}>  $waves
     */
    private function useWaves(array $waves): void
    {
        $config = $this->widget->config;
        $config['routing']['waves'] = $waves;
        $this->widget->forceFill(['config' => $config])->save();
        $this->widget->refresh();
    }

    /**
     * @return array{online: bool, category: bool, startStatus: int}
     */
    private function observe(): array
    {
        $availability = $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->getJson('/api/v1/public/widgets/'.$this->widget->public_key.'/availability')->assertOk();
        $start = $this->withToken($this->visitorSession($this->widget)->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann']);

        return [
            'online' => (bool) $availability->json('data.online'),
            'category' => (bool) $availability->json('data.categories.0.online'),
            'startStatus' => $start->status(),
        ];
    }

    /**
     * @return iterable<string, array{list<array{afterSeconds: int, statuses: list<string>}>, PresenceStatus, bool}>
     */
    public static function scenarios(): iterable
    {
        $onlineOnly = [['afterSeconds' => 0, 'statuses' => ['online']]];
        $onlineThenAway = [['afterSeconds' => 0, 'statuses' => ['online']], ['afterSeconds' => 20, 'statuses' => ['away']]];
        $awayOnly = [['afterSeconds' => 0, 'statuses' => ['away']]];
        $offlineOnly = [['afterSeconds' => 0, 'statuses' => ['offline']]];

        yield 'online-only plan, away agent' => [$onlineOnly, PresenceStatus::Away, false];
        yield 'online-only plan, online agent' => [$onlineOnly, PresenceStatus::Online, true];
        yield 'default-like plan, away agent' => [$onlineThenAway, PresenceStatus::Away, true];
        yield 'away-only plan, online agent' => [$awayOnly, PresenceStatus::Online, false];
        yield 'away-only plan, away agent' => [$awayOnly, PresenceStatus::Away, true];
        yield 'plan that offers nobody' => [$offlineOnly, PresenceStatus::Online, false];
    }

    /**
     * @param  list<array{afterSeconds: int, statuses: list<string>}>  $waves
     */
    #[DataProvider('scenarios')]
    public function test_availability_and_the_start_of_a_chat_agree(array $waves, PresenceStatus $agent, bool $expected): void
    {
        $this->useWaves($waves);
        $this->availableAgent($this->billing, status: $agent);

        $seen = $this->observe();

        $this->assertSame($expected, $seen['online'], 'availability.online');
        $this->assertSame($expected, $seen['category'], 'availability.categories[0].online');
        $this->assertSame($expected ? 201 : 409, $seen['startStatus'], 'POST /public/conversations');
    }

    public function test_the_default_plan_counts_online_and_away_agents(): void
    {
        $this->availableAgent($this->billing, status: PresenceStatus::Away);

        $seen = $this->observe();

        $this->assertTrue($seen['online']);
        $this->assertSame(201, $seen['startStatus']);
    }
}
