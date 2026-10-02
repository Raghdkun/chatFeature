<?php

namespace App\Support\ApiDocs;

use Illuminate\Routing\Route;
use Spatie\LaravelData\Data;

/**
 * The hand-written part of one endpoint's reference entry: where it is filed, what it is called, what it does, which successes it
 * answers with (a Data class, so the example and the schema come from the code) and which of the catalogue's error codes it can
 * raise beyond the ones its middleware imply (authentication, access level, rate limits, validation and 404 are derived from the
 * route, see {@see CatalogueResponses}).
 *
 * Entries are keyed by route name; {@see Catalogue} collects them and the rot guard demands one per route.
 *
 * @phpstan-type Field array{description: string, example?: mixed}
 */
final class Doc
{
    public string $group = '';

    public ?string $subgroup = null;

    public string $title = '';

    public string $about = '';

    /** @var list<Success> */
    public array $successes = [];

    /** @var array<string, string|null> error code => what makes THIS endpoint answer it (`null`: the catalogue's general meaning) */
    public array $errors = [];

    /** @var list<string> */
    public array $hidden = [];

    /** @var array<string, Field> */
    public array $body = [];

    /** @var array<string, array{value: string, description: string}> */
    public array $headers = [];

    private function __construct(public readonly string $route) {}

    public static function route(string $name): self
    {
        return new self($name);
    }

    public function in(string $group, ?string $subgroup = null): self
    {
        $this->group = $group;
        $this->subgroup = $subgroup;

        return $this;
    }

    public function title(string $title): self
    {
        $this->title = $title;

        return $this;
    }

    /** Markdown. Access level and rate limits are added from the route, do not repeat them. */
    public function about(string $markdown): self
    {
        $this->about = $markdown;

        return $this;
    }

    /**
     * `{ "data": <Data class> }`.
     *
     * @param  class-string<Data>  $class
     * @param  bool  $staff  Whether `Optional` (staff-only) properties appear in the example.
     * @param  bool  $nullable  Whether `data` may be `null` (no resource to show).
     */
    public function item(string $class, int $status = 200, string $note = '', bool $staff = true, bool $nullable = false): self
    {
        $this->successes[] = new Success($status, 'item', $class, null, $note, $staff, nullable: $nullable);

        return $this;
    }

    /**
     * `201` with the created resource.
     *
     * @param  class-string<Data>  $class
     */
    public function created(string $class, string $note = '', bool $staff = true): self
    {
        return $this->item($class, 201, $note, $staff);
    }

    /**
     * `{ "data": [<Data class>...], "meta": { "next_cursor": null } }`: a complete, unpaginated list.
     *
     * @param  class-string<Data>  $class
     */
    public function list(string $class, string $note = ''): self
    {
        $this->successes[] = new Success(200, 'list', $class, null, $note, true);

        return $this;
    }

    /**
     * `{ "data": [<Data class>...], "meta": { "next_cursor": "..." | null, ...extra } }`: a cursor-paged list.
     *
     * @param  class-string<Data>  $class
     * @param  array<string, mixed>  $meta  Further `meta` keys with their example values (`unread_chats`).
     */
    public function paged(string $class, string $note = '', bool $staff = true, array $meta = []): self
    {
        $this->successes[] = new Success(200, 'paged', $class, $meta, $note, $staff);

        return $this;
    }

    /**
     * A payload the controller builds by hand (no Data class): `{ "data": <example> }` or, with `$envelope = false`, the example as it is.
     * The contract tests compare the real answer with this shape.
     *
     * @param  array<string, mixed>  $example
     * @param  array<string, array{description: string, type?: string}>  $fields  Descriptions by path below `data`.
     */
    public function data(array $example, int $status = 200, string $note = '', array $fields = [], bool $envelope = true): self
    {
        $this->successes[] = new Success($status, $envelope ? 'data' : 'plain', null, $example, $note, true, [], $fields);

        return $this;
    }

