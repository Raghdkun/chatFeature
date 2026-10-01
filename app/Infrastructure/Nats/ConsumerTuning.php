<?php

namespace App\Infrastructure\Nats;

use Illuminate\Contracts\Config\Repository;

/**
 * The tunables of `config/nats.php`, read once per run.
 */
final readonly class ConsumerTuning
{
    /**
     * @param  list<float>  $nakDelays
     */
    public function __construct(
        public string $prefix,
        public string $subjectFilter,
        public int $maxDeliver,
        public int $batch,
        public float $expiresSeconds,
        public int $ackWaitSeconds,
        public string $deliverPolicy,
        public array $nakDelays,
        public float $restartPollSeconds,
        public float $revalidateSeconds,
        public float $idlePollSeconds,
        public float $backoffInitialSeconds,
        public float $backoffMaxSeconds,
        public int $retentionDays,
        public float $pruneIntervalSeconds,
        public int $streamMaxAgeDays,
    ) {}

    public static function fromConfig(Repository $config): self
    {
        $delays = $config->get('nats.consumer.nak_delays', [2, 10, 30, 60]);
        $delays = is_array($delays) ? array_map(floatval(...), array_values(array_filter($delays, is_numeric(...)))) : [];

        return new self(
            prefix: self::text($config->get('nats.consumer.prefix'), 'pne-chat'),
            subjectFilter: self::text($config->get('nats.subject_filter'), 'auth.v1.>'),
            maxDeliver: max(1, (int) self::number($config->get('nats.consumer.max_deliver'), 5)),
            batch: max(1, (int) self::number($config->get('nats.consumer.batch'), 50)),
            expiresSeconds: max(0.2, self::number($config->get('nats.consumer.expires_seconds'), 5)),
            ackWaitSeconds: max(1, (int) self::number($config->get('nats.consumer.ack_wait_seconds'), 30)),
            deliverPolicy: self::text($config->get('nats.consumer.deliver_policy'), 'new'),
            nakDelays: $delays === [] ? [2.0, 10.0, 30.0, 60.0] : $delays,
            restartPollSeconds: max(0.0, self::number($config->get('nats.restart_poll_seconds'), 30)),
            revalidateSeconds: max(1.0, self::number($config->get('nats.revalidate_seconds'), 300)),
            idlePollSeconds: max(1.0, self::number($config->get('nats.idle_poll_seconds'), 30)),
            backoffInitialSeconds: max(0.1, self::number($config->get('nats.backoff.initial_seconds'), 1)),
            backoffMaxSeconds: max(0.1, self::number($config->get('nats.backoff.max_seconds'), 60)),
            retentionDays: max(1, (int) self::number($config->get('nats.retention_days'), 30)),
            pruneIntervalSeconds: max(1.0, self::number($config->get('nats.prune_interval_seconds'), 3600)),
            streamMaxAgeDays: max(1, (int) self::number($config->get('nats.stream_max_age_days'), 30)),
        );
    }

    /** Seconds to wait before the redelivery that follows failed delivery number `$deliveries` (1-based). */
    public function nakDelayFor(int $deliveries): float
    {
        $index = min(max($deliveries, 1), count($this->nakDelays)) - 1;

        return $this->nakDelays[$index];
    }

    private static function number(mixed $value, int|float $default): float
    {
        return is_numeric($value) ? (float) $value : (float) $default;
    }

    private static function text(mixed $value, string $default): string
    {
        return is_string($value) && trim($value) !== '' ? trim($value) : $default;
    }
}
