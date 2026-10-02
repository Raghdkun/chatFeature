<?php

namespace Database\Factories;

use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Models\Category;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * Default: an open one-to-one chat of a connected session that the customer started, with no message and no link to a widget. States:
 * `group()`, `archived()`, `unread()`, `outboundOnly()`, and `linked()` (a consumed hand-off ticket matched it to a widget visitor).
 *
 * @extends Factory<WaChat>
 */
class WaChatFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $digits = fake()->unique()->numerify('491#########');

        return [
            'workspace_id' => null,
            'session_id' => WhatsAppSession::factory()->ready(),
            'chat_id' => $digits.'@c.us',
            'phone_e164' => '+'.$digits,
            'push_name' => fake()->name(),
            'is_group' => false,
            'status' => WaChatStatus::Open,
            'widget_id' => null,
            'visitor_id' => null,
            'category_id' => null,
            'handoff_ticket_id' => null,
            'last_inbound_at' => null,
            'last_message_at' => null,
            'last_message_preview' => null,
            'unread_by_admin' => 0,
            'inbound_initiated' => true,
        ];
    }

    /** A WhatsApp group: no number, the name is the group's subject. */
    public function group(): static
    {
        return $this->state(fn (): array => [
            'chat_id' => fake()->unique()->numerify('120363##########').'@g.us',
            'phone_e164' => null,
            'push_name' => fake()->words(2, true),
            'is_group' => true,
        ]);
    }

    /** A customer who identifies by a WhatsApp privacy id (no number known). */
    public function privacyId(): static
    {
        return $this->state(fn (): array => ['chat_id' => fake()->unique()->numerify('##############').'@lid', 'phone_e164' => null]);
    }

    public function archived(): static
    {
        return $this->state(fn (): array => ['status' => WaChatStatus::Archived]);
    }

    /** Inbound messages no administrator has opened yet. */
    public function unread(int $count = 1): static
    {
        return $this->state(fn (): array => ['unread_by_admin' => $count, 'last_inbound_at' => now(), 'last_message_at' => now()]);
    }

    /** A chat the application wrote into first (outbound-initiated: replies are refused while `whatsapp.reply_only_to_inbound` is on). */
    public function outboundOnly(): static
    {
        return $this->state(fn (): array => ['inbound_initiated' => false]);
    }

    /**
     * Matched to a widget visitor by a consumed hand-off ticket (the widget, visitor and topic are created unless given).
     */
    public function linked(?Widget $widget = null, ?Visitor $visitor = null, ?Category $category = null): static
    {
        return $this->afterCreating(function (WaChat $chat) use ($widget, $visitor, $category): void {
            $widget ??= $visitor !== null ? $visitor->widget : Widget::factory()->create();
            $visitor ??= Visitor::factory()->create(['widget_id' => $widget->id]);

            $ticket = WaHandoffTicket::factory()->consumed()->create([
                'widget_id' => $widget->id,
                'visitor_id' => $visitor->id,
                'category_id' => $category?->id,
                'session_id' => $chat->session_id,
                'wa_chat_id' => $chat->id,
            ]);

            $chat->forceFill([
                'widget_id' => $widget->id,
                'visitor_id' => $visitor->id,
                'category_id' => $category?->id,
                'handoff_ticket_id' => $ticket->id,
            ])->save();
        });
    }
}
