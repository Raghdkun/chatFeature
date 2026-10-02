<?php

namespace App\Support\ApiDocs;

/**
 * Human text for the named rate limiters, with the numbers read from the same config the limiters use
 * (`config/chat.php` `rate_limits`, `config/whatsapp.php`, `config/push.php`, `config/broadcasting.php`), so the reference states
 * the real defaults. All limiters count per minute; an exhausted one answers `429 rate_limited` with `Retry-After`.
 */
final class RateLimitDocs
{
    /**
     * One sentence per limiter name, or `null` for a limiter this class does not know (the rot guard fails on those).
     */
    public static function describe(string $limiter): ?string
    {
        $chat = static fn (string $key, int $default): int => (int) config('chat.rate_limits.'.$key, $default);

        return match ($limiter) {
            'login' => sprintf('`login`: %d sign-in attempts a minute per email and client address, %d per client address and %d per email from any address. The SAME budget as the dashboard login, so an attacker gains nothing by using both; every call counts, and a wrong password additionally counts toward a lock-out of that email and address.', (int) config('chat.login_throttle.per_email_and_ip', 5), (int) config('chat.login_throttle.per_ip', 30), (int) config('chat.login_throttle.per_email', 10)),
            'staff-two-factor' => sprintf('`staff-two-factor`: %d calls a minute per client address and 10 per challenge. Wrong codes are also counted per account (%d a minute, %d an hour, across challenges) and per challenge (%d, then it burns).', (int) config('staff_auth.two_factor.per_ip', 30), (int) config('staff_auth.two_factor.per_user_per_minute', 5), (int) config('staff_auth.two_factor.per_user_per_hour', 20), (int) config('staff_auth.two_factor.challenge_attempts', 5)),
            'staff-api' => sprintf('`staff-api`: %d calls a minute per staff member.', $chat('staff_api_user', 600)),
            'public-config' => sprintf('`public-config`: %d calls a minute per client network across all widget keys (counted before the key is looked up; lookups of unknown keys are limited harder, %d a minute).', $chat('public_ip', 600), $chat('public_unknown_keys', 60)),
            'public-config-widget' => sprintf('`public-config-widget`: %d a minute per client network and widget key, and %d a minute per widget and allowed origin.', $chat('public_widget_ip', 300), $chat('public_widget_origin', 6000)),
            'public-session' => sprintf('`public-session`: %d a minute per client network and %d a minute per client network and widget key.', $chat('public_session_ip', 60), $chat('public_session_widget', 30)),
            'public-network' => sprintf('`public-network`: %d visitor calls a minute per client network, counted before the token is looked up.', $chat('public_visitor_ip', 600)),
            'public-message' => sprintf('`public-message`: %d calls a minute per visitor session (**%d for message sends**) and %d per client network; starting a chat is also limited per widget and network (%d) and per widget (%d).', $chat('public_chat_session', 240), $chat('public_message_session', 30), $chat('public_chat_ip', 600), $chat('start_per_widget_network', 3), $chat('start_per_widget', 120)),
            'public-upload' => sprintf('`public-upload`: %d uploads a minute per visitor session, and the %d a minute per client network ceiling.', $chat('public_upload_session', 10), $chat('public_chat_ip', 600)),
            'public-offline' => sprintf('`public-offline`: %d offline tickets a minute per visitor session, %d per client network, and per widget and network (%d) and per widget (%d).', $chat('public_offline_session', 3), $chat('public_offline_ip', 10), $chat('offline_per_widget_network', 3), $chat('offline_per_widget', 120)),
            'broadcasting-auth' => sprintf('`broadcasting-auth`: %d a minute per token and %d per client network.', (int) config('broadcasting.realtime.auth_rate_limits.per_token', 30), (int) config('broadcasting.realtime.auth_rate_limits.per_network', 120)),
            'push-subscriptions' => sprintf('`push-subscriptions`: %d a minute per staff member.', (int) config('push.rate_limits.subscriptions_per_minute', 20)),
            'push-test' => sprintf('`push-test`: %d a minute per staff member (it sends a real push).', (int) config('push.rate_limits.test_per_minute', 3)),
            'wa-qr' => sprintf('`wa-qr`: %d a minute per administrator.', (int) config('whatsapp.admin_rate_limits.qr', 60)),
            'wa-test' => sprintf('`wa-test`: %d a minute per administrator.', (int) config('whatsapp.admin_rate_limits.test', 10)),
            'wa-handoff' => sprintf('`wa-handoff`: %d a minute per visitor, %d per client network, %d per widget and network and %d per widget (plus the live-code caps described on the endpoint).', (int) config('whatsapp.handoff.rate_limits.per_visitor', 6), (int) config('whatsapp.handoff.rate_limits.per_network', 20), (int) config('whatsapp.handoff.rate_limits.per_widget_network', 10), (int) config('whatsapp.handoff.rate_limits.per_widget', 120)),
            'wa-webhook' => sprintf('`wa-webhook`: %d a minute per session and client network, %d per client network.', (int) config('whatsapp.webhook.rate_limits.per_session', 3000), (int) config('whatsapp.webhook.rate_limits.per_network', 6000)),
            default => null,
        };
    }

    /**
     * The limiters of a route as a Markdown list.
     *
     * @param  list<string>  $limiters
     */
    public static function markdown(array $limiters): string
    {
        $lines = [];

        foreach ($limiters as $limiter) {
            $lines[] = '- '.(self::describe($limiter) ?? "`{$limiter}`");
        }

        return implode("\n", $lines);
    }

    /**
     * The table of every limiter a reference mentions, for its introduction.
     *
     * @param  list<string>  $limiters
     */
    public static function table(array $limiters): string
    {
        $rows = ['| Limiter | Budget (per minute) |', '|---|---|'];

        foreach ($limiters as $limiter) {
            $text = self::describe($limiter) ?? '';
            $text = preg_replace('/^`[^`]+`:\s*/', '', $text) ?? $text;
            $rows[] = "| `{$limiter}` | ".$text.' |';
        }

        return implode("\n", $rows);
    }
}
