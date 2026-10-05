<?php

namespace App\Data\Dashboard;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * What an administrator still has to do before visitors can chat, read from the real configuration (the dashboard's setup checklist).
 * Counts only: nothing here is secret.
 */
#[TypeScript]
class SetupStatusData extends Data
{
    public function __construct(
        /** Active support categories. */
        public int $categories,
        /** Widgets of any state. */
        public int $widgets,
        /** The first widget (to link to), or null when there is none. */
        public ?string $widgetUlid,
        /** Widgets that are switched on ("live"). */
        public int $widgetsLive,
        /** Live widgets that have at least one allowed domain: the ones a customer's site can actually show. */
        public int $widgetsReachable,
        /** True once any widget was published after its first version (somebody designed it). */
        public bool $widgetCustomised,
        /** Active agents who serve at least one active category (the ones chats can be offered to). */
        public int $agentsServing,
    ) {}
}
