<?php

namespace App\Console\Commands;

use App\Infrastructure\Nats\ConsumerRunOptions;
use App\Infrastructure\Nats\ConsumerSpec;
use App\Infrastructure\Nats\NatsConsumer;
use Illuminate\Console\Command;
use Throwable;

/**
 * Supervised worker (pizzasys auth mode): consumes `auth.v1.>` from NATS JetStream and invalidates cached
 * identities. Exits 0 straight away with `--once` and idles (exit only on SIGTERM/SIGINT) when NATS is disabled or
 * unconfigured, so a process supervisor never crash-loops it.
 */
class ChatAuthConsumeNats extends Command
{
    protected $signature = 'chat:auth:consume-nats
        {--once : Process what is queued, then exit (also exits at once when NATS is off)}
        {--max-messages= : Exit after this many deliveries}
        {--instance=default : Consumer instance, part of the durable name (pne-chat-<APP_ENV>-<instance>)}';

    protected $description = 'Consume pizzasys auth events from NATS JetStream (durable pull consumer, idempotent)';

    public function handle(NatsConsumer $consumer): int
    {
        $maxMessages = $this->option('max-messages');

        if ($maxMessages !== null && (! is_numeric($maxMessages) || (int) $maxMessages < 1)) {
            $this->components->error('--max-messages must be a positive integer.');

            return self::INVALID;
        }

        $instance = ConsumerSpec::cleanPart((string) $this->option('instance'));

        if (extension_loaded('pcntl')) {
            $this->trap([SIGTERM, SIGINT], fn () => $consumer->stop());
        }

        try {
            $stats = $consumer->run(new ConsumerRunOptions(
                once: (bool) $this->option('once'),
                maxMessages: $maxMessages === null ? null : (int) $maxMessages,
                instance: $instance !== '' ? $instance : 'default',
            ));
        } catch (Throwable $exception) {
            $this->components->error('The NATS consumer stopped: '.$exception::class);

            return self::FAILURE;
        }

        $this->components->info(collect($stats->toArray())->map(fn (int $count, string $name): string => $name.'='.$count)->implode(' '));

        return self::SUCCESS;
    }
}
