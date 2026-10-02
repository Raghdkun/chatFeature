<?php

namespace Tests\Support;

use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Models\Category;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Carbon\CarbonImmutable;

/**
 * A reproducible many-day dataset covering every state a chat can be in: well-handled chats with ratings, transfers (to an agent and to a
 * topic), re-queues, missed, cancelled, idle and staff-closed chats, chats still open, chats that cross midnight (UTC and Berlin), offline
 * tickets answered days later, chats without a topic, plus WhatsApp chats (some linked to a widget) with replies. Everything is written
 * with exact timestamps through {@see AnalyticsWorld}; the same seed gives the same rows.
 */
final class AnalyticsDataset
{
    /** @var list<Widget> */
    public array $widgets = [];

    /** @var list<Category> */
    public array $categories = [];

    /** @var list<User> */
    public array $agents = [];

    public User $admin;

    public int $conversations = 0;

    private AnalyticsWorld $world;

    public function __construct(private readonly int $seed = 20260320)
    {
        mt_srand($this->seed);
    }

    /**
     * @return $this
     */
    public function generate(string $firstDay, int $days, int $chatsPerDay = 9, bool $withWhatsApp = true): self
    {
        $this->widgets = [Widget::factory()->create(['name' => 'Main site']), Widget::factory()->create(['name' => 'Shop'])];
        $this->categories = [
            Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']),
            Category::factory()->create(['slug' => 'sales', 'name' => 'Sales']),
            Category::factory()->create(['slug' => 'tech', 'name' => 'Tech']),
        ];

        for ($i = 1; $i <= 5; $i++) {
            $this->agents[] = User::factory()->agent()->create(['name' => "Agent {$i}"]);
        }

        $this->admin = User::factory()->admin()->create(['name' => 'Admin']);
        $this->world = new AnalyticsWorld($this->widgets[0]);
        $start = CarbonImmutable::createFromFormat('!Y-m-d', $firstDay, 'UTC');

        for ($d = 0; $d < $days; $d++) {
            $day = $start->addDays($d);

            for ($i = 0; $i < $chatsPerDay; $i++) {
                $this->one($day->addSeconds($this->moment($i)));
            }
        }

        if ($withWhatsApp) {
            $this->whatsApp($start, $days);
        }

        return $this;
    }

    /** Spread across the day, with a few right at midnight UTC and at the Berlin midnights (22:00 / 23:00 UTC). */
    private function moment(int $i): int
    {
        return match ($i % 9) {
            0 => 86400 - mt_rand(1, 400),
            1 => 22 * 3600 + mt_rand(-300, 300),
            2 => 23 * 3600 + mt_rand(-300, 300),
            3 => mt_rand(0, 600),
            default => mt_rand(0, 86399),
        };
    }

    private function one(CarbonImmutable $at): void
    {
        $this->conversations++;
        $created = $at->format('Y-m-d H:i:s');
        $widget = $this->widgets[mt_rand(0, 1)];
        $category = mt_rand(0, 9) === 0 ? null : $this->categories[mt_rand(0, 2)];

        if (mt_rand(1, 100) <= 14) {
            $this->ticket($created, $category, $widget);

            return;
        }

        $chat = $this->world->chat($created, $category, $widget);
        $a = $this->agent();
        $b = $this->agent($a);
        $chat->offeredTo(array_values(array_unique([$a, $b], SORT_REGULAR)));
        $roll = mt_rand(1, 100);

        if ($roll <= 40) {
            $this->handled($chat, $a);
            $this->finish($chat, $a);
        } elseif ($roll <= 50) {
            $this->handled($chat, $a);
            $chat->transferredTo(mt_rand(0, 1) === 0 ? $b : null, mt_rand(0, 1) === 0 ? $this->categories[mt_rand(0, 2)] : null, mt_rand(20, 400));
            $chat->claimedBy($b, mt_rand(5, 120))->agentSays(mt_rand(2, 60), 'Taking over', $b);
            $this->finish($chat, $b);
        } elseif ($roll <= 52) {
            $this->handled($chat, $a);
            $chat->transferredTo(null, null, mt_rand(20, 400))->missed(90);
        } elseif ($roll <= 62) {
            $chat->missed(mt_rand(60, 120));
        } elseif ($roll <= 68) {
            $chat->closed('cancelled', mt_rand(5, 80), 'visitor');
        } elseif ($roll <= 76) {
            $chat->claimedBy($a, mt_rand(5, 120));

            if (mt_rand(0, 1) === 0) {
                $chat->agentSays(mt_rand(2, 90));
            }

            $chat->closed('idle', mt_rand(3600, 10000));
        } elseif ($roll <= 79) {
            $chat->claimedBy($a, mt_rand(5, 120))->agentSays(mt_rand(2, 90))->closed('system', mt_rand(100, 2000), 'admin', $this->admin->id);
        } elseif ($roll <= 81) {
            $chat->closed('system', mt_rand(20, 200), 'admin', $this->admin->id);
        } elseif ($roll <= 85) {
            $chat->claimedBy($a, mt_rand(5, 120))->agentSays(mt_rand(2, 90));
        } elseif ($roll <= 87) {
            // still waiting
        } elseif ($roll <= 89) {
            $chat->claimedBy($a, mt_rand(5, 120))->agentSays(mt_rand(2, 40))->requeued(mt_rand(60, 500))->claimedBy($b, mt_rand(5, 90))->agentSays(mt_rand(2, 40), 'Hello again', $b);
            $this->finish($chat, $b);
        } else {
            $this->handled($chat, $a);
            $this->finish($chat, $a);
        }

        $chat->save();
    }

