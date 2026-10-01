<?php

namespace App\Domain\Widgets\Support;

use App\Models\Widget;
use Illuminate\Contracts\Cache\Repository;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Per-widget cache namespace. Every cached artefact of a widget (resolved boot config, availability) is keyed
 * with the widget's current revision token; `bust()` swaps the token, which orphans all of them at once
 * (they simply expire) without needing cache tags.
 *
 * `bust()` waits for the surrounding database transaction to commit: a cache shared between processes (Redis) must not
 * be refilled with the OLD rows by a reader that runs between the bust and the commit.
 *
 * Two small, key-based (not revision-based) markers for the public endpoints live here as well: keys that do not
 * exist (so probing random keys costs one lookup per key and 30 s, not one per request) and (key, origin) pairs that
 * passed the origin check recently (so a 429 can still carry CORS headers without touching the database).
 */
final class WidgetCache
{
    /** The revision token outlives every artefact it guards (their lifetimes are minutes) without living forever. */
    private const REVISION_SECONDS = 2_592_000;

    /** How long a key that does not exist is remembered as such. */
    public const UNKNOWN_KEY_SECONDS = 30;

    /** How long a (key, origin) pair that passed the origin check is remembered. */
    public const ALLOWED_ORIGIN_SECONDS = 300;

    public function __construct(private readonly Repository $cache) {}

    public function key(Widget $widget, string $kind, string ...$parts): string
    {
        return implode(':', ['widgets', $widget->ulid, $this->revision($widget), $kind, ...$parts]);
    }

    /**
     * Invalidate everything cached for the widget (publish, settings, domains, greetings, categories), once the
     * surrounding transaction (if any) has committed.
     */
    public function bust(Widget $widget): void
    {
        $ulid = $widget->ulid;
        $publicKey = $widget->public_key;

        DB::afterCommit(function () use ($ulid, $publicKey): void {
            $this->cache->put($this->revisionKeyFor($ulid), Str::lower(Str::random(10)), self::REVISION_SECONDS);
            $this->forgetUnknownKey($publicKey);
        });
    }

    public function repository(): Repository
    {
        return $this->cache;
    }

    public function isUnknownKey(string $publicKey): bool
    {
        return $this->cache->has($this->unknownKeyKey($publicKey));
    }

    public function rememberUnknownKey(string $publicKey): void
    {
        $this->cache->put($this->unknownKeyKey($publicKey), true, self::UNKNOWN_KEY_SECONDS);
    }

    public function forgetUnknownKey(string $publicKey): void
    {
        $this->cache->forget($this->unknownKeyKey($publicKey));
    }

    /**
     * Record that `$origin` (normalised `scheme://host[:port]`) was allowed to use the widget just now.
     */
    public function rememberAllowedOrigin(string $publicKey, string $origin): void
    {
        $this->cache->add($this->allowedOriginKey($publicKey, $origin), true, self::ALLOWED_ORIGIN_SECONDS);
    }

    public function wasAllowedOrigin(string $publicKey, string $origin): bool
    {
        return $this->cache->has($this->allowedOriginKey($publicKey, $origin));
    }

    private function revision(Widget $widget): string
    {
        $revision = $this->cache->get($this->revisionKeyFor($widget->ulid));

        if (! is_string($revision) || $revision === '') {
            $revision = Str::lower(Str::random(10));
            $this->cache->put($this->revisionKeyFor($widget->ulid), $revision, self::REVISION_SECONDS);
        }

        return $revision;
    }

    private function revisionKeyFor(string $ulid): string
    {
        return 'widgets:'.$ulid.':rev';
    }

    private function unknownKeyKey(string $publicKey): string
    {
        return 'widgets:unknown:'.sha1($publicKey);
    }

    private function allowedOriginKey(string $publicKey, string $origin): string
    {
        return 'widgets:origin-ok:'.sha1($publicKey.'|'.$origin);
    }
}
