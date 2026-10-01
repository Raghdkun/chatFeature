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
     * @return array<int, int> category id => number of available agents (missing ids count as 0)
     */
    public function onlineAgentsByCategory(array $categoryIds): array;
}