    private function handled(AnalyticsChat $chat, User $agent): void
    {
        $chat->visitorSays(mt_rand(0, 20), 'Hi')->claimedBy($agent, mt_rand(5, 180));

        if (mt_rand(1, 10) > 1) {
            $chat->agentSays(mt_rand(1, 120));
        }

        for ($n = mt_rand(0, 4); $n > 0; $n--) {
            mt_rand(0, 1) === 0 ? $chat->visitorSays(mt_rand(5, 90)) : $chat->agentSays(mt_rand(5, 90));
        }
    }

    private function finish(AnalyticsChat $chat, User $agent): void
    {
        $by = ['visitor', 'visitor', 'agent', 'agent', 'admin', 'system'][mt_rand(0, 5)];
        $chat->endedBy($by, mt_rand(30, 3000));
        $outcome = mt_rand(1, 10);

        if ($outcome <= 6) {
            $chat->rated(mt_rand(1, 5), mt_rand(5, 500));
        } elseif ($outcome <= 8) {
            $chat->closed('skipped', mt_rand(5, 60), 'visitor');
        } elseif ($outcome === 9) {
            $chat->closed('timeout', 600);
        }
        // else: ended and still waiting for the rating
    }

    private function ticket(string $created, ?Category $category, Widget $widget): void
    {
        $ticket = $this->world->ticket($created, $category, $widget)->visitorSays(0, 'Please help');
        $a = $this->agent();

        if (mt_rand(1, 10) <= 6) {
            $ticket->claimedBy($a, mt_rand(600, 3 * 86400))->agentSays(mt_rand(30, 4000), 'Answer', $a);

            if (mt_rand(1, 10) <= 7) {
                $ticket->closed('system', mt_rand(60, 2 * 86400), 'agent', $a->id);
            }
        }

        $ticket->save();
    }

    private function agent(?User $not = null): User
    {
        do {
            $agent = $this->agents[mt_rand(0, count($this->agents) - 1)];
        } while ($not !== null && $agent->is($not));

        return $agent;
    }

    private function whatsApp(CarbonImmutable $start, int $days): void
    {
        $session = WhatsAppSession::factory()->ready()->create();

        for ($d = 0; $d < $days; $d++) {
            $day = $start->addDays($d);

            for ($c = 0; $c < 3; $c++) {
                $created = $day->addSeconds($this->moment($c * 3 + 1));
                $linked = mt_rand(0, 2) === 0;
                $chat = WaChat::factory()->create([
                    'session_id' => $session->id,
                    'created_at' => $created,
                    'updated_at' => $created,
                    'widget_id' => $linked ? $this->widgets[mt_rand(0, 1)]->id : null,
                ]);
                $at = $created;

                for ($m = mt_rand(1, 6); $m > 0; $m--) {
                    $at = $at->addSeconds(mt_rand(5, 5000));
                    $outbound = mt_rand(0, 2) === 0;
                    $status = $outbound ? [WaMessageStatus::Sent, WaMessageStatus::Delivered, WaMessageStatus::Read, WaMessageStatus::Failed, WaMessageStatus::Pending][mt_rand(0, 4)] : WaMessageStatus::Received;

                    WaMessage::factory()->create([
                        'wa_chat_id' => $chat->id,
                        'direction' => $outbound ? WaDirection::Out : WaDirection::In,
                        'status' => $status,
                        'sent_by_user_id' => $outbound ? $this->admin->id : null,
                        'wa_message_id' => $status === WaMessageStatus::Pending ? null : 'm'.$chat->id.'_'.$m.'_'.mt_rand(1000, 9999),
                        'wa_timestamp' => $at,
                        'created_at' => $at,
                        'updated_at' => $at,
                    ]);
                }
            }
        }
    }
}
