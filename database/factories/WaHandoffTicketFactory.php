<?php

namespace Database\Factories;

use App\Models\Category;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * Default: a live ticket (valid for a day) of a visitor of a widget, for a connected session. The code comes from the model
 * (`WaHandoffTicket::generateCode()`). States: `expired()`, `consumed()`.
 *
 * @extends Factory<WaHandoffTicket>
 */
class WaHandoffTicketFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'widget_id' => Widget::factory(),
            'visitor_id' => fn (array $attributes): int => Visitor::factory()->create(['widget_id' => $attributes['widget_id']])->id,
            'category_id' => null,
            'session_id' => WhatsAppSession::factory()->ready(),
            'expires_at' => now()->addMinutes(1440),
            'consumed_at' => null,
            'wa_chat_id' => null,
        ];
    }

    public function forCategory(Category $category): static
    {
        return $this->state(fn (): array => ['category_id' => $category->id]);
    }

    /** Past its time to live, never used. */
    public function expired(): static
    {
        return $this->state(fn (): array => ['expires_at' => now()->subMinute()]);
    }

    /** Used: it linked a chat (a new one when none is given). */
    public function consumed(?WaChat $chat = null): static
    {
        return $this->state(fn (): array => ['consumed_at' => now(), 'wa_chat_id' => $chat?->id]);
    }
}
