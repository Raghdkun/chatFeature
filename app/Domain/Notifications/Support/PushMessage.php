<?php

namespace App\Domain\Notifications\Support;

use App\Domain\Notifications\Enums\PushType;

/**
 * What a push says (decision P5-D5). The browser's push protocol encrypts it end to end, and it is small on purpose: a title, a body,
 * and `data.{url, tag, type}`; never an integer id or an e-mail address.
 *
 * `tag` is the key the service worker (and the page's own notification) replaces by: the same tag shows ONE notification, and a
 * `dismiss` with that tag closes it. `ttl` is how long a push service keeps the message for a device that is offline (seconds); an
 * offer's TTL is the time it has left, so a phone that wakes up after the offer expired never rings for it.
 */
final readonly class PushMessage
{
    public const URGENCIES = ['very-low', 'low', 'normal', 'high'];

    public function __construct(
        public PushType $type,
        public string $tag,
        public ?string $title,
        public ?string $body,
        public string $url,
        public int $ttl,
        public string $urgency = 'normal',
        public bool $renotify = false,
        public bool $requireInteraction = false,
    ) {}

    /** The silent push that closes the notification with this tag. */
    public static function dismiss(string $tag, int $ttl = 120): self
    {
        return new self(PushType::Dismiss, $tag, null, null, '/inbox', $ttl, 'high');
    }

    public function isSilent(): bool
    {
        return $this->type === PushType::Dismiss;
    }

    /**
     * The JSON the service worker receives.
     *
     * @return array<string, mixed>
     */
    public function payload(): array
    {
        $payload = ['v' => 1];

        if (! $this->isSilent()) {
            $payload['title'] = $this->title ?? '';
            $payload['body'] = $this->body ?? '';
            $payload['renotify'] = $this->renotify;
            $payload['requireInteraction'] = $this->requireInteraction;
        }

        $payload['data'] = ['url' => $this->url, 'tag' => $this->tag, 'type' => $this->type->value];

        return $payload;
    }

    /**
     * The `Topic` header: a push service replaces an undelivered message with the same topic by the newer one (an offline phone never
     * wakes up for an offer that was already dismissed). At most 32 URL-safe characters.
     */
    public function topic(): string
    {
        return substr(rtrim(strtr(base64_encode(hash('sha256', $this->tag, true)), '+/', '-_'), '='), 0, 32);
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'type' => $this->type->value,
            'tag' => $this->tag,
            'title' => $this->title,
            'body' => $this->body,
            'url' => $this->url,
            'ttl' => $this->ttl,
            'urgency' => $this->urgency,
            'renotify' => $this->renotify,
            'requireInteraction' => $this->requireInteraction,
        ];
    }

    /**
     * @param  array<string, mixed>  $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            type: PushType::from((string) $data['type']),
            tag: (string) $data['tag'],
            title: isset($data['title']) ? (string) $data['title'] : null,
            body: isset($data['body']) ? (string) $data['body'] : null,
            url: (string) $data['url'],
            ttl: (int) $data['ttl'],
            urgency: in_array($data['urgency'] ?? null, self::URGENCIES, true) ? (string) $data['urgency'] : 'normal',
            renotify: (bool) ($data['renotify'] ?? false),
            requireInteraction: (bool) ($data['requireInteraction'] ?? false),
        );
    }
}
