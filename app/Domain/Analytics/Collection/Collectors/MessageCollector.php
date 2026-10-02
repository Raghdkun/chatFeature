<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\Collection\Attribution;
use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use Illuminate\Support\Facades\DB;

/**
 * Message volume of the day (`messages.created_at`): `messages_visitor` and `messages_agent` of live chats AND offline tickets. System
 * lines are not counted. An agent's row only gets the messages that agent sent. One grouped query, however many messages there are.
 */
final class MessageCollector implements MetricCollector
{
    public function collect(DayContext $context): void
    {
        $window = $context->window;

        $rows = DB::table('messages as m')
            ->join('conversations as c', 'c.id', '=', 'm.conversation_id')
            ->where('m.created_at', '>=', $window->startDb())
            ->where('m.created_at', '<', $window->endDb())
            ->whereIn('m.sender_type', ['visitor', 'agent'])
            ->groupBy('m.sender_type', 'm.sender_user_id', 'c.widget_id', 'c.category_id')
            ->selectRaw('m.sender_type, m.sender_user_id, c.widget_id, c.category_id, COUNT(*) as total')
            ->get();

        foreach ($rows as $row) {
            $to = Attribution::conversation((int) $row->widget_id, $row->category_id === null ? null : (int) $row->category_id);
            $total = (int) $row->total;

            if ($row->sender_type === 'agent') {
                $context->metrics->add($to->byAgent($row->sender_user_id === null ? null : (int) $row->sender_user_id), 'messages_agent', $total);
            } else {
                $context->metrics->add($to, 'messages_visitor', $total);
            }
        }
    }
}
