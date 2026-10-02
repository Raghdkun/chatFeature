<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\VisitorSession;
use App\Models\WaHandoffTicket;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Carbon;
use Illuminate\Validation\ValidationException;

/**
 * A visitor chooses WhatsApp (`POST /public/widgets/{key}/whatsapp-handoff`, decision P6-D3): they get an 8-character code and the
 * `https://wa.me/<number>?text=...` link that opens WhatsApp with the code typed in; the first message the customer sends carries it and
 * `ChatLinker` attaches the chat to this widget, visitor and topic.
 *
 * Offered only when it works: the global switch (`whatsapp.enabled`) and the widget's PUBLISHED `features.whatsapp` are on
 * (`403 feature_disabled`) and a `ready` session with a number is linked to the widget (`409 whatsapp_unavailable`). The topic, when
 * given, must be an active category of the widget (`422`). A visitor who asks again while a ticket for the same session and topic is
 * still live gets THAT ticket back (so refreshing the panel, a double click or a script cannot mint codes), and one visitor can create at
 * most {@see self::MAX_TICKETS_PER_DAY} tickets a day. A visitor is only a bearer token, and a script gets a new one for free, so the
 * per-visitor cap alone is no bound: the number of LIVE, unconsumed tickets is capped per client network and widget
 * (`whatsapp.handoff.max_live_per_widget_network`, 30) and per widget (`whatsapp.handoff.max_live_per_widget`, 500), `429` beyond.
 * The number is never returned except inside the link.
 */
final class CreateHandoff
{
    public const MAX_TICKETS_PER_DAY = 10;

    private const ATTEMPTS = 3;

    public function __construct(private readonly WidgetConfigValidator $configs) {}

    /**
     * @return array{ticket: WaHandoffTicket, created: bool}
     */
    public function handle(VisitorSession $session, ?string $categorySlug): array
    {
        $widget = $session->widget;

        if (! settings()->bool('whatsapp.enabled', false) || ! $this->configs->hydrate($widget->config)->features->whatsapp) {
            throw ApiProblemException::forbidden('feature_disabled', __('WhatsApp is not available in this chat.'));
        }

        $whatsApp = $widget->whatsappSession;

        if ($whatsApp === null || ! $whatsApp->isUsable() || $whatsApp->phone_e164 === null) {
            throw ApiProblemException::conflict('whatsapp_unavailable', __('WhatsApp is not available right now.'));
        }

        $category = $this->category($widget->id, $categorySlug);

        $live = WaHandoffTicket::query()
            ->live()
            ->where('visitor_id', $session->visitor_id)
            ->where('session_id', $whatsApp->id)
            ->where('widget_id', $widget->id)
            ->when($category === null, fn ($query) => $query->whereNull('category_id'), fn ($query) => $query->where('category_id', $category?->id))
            ->orderByDesc('id')
            ->first();

        if ($live !== null) {
            return ['ticket' => $live->setRelation('session', $whatsApp), 'created' => false];
        }

        if (WaHandoffTicket::query()->where('visitor_id', $session->visitor_id)->where('created_at', '>=', now()->subDay())->count() >= self::MAX_TICKETS_PER_DAY) {
            throw ApiProblemException::rateLimited(__('Too many codes were requested. Please try again later.'), 3600);
        }

        $this->guardLiveTickets($widget->id, $session->network_hash);

        $ttl = max(5, settings()->int('whatsapp.handoff_ttl_minutes', 1440));

        for ($attempt = 1; ; $attempt++) {
            try {
                $ticket = WaHandoffTicket::query()->create([
                    'widget_id' => $widget->id,
                    'visitor_id' => $session->visitor_id,
                    'category_id' => $category?->id,
                    'session_id' => $whatsApp->id,
                    'network_hash' => $session->network_hash,
                    'expires_at' => now()->addMinutes($ttl),
                ]);

                return ['ticket' => $ticket->setRelation('session', $whatsApp), 'created' => true];
            } catch (UniqueConstraintViolationException $exception) {
                // Two visitors drew the same code at the same instant (the unique index decides): draw again.
                if ($attempt >= self::ATTEMPTS) {
                    throw $exception;
                }
            }
        }
    }

    /**
     * The caps on live (not consumed, not expired) tickets: per client network within the widget, and per widget. An expired or consumed
     * ticket frees its place.
     *
     * @throws ApiProblemException
     */
    private function guardLiveTickets(int $widgetId, ?string $networkHash): void
    {
        $live = fn () => WaHandoffTicket::query()->live()->where('widget_id', $widgetId);

        if ($networkHash !== null && $live()->where('network_hash', $networkHash)->count() >= max(1, (int) config('whatsapp.handoff.max_live_per_widget_network', 30))) {
            throw ApiProblemException::rateLimited(__('Too many codes were requested. Please try again later.'), $this->retryAfter($live()->where('network_hash', $networkHash)));
        }

        if ($live()->count() >= max(1, (int) config('whatsapp.handoff.max_live_per_widget', 500))) {
            throw ApiProblemException::rateLimited(__('Too many codes were requested. Please try again later.'), $this->retryAfter($live()));
        }
    }

    /**
     * Seconds until the first of these tickets expires and makes room (at least a minute, at most an hour).
     *
     * @param  Builder<WaHandoffTicket>  $tickets
     */
    private function retryAfter(Builder $tickets): int
    {
        $first = $tickets->min('expires_at');
        $seconds = $first === null ? 3600 : (int) now()->diffInSeconds(Carbon::parse($first), false);

        return max(60, min(3600, $seconds));
    }

    /**
     * @throws ValidationException
     */
    private function category(int $widgetId, ?string $slug): ?Category
    {
        if ($slug === null) {
            return null;
        }

        $category = Category::query()
            ->where('categories.is_active', true)
            ->where('categories.slug', $slug)
            ->whereHas('widgets', fn ($query) => $query->where('widgets.id', $widgetId))
            ->first();

        return $category ?? throw ValidationException::withMessages(['category' => [__('This topic is not available.')]]);
    }
}
