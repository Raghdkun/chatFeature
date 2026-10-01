<?php

namespace App\Infrastructure\Nats;

use App\Domain\Install\InstallState;
use App\Infrastructure\Nats\Contracts\Clock;
use App\Infrastructure\Nats\Contracts\JetStreamGateway;
use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use App\Models\ProcessedEvent;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Keeps local identity state fresh from the pizzasys event stream: a durable pull consumer on `auth.v1.>` whose
 * events are de-duplicated by envelope id, routed to handlers and acked only after their effects committed.
 *
 * NATS is only a fast-invalidation hint: the app works (revocation lag <= verify TTL) when this process is down.
 * The loop never throws for an unusable NATS: while NATS is off/unconfigured it logs one line per state change and
 * re-reads its settings every `nats.idle_poll_seconds`; connection errors reconnect with exponential backoff.
 *
 * Logging rule: only the event id, type and outcome (or an exception class) are ever logged, never a payload.
 */
final class NatsConsumer
{
    private bool $stopRequested = false;

    private ?string $state = null;

    public function __construct(
        private readonly NatsSettingsProvider $settingsProvider,
        private readonly JetStreamGateway $gateway,
        private readonly EventProcessor $processor,
        private readonly NatsStatusStore $status,
        private readonly DeadLetterWriter $deadLetters,
        private readonly Clock $clock,
        private readonly Repository $config,
        private readonly InstallState $install,
    ) {}

    /** Ask the loop to finish the current batch and return (SIGTERM/SIGINT handler). */
    public function stop(): void
    {
        $this->stopRequested = true;
    }

    /**
     * @throws Throwable in `once` mode when NATS is configured but cannot be used (supervised mode never throws)
     */
    public function run(ConsumerRunOptions $options): ConsumerStats
    {
        $tuning = ConsumerTuning::fromConfig($this->config);
        $stats = new ConsumerStats;
        $backoff = new Backoff($tuning->backoffInitialSeconds, $tuning->backoffMaxSeconds);

        while (! $this->stopRequested) {
            $this->status->heartbeat($this->clock->now());

            try {
                $restartToken = $this->status->restartToken();
                $settings = $this->usableSettings();

                if (! $settings instanceof NatsSettings) {
                    $this->status->setConnected(false);
                    $this->transition($settings);

                    if ($options->once) {
                        break;
                    }

                    $this->nap($tuning->idlePollSeconds);

                    continue;
                }

                if ($this->session($settings, $restartToken, $options, $tuning, $stats, $backoff) === SessionEnd::Finished) {
                    break;
                }
            } catch (Throwable $exception) {
                $this->status->setConnected(false);
                $stats->reconnects++;
                $delay = $backoff->next();

                Log::warning('nats.consumer.error', [
                    'error' => $exception::class,
                    'detail' => $exception instanceof GatewayException ? $exception->getMessage() : null,
                    'retry_in_seconds' => $delay,
                ]);
                $this->transition('reconnecting');

                if ($options->once) {
                    throw $exception;
                }

                $this->nap($delay);
            }
        }

        $this->status->setConnected(false);
        $this->transition('stopped');

        return $stats;
    }

    /**
     * @return NatsSettings|string the settings to connect with, or the reason NATS cannot be used right now
     */
    private function usableSettings(): NatsSettings|string
    {
        if (! $this->install->isInstalled()) {
            return 'not_installed';
        }

        $settings = $this->settingsProvider->current();

        if (! $settings instanceof NatsSettings || $settings->url === null || trim($settings->url) === '') {
            return 'unconfigured';
        }

        return $settings->enabled ? $settings : 'disabled';
    }

    private function session(
        NatsSettings $settings,
        int $restartToken,
        ConsumerRunOptions $options,
        ConsumerTuning $tuning,
        ConsumerStats $stats,
        Backoff $backoff,
    ): SessionEnd {
        $spec = new ConsumerSpec(
            stream: $settings->stream,
            durable: ConsumerSpec::durableName($tuning->prefix, $this->appEnvironment(), $options->instance),
            filter: $tuning->subjectFilter,
            maxDeliver: $tuning->maxDeliver,
            ackWaitSeconds: $tuning->ackWaitSeconds,
            deliverPolicy: $tuning->deliverPolicy,
        );

        $this->gateway->connect($settings);

        try {
            $this->prepare($settings, $spec, $tuning);
            $backoff->reset();
            $this->status->setConnected(true);
            $this->transition('connected', ['stream' => $spec->stream, 'consumer' => $spec->durable, 'environment' => $settings->environmentKey]);

            $now = $this->seconds();
            $nextRestartPoll = $now + $tuning->restartPollSeconds;
            $nextRevalidate = $now + $tuning->revalidateSeconds;
            $nextPrune = $now + $tuning->pruneIntervalSeconds;
            $expires = $options->once ? min($tuning->expiresSeconds, 1.0) : $tuning->expiresSeconds;

            $this->pruneLedger($tuning);

            while (! $this->stopRequested) {
                $limit = $tuning->batch;

                if ($options->maxMessages !== null) {
                    $remaining = $options->maxMessages - $stats->received;

                    if ($remaining <= 0) {
                        return SessionEnd::Finished;
                    }

                    $limit = min($limit, $remaining);
                }

                $messages = $this->gateway->fetch($limit, $expires);
                $this->status->heartbeat($this->clock->now());

                foreach ($messages as $message) {
                    $this->handle($message, $spec, $tuning, $stats);
                }

                if ($options->maxMessages !== null && $stats->received >= $options->maxMessages) {
                    return SessionEnd::Finished;
                }

                if ($options->once && $messages === []) {
                    return SessionEnd::Finished;
                }

                $now = $this->seconds();

                if ($now >= $nextRestartPoll) {
                    $nextRestartPoll = $now + $tuning->restartPollSeconds;

                    if ($this->status->restartToken() !== $restartToken) {
                        $this->transition('restarting');

                        return SessionEnd::Restart;
                    }
                }

                if ($now >= $nextRevalidate) {
                    $nextRevalidate = $now + $tuning->revalidateSeconds;
                    $this->prepare($settings, $spec, $tuning);
                }

                if ($now >= $nextPrune) {
                    $nextPrune = $now + $tuning->pruneIntervalSeconds;
                    $this->pruneLedger($tuning);
                }
            }

            return SessionEnd::Finished;
        } finally {
            $this->status->setConnected(false);
            $this->disconnectQuietly();
        }
    }

