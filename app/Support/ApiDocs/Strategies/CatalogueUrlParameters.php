<?php

namespace App\Support\ApiDocs\Strategies;

use App\Support\ApiDocs\ExampleValues;
use Knuckles\Camel\Extraction\ExtractedEndpointData;
use Knuckles\Scribe\Extracting\Strategies\Strategy;
use RuntimeException;

/**
 * The `{parameters}` of the URL, described by name. An unknown name fails the generation: a new URL parameter has to be described
 * here before the reference can be built.
 */
class CatalogueUrlParameters extends Strategy
{
    /**
     * @return array<string, array{description: string, example: string|int, type: string}>
     */
    public static function known(): array
    {
        $ulid = static fn (string $what): string => "The ulid of the {$what}.";

        return [
            'key' => ['description' => 'The widget\'s public key (`wk_` + 20 lower-case letters and digits).', 'example' => 'wk_k3j9x2m5n8p4q7r1s6t0', 'type' => 'string'],
            'ulid' => ['description' => $ulid('conversation').' It must belong to the visitor token\'s session; another visitor\'s conversation is `404`.', 'example' => ExampleValues::CONVERSATION, 'type' => 'string'],
            'attachment' => ['description' => $ulid('attachment'), 'example' => ExampleValues::ulid('attachment'), 'type' => 'string'],
            'conversation' => ['description' => $ulid('conversation'), 'example' => ExampleValues::CONVERSATION, 'type' => 'string'],
            'category' => ['description' => $ulid('category'), 'example' => ExampleValues::ulid('category'), 'type' => 'string'],
            'agent' => ['description' => 'The staff user id (this API is staff-only, so the integer id is used).', 'example' => 7, 'type' => 'integer'],
            'widget' => ['description' => $ulid('widget'), 'example' => ExampleValues::ulid('widget'), 'type' => 'string'],
            'subscription' => ['description' => 'The ulid of one of the caller\'s own push subscriptions (anyone else\'s is `404`).', 'example' => ExampleValues::ulid('push-subscription'), 'type' => 'string'],
            'device' => ['description' => 'The ulid of one of the caller\'s own device registrations (anyone else\'s is `404`).', 'example' => ExampleValues::ulid('device'), 'type' => 'string'],
            'token' => ['description' => 'The id of one of the caller\'s own tokens (anyone else\'s is `404`).', 'example' => 12, 'type' => 'integer'],
            'session' => ['description' => $ulid('WhatsApp session'), 'example' => ExampleValues::ulid('wa-session'), 'type' => 'string'],
            'chat' => ['description' => $ulid('WhatsApp chat'), 'example' => ExampleValues::ulid('wa-chat'), 'type' => 'string'],
            'message' => ['description' => $ulid('WhatsApp message'), 'example' => ExampleValues::ulid('wa-message'), 'type' => 'string'],
        ];
    }

    /**
     * @param  array<string, mixed>  $settings
     * @return array<string, array<string, mixed>>
     */
    public function __invoke(ExtractedEndpointData $endpointData, array $settings = []): array
    {
        $known = self::known();
        $parameters = [];

        preg_match_all('/\{(\w+)\??\}/', $endpointData->uri, $matches);

        foreach ($matches[1] as $name) {
            $spec = $known[$name] ?? throw new RuntimeException("URL parameter [{$name}] of [{$endpointData->uri}] is not described: add it to CatalogueUrlParameters::known().");

            $parameters[$name] = ['name' => $name, 'description' => $spec['description'], 'required' => true, 'example' => $spec['example'], 'type' => $spec['type']];
        }

        return $parameters;
    }
}