    public function noContent(int $status = 204, string $note = ''): self
    {
        $this->successes[] = new Success($status, 'none', null, null, $note, true);

        return $this;
    }

    /**
     * A non-JSON (or fixed text) answer.
     *
     * @param  array<string, string>  $headers
     */
    public function raw(int $status, string $contentType, string $body, string $note = '', array $headers = []): self
    {
        $this->successes[] = new Success($status, 'raw', null, $body, $note, true, $headers + ['Content-Type' => $contentType]);

        return $this;
    }

    /**
     * Error codes this endpoint can answer with besides the ones derived from its middleware.
     *
     * @param  array<int|string, string|null>  $codes  `['code']` or `['code' => 'when it happens here']`
     */
    public function errors(array $codes): self
    {
        foreach ($codes as $code => $when) {
            if (is_int($code)) {
                $this->errors[(string) $when] = null;
            } else {
                $this->errors[$code] = $when;
            }
        }

        return $this;
    }

    /** Parameters of a shared Form Request that do not apply here (`format` on the list, `cursor` on the export). */
    public function without(string ...$parameters): self
    {
        $this->hidden = array_values([...$this->hidden, ...$parameters]);

        return $this;
    }

    /**
     * A body parameter the endpoint reads without a Form Request (an inline `validate()`).
     *
     * @param  Field  $field
     */
    public function param(string $name, array $field): self
    {
        $this->body[$name] = $field;

        return $this;
    }

    public function header(string $name, string $value, string $description): self
    {
        $this->headers[$name] = ['value' => $value, 'description' => $description];

        return $this;
    }

    /**
     * The description Scribe prints: the entry's own text, then what the route's middleware says about access and rate limits.
     */
    public function describe(Route $route): string
    {
        $parts = [trim($this->about)];

        $access = $this->access($route);

        if ($access !== '') {
            $parts[] = '**Access.** '.$access;
        }

        $limiters = ApiRoutes::limiters($route);

        if ($limiters !== []) {
            $parts[] = "**Rate limits.** `429 rate_limited` with `Retry-After` when exceeded.\n\n".RateLimitDocs::markdown($limiters);
        }

        return implode("\n\n", array_filter($parts, static fn (string $part): bool => $part !== ''));
    }

    private function access(Route $route): string
    {
        $uri = $route->uri();

        if (str_starts_with($uri, 'webhooks/')) {
            return 'Called by the OpenWA gateway, never by a client. The only credential is the HMAC-SHA256 signature of the raw body (`X-OpenWA-Signature`); nothing is stored before it verifies.';
        }

        if (str_starts_with((string) $route->getName(), 'api.auth.token.')) {
            return 'No credential: this call creates one. It sets no cookie and no CORS headers (native clients only), every answer is `Cache-Control: no-store`, and a body over 8 KiB is `413`. Refusals never say which part of the credentials was wrong.';
        }

        if (ApiRoutes::isVisitorRoute($route)) {
            return 'Visitor bearer token (`Authorization: Bearer vt_...`) from the session call. Only the token\'s own session and conversations are reachable; anything else is `404`.';
        }

        if (ApiRoutes::hasMiddleware($route, 'signed')) {
            return 'No bearer token: the URL\'s signature is the credential (it names exactly one attachment and expires).';
        }

        if (ApiRoutes::hasMiddleware($route, 'wa.admin')) {
            return 'Administrators only (agents get `403`; nothing says that WhatsApp exists).';
        }

        if (ApiRoutes::hasMiddleware($route, 'admin')) {
            return 'Administrators only.';
        }

        if (ApiRoutes::hasMiddleware($route, 'auth')) {
            return 'Any signed-in staff member (administrator or agent).';
        }

        if (str_starts_with($uri, 'api/v1/public/widgets/')) {
            return 'No credential. The browser `Origin` must be on the widget\'s domain list; a request without `Origin` is only accepted when the widget allows non-browser clients.';
        }

        return '';
    }
}
