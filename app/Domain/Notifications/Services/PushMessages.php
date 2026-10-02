<?php

namespace App\Domain\Notifications\Services;

use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Services\MessageText;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Support\PushMessage;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use Carbon\CarbonInterface;

/**
 * Builds the pushes (decision P5-D5), in the recipient's language. The text is deliberately thin: an offer says the topic (and, with
 * previews on, the visitor's first words), a message the visitor's name and words. With previews OFF nothing the visitor typed
 * (not even their name) leaves the server: "New chat request" / "New message" and the topic only. No integer id, no e-mail address.
 */
class PushMessages
{
    /** An offer's notification is replaced / closed by this tag (the page uses the same one: `offerTag()` in the staff controller). */
    public static function offerTag(string $conversationUlid): string
    {
        return 'offer-'.$conversationUlid;
    }

    /** The conversation an offer tag belongs to, or null when the tag is not an offer's. */
    public static function conversationOfOfferTag(string $tag): ?string
    {
        return str_starts_with($tag, 'offer-') && strlen($tag) > 6 ? substr($tag, 6) : null;
    }

    /** The notification of a chat's messages (one per chat: the newest message replaces the previous one). */
    public static function chatTag(string $conversationUlid): string
    {
        return 'chat-'.$conversationUlid;
    }

    public function offer(Conversation $conversation, User $recipient, bool $includePreview, CarbonInterface $expiresAt): PushMessage
    {
        $locale = $this->locale($recipient);
        $topic = $conversation->category->name ?? $this->t('notifications.push.topic_none', $locale);
        $preview = $includePreview ? $this->preview($conversation->last_message_preview) : null;

        return new PushMessage(
            type: PushType::Offer,
            tag: self::offerTag($conversation->ulid),
            title: $this->t('notifications.push.offer_title', $locale),
            body: $preview === null ? $topic : $topic.' - '.$preview,
            url: '/inbox/'.$conversation->ulid,
            ttl: max(1, min(3600, $expiresAt->getTimestamp() - now()->getTimestamp())),
            urgency: 'high',
            renotify: false,
            requireInteraction: true,
        );
    }

    public function visitorMessage(Conversation $conversation, Message $message, User $recipient, bool $includePreview): PushMessage
    {
        $locale = $this->locale($recipient);
        $name = MessageText::singleLine($conversation->visitor->name, 60) ?? $this->t('notifications.push.visitor', $locale);

        if ($includePreview) {
            $title = $this->t('notifications.push.message_title', $locale, ['name' => $name]);
            $body = $message->type === MessageType::Image && $message->body === null
                ? $this->t('notifications.push.image_body', $locale)
                : ($this->preview($message->body) ?? $this->t('notifications.push.image_body', $locale));
        } else {
            $title = $this->t('notifications.push.message_title_private', $locale);
            $body = $this->t('notifications.push.message_body_private', $locale);
        }

        return new PushMessage(
            type: PushType::Message,
            tag: self::chatTag($conversation->ulid),
            title: $title,
            body: $body,
            url: '/inbox/'.$conversation->ulid,
            ttl: max(60, (int) config('push.message_ttl_seconds', 900)),
            urgency: 'normal',
            renotify: true,
        );
    }

    public function test(User $recipient): PushMessage
    {
        $locale = $this->locale($recipient);

        return new PushMessage(
            type: PushType::Test,
            tag: 'test-'.$recipient->id,
            title: $this->t('notifications.push.test_title', $locale),
            body: $this->t('notifications.push.test_body', $locale),
            url: '/settings/notifications',
            ttl: 120,
            urgency: 'high',
            renotify: true,
        );
    }

    private function preview(?string $text): ?string
    {
        return MessageText::preview($text, max(20, (int) config('push.preview_max_length', 120)));
    }

    /** The recipient's own language, else the application's. */
    private function locale(User $user): string
    {
        $own = is_string($user->locale) ? $user->locale : '';
        $supported = (array) config('chat.locales', ['en']);

        return in_array($own, $supported, true) ? $own : settings()->string('app.locale', (string) config('app.locale'));
    }

    /**
     * @param  array<string, string>  $replace
     */
    private function t(string $key, string $locale, array $replace = []): string
    {
        return (string) trans($key, $replace, $locale);
    }
}
