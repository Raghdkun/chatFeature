<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Services\RoutingPlan;
use App\Models\Conversation;

/**
 * Safety net of the delayed `OfferNextWave` jobs (`chat:offer-waves`, every minute): a queued live chat whose next routing wave is
 * due (`queued_at` plus the wave's delay has passed) but was never made gets it now. Needed when a job was lost or failed, and
 * with the `sync` queue driver, which runs a delayed job at once and so too early. `OfferToAgents::wave()` is idempotent (an agent
 * who has an offer is never offered again), so running a wave twice is harmless; waves are cumulative, so only the last due wave
 * is run.
 */
final class OfferDueWaves
{
    public const CHUNK = 200;

    /** The most waves a widget plan can have (`WidgetConfigValidator`: `routing.waves` max 5). */
    private const MAX_WAVES = 5;

    public function __construct(private readonly OfferToAgents $offers) {}

    /** Make every due wave; returns how many chats advanced. */
    public function sweep(): int
    {
        $advanced = 0;
        $afterId = 0;
        $plans = [];
        $now = now();

        do {
            $chats = Conversation::query()
                ->with('widget')
                ->where('status', ConversationStatus::Queued->value)
                ->where('type', ConversationType::Live->value)
                ->where('wave', '<', self::MAX_WAVES)
                ->whereNotNull('queued_at')
                ->whereNotNull('queue_expires_at')
                ->where('queue_expires_at', '>', $now)
                ->where('id', '>', $afterId)
                ->orderBy('id')
                ->limit(self::CHUNK)
                ->get();

            foreach ($chats as $chat) {
                $afterId = $chat->id;
                $plans[$chat->widget_id] ??= RoutingPlan::forWidget($chat->widget);
                $due = $plans[$chat->widget_id]->dueWave($chat->queued_at, $now);

                if ($due > (int) $chat->wave) {
                    $this->offers->wave($chat, $due, (int) $chat->claim_version);
                    $advanced++;
                }
            }
        } while ($chats->count() === self::CHUNK);

        return $advanced;
    }
}
