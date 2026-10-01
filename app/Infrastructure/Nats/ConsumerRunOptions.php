<?php

namespace App\Infrastructure\Nats;

/**
 * @param  bool  $once  catch up until the stream is drained, then return (also when NATS is off)
 * @param  int|null  $maxMessages  return after this many deliveries
 * @param  string  $instance  part of the durable name (`pne-chat-<APP_ENV>-<instance>`)
 */
final readonly class ConsumerRunOptions
{
    public function __construct(
        public bool $once = false,
        public ?int $maxMessages = null,
        public string $instance = 'default',
    ) {}
}