    private function prepare(NatsSettings $settings, ConsumerSpec $spec, ConsumerTuning $tuning): void
    {
        if ($settings->ensureStream) {
            $this->gateway->ensureStream($spec->stream, $spec->filter, $tuning->streamMaxAgeDays * 86_400);
        }

        $this->gateway->ensureConsumer($spec);
    }

    private function handle(JetStreamMessage $message, ConsumerSpec $spec, ConsumerTuning $tuning, ConsumerStats $stats): void
    {
        $stats->received++;

        try {
            $event = CloudEvent::fromJson($message->body);
        } catch (InvalidCloudEvent $invalid) {
            $stats->malformed++;
            $this->deadLetters->write($invalid->reason, null, null, $message->subject, $message->streamSequence, $message->deliveries);
            Log::warning('nats.event.malformed', ['reason' => $invalid->reason, 'stream_sequence' => $message->streamSequence]);
            $this->gateway->term($message);

            return;
        }

        try {
            $outcome = $this->processor->process($event);
        } catch (Throwable $exception) {
            $this->fail($message, $event, $exception, $spec, $tuning, $stats);

            return;
        }

        $this->gateway->ack($message);
        $this->status->eventReceived($this->clock->now());

        match ($outcome) {
            EventOutcome::Duplicate => $stats->duplicates++,
            EventOutcome::Unknown => $stats->unknown++,
            EventOutcome::Noop => $stats->noops++,
            default => $stats->handled++,
        };

        Log::info('nats.event', $event->logContext() + ['outcome' => $outcome->value]);
    }

    private function fail(
        JetStreamMessage $message,
        CloudEvent $event,
        Throwable $exception,
        ConsumerSpec $spec,
        ConsumerTuning $tuning,
        ConsumerStats $stats,
    ): void {
        $stats->failed++;
        $giveUp = $message->deliveries >= $spec->maxDeliver;

        Log::warning('nats.event.failed', $event->logContext() + [
            'error' => $exception::class,
            'delivery' => $message->deliveries,
            'dead_lettered' => $giveUp,
        ]);

        if (! $giveUp) {
            $this->gateway->nak($message, $tuning->nakDelayFor($message->deliveries));

            return;
        }

        $stats->deadLettered++;
        $this->deadLetters->write(
            'handler_failed',
            $event->id(),
            $event->type(),
            $message->subject,
            $message->streamSequence,
            $message->deliveries,
            $exception::class,
        );
        $this->gateway->term($message);
    }

    private function pruneLedger(ConsumerTuning $tuning): void
    {
        try {
            $removed = ProcessedEvent::pruneOlderThan($tuning->retentionDays);

            if ($removed > 0) {
                Log::info('nats.ledger.pruned', ['rows' => $removed]);
            }
        } catch (Throwable $exception) {
            Log::warning('nats.ledger.prune_failed', ['error' => $exception::class]);
        }
    }

    /**
     * Log one line per state change (not per loop iteration).
     *
     * @param  array<string, mixed>  $context
     */
    private function transition(string $state, array $context = []): void
    {
        if ($this->state === $state) {
            return;
        }

        $this->state = $state;
        Log::info('nats.consumer.state', ['state' => $state] + $context);
    }

    /** Sleep in slices of at most one second so a stop request is honoured promptly. */
    private function nap(float $seconds): void
    {
        $remaining = $seconds;

        while ($remaining > 0 && ! $this->stopRequested) {
            $slice = min(1.0, $remaining);
            $this->clock->sleep($slice);
            $remaining -= $slice;
        }
    }

    private function disconnectQuietly(): void
    {
        try {
            $this->gateway->disconnect();
        } catch (Throwable) {
            // The connection is being torn down anyway.
        }
    }

    private function seconds(): float
    {
        return (float) $this->clock->now()->format('U.u');
    }

    private function appEnvironment(): string
    {
        $environment = $this->config->get('app.env');

        return is_string($environment) && $environment !== '' ? $environment : 'production';
    }
}
