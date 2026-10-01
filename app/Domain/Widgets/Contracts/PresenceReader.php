<?php

namespace App\Domain\Widgets\Contracts;

/**
 * Read side of agent presence, as far as widget availability needs it. P5 (Presence) provides the real
 * implementation by rebinding this interface; until then the default says nobody is online.
 */
interface PresenceReader
{
    /**
     * How many agents can take a new chat right now, per category.
     *
     * @param  list<int>  $categoryIds
     * @param  list<string>|null  $statuses  the presence statuses that count (`online`, `away`): the ones the widget's routing waves
     *                                       can offer a chat to, so "online" agrees with whether a chat can really be started;
     *                                       null = every available status
     * @return array<int, int> category id => number of available agents (missing ids count as 0)
     */
    public function onlineAgentsByCategory(array $categoryIds, ?array $statuses = null): array;
}
