<?php

namespace App\Providers;

use App\Domain\Catalog\Contracts\CategoryUsageChecker;
use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Chat\Listeners\RequeueDeactivatedAgentConversations;
use App\Domain\Chat\Policies\ConversationPolicy;
use App\Domain\Chat\Support\ConversationCategoryUsageChecker;
use App\Domain\Chat\Support\SignedAttachmentUrls;
use App\Domain\Widgets\Support\ClientNetwork;
use App\Models\Conversation;
use App\Models\VisitorSession;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Conversation lifecycle, messages, attachments, ratings (P4).
 *
 * Owns the bindings of the chat context: the conversation policy, signed attachment URLs and the category usage guard
 * (a queued or active conversation keeps its category from being deleted). Keep bindings and boot logic for this bounded
 * context here so parallel tracks never edit the same provider.
 *
 * It also defines the named rate limiters of the chat API (decision P4-D10, plus `public-network` in front of the visitor
 * authentication; numbers in `config/chat.php`, `rate_limits`) and
 * listens for `StaffSessionRevoked` (a deactivated agent's chats go back to the queue).
 */
class ChatServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bindIf(AttachmentUrls::class, SignedAttachmentUrls::class);
        $this->app->bind(CategoryUsageChecker::class, ConversationCategoryUsageChecker::class);
    }

    public function boot(): void
    {
        Gate::policy(Conversation::class, ConversationPolicy::class);

        Event::listen(StaffSessionRevoked::class, RequeueDeactivatedAgentConversations::class);

        $this->configureRateLimiting();
    }

    /**
     * Visitor limits key on the sha256 of the bearer token (and on the client network as a second ceiling); the staff limit on the
     * signed-in user. All are per minute.
     */
    private function configureRateLimiting(): void
    {
        RateLimiter::for('public-session', fn (Request $request): array => [
            Limit::perMinute($this->limit('public_session_ip', 60))->by('chat-session-ip:'.ClientNetwork::bucket($request->ip())),
            Limit::perMinute($this->limit('public_session_widget', 30))->by('chat-session-key:'.ClientNetwork::bucket($request->ip()).':'.$request->route('key')),
        ]);

        RateLimiter::for('public-message', function (Request $request): array {
            $subject = $this->visitorKey($request);
            $limits = [
                Limit::perMinute($this->limit('public_chat_ip', 600))->by('chat-ip:'.ClientNetwork::bucket($request->ip())),
                Limit::perMinute($this->limit('public_chat_session', 240))->by('chat-call:'.$subject),
            ];

            if ($request->isMethod('POST') && $request->routeIs('api.public.messages.store')) {
                $limits[] = Limit::perMinute($this->limit('public_message_session', 30))->by('chat-message:'.$subject);
            }

            if ($request->isMethod('POST') && $request->routeIs('api.public.conversations.store')) {
                $limits = [...$limits, ...$this->perWidgetBudgets($request, 'chat-start', 'start_per_widget_network', 'start_per_widget')];
            }

            return $limits;
        });

        RateLimiter::for('public-upload', fn (Request $request): array => [
            Limit::perMinute($this->limit('public_upload_session', 10))->by('chat-upload:'.$this->visitorKey($request)),
            Limit::perMinute($this->limit('public_chat_ip', 600))->by('chat-ip:'.ClientNetwork::bucket($request->ip())),
        ]);

        RateLimiter::for('public-offline', fn (Request $request): array => [
            Limit::perMinute($this->limit('public_offline_session', 3))->by('chat-offline:'.$this->visitorKey($request)),
            Limit::perMinute($this->limit('public_offline_ip', 10))->by('chat-offline-ip:'.ClientNetwork::bucket($request->ip())),
            ...$this->perWidgetBudgets($request, 'chat-offline-widget', 'offline_per_widget_network', 'offline_per_widget'),
        ]);

        // In front of the `visitor` middleware: unknown bearer tokens must not each cost a lookup.
        RateLimiter::for('public-network', fn (Request $request): Limit => Limit::perMinute($this->limit('public_visitor_ip', 600))
            ->by('chat-visitor-ip:'.ClientNetwork::bucket($request->ip())));

        RateLimiter::for('staff-api', fn (Request $request): Limit => Limit::perMinute($this->limit('staff_api_user', 600))
            ->by('chat-staff:'.($request->user()?->getAuthIdentifier() ?? ClientNetwork::bucket($request->ip()))));
    }

    /**
     * The anti-automation budgets of a "creates work for agents" call: per widget + client network, and per widget overall. The
     * widget comes from the authenticated session (these limiters run after `visitor`).
     *
     * @return list<Limit>
     */
    private function perWidgetBudgets(Request $request, string $prefix, string $networkKey, string $widgetKey): array
    {
        $session = $request->attributes->get('visitor_session');
        $widget = $session instanceof VisitorSession ? (string) $session->widget_id : '-';

        return [
            Limit::perMinute($this->limit($networkKey, 3))->by($prefix.':'.$widget.':'.ClientNetwork::bucket($request->ip())),
            Limit::perMinute($this->limit($widgetKey, 120))->by($prefix.'-all:'.$widget),
        ];
    }

    private function limit(string $key, int $default): int
    {
        return max(1, (int) config('chat.rate_limits.'.$key, $default));
    }

    /** Who a visitor request counts as: the token's hash (never the token itself in the cache key), else the client network. */
    private function visitorKey(Request $request): string
    {
        $token = $request->bearerToken();

        return $token !== null && $token !== '' ? hash('sha256', $token) : 'ip:'.ClientNetwork::bucket($request->ip());
    }
}
