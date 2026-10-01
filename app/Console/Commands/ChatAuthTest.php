<?php

namespace App\Console\Commands;

use App\Auth\Pizzasys\Actions\TestPortalConnection;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Data\Auth\PortalCheckStatus;
use App\Domain\Install\InstallState;
use App\Models\AuthEnvironment;
use Illuminate\Console\Command;

/** Ops: test a configured auth-portal environment (reachable, service credential, latency, NATS). Prints no secrets. */
class ChatAuthTest extends Command
{
    protected $signature = 'chat:auth:test
        {env? : production or testing (default: the active environment)}';

    protected $description = 'Test the connection to an auth-portal environment';

    public function handle(InstallState $install, AuthEnvironmentRepository $environments, TestPortalConnection $test): int
    {
        if (! $install->isInstalled()) {
            $this->components->error('The application is not installed yet.');

            return self::FAILURE;
        }

        $key = (string) ($this->argument('env') ?? $environments->activeKey());

        if (! in_array($key, AuthEnvironment::KEYS, true)) {
            $this->components->error('Use "production" or "testing".');

            return self::FAILURE;
        }

        $environment = $environments->find($key);
        $endpoint = $environment?->endpoint();

        if ($environment === null || $endpoint === null) {
            $this->components->error("The {$key} environment is not configured (or its service token cannot be decrypted).");

            return self::FAILURE;
        }

        $result = $test($endpoint, $environment->nats_url, $environment->nats_token);

        foreach ($result->checks as $check) {
            $message = is_string($check->message) ? ' - '.$check->message : '';
            $this->components->twoColumnDetail($check->label, ($check->ok ? '<info>ok</info>' : '<error>failed</error>').$message);
        }

        $environment->forceFill([
            'last_check_at' => now(),
            'last_check_status' => $result->ok ? PortalCheckStatus::Ok->value : PortalCheckStatus::Failed->value,
            'last_check_message' => $result->ok ? null : $result->failureSummary(),
        ])->save();

        return $result->ok ? self::SUCCESS : self::FAILURE;
    }
}
