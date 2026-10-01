<?php

namespace App\Domain\Install;

use Closure;
use Illuminate\Support\Arr;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * File-backed installation state. There is no database before `migrate` runs, so everything the
 * wizard needs lives in `<directory>/install-state.json`; `<directory>/installed.lock` is the
 * authoritative "installed" marker and `<directory>/install.running` carries the run flock.
 *
 * Every method here is database-free by design (see docs/contracts/setup-wizard.md).
 *
 * @phpstan-type RunStatus array{status: 'pending'|'running'|'done'|'failed', message: string|null}
 * @phpstan-type State array{
 *     mode: string|null,
 *     admin: array{name: string, email: string, password_hash: string|null}|null,
 *     basics: array{app_name: string, app_url: string, locale: string, timezone: string, idle_timeout_minutes: int}|null,
 *     auth_environments: array<string, mixed>,
 *     run: array<string, RunStatus>,
 *     created_at: string|null,
 * }
 */
final class InstallState
{
    public const STATE_FILE = 'install-state.json';

    public const LOCK_FILE = 'installed.lock';

    public const RUNNING_FILE = 'install.running';

    /** Test hook: null = decide from the lock file, bool = pretend. */
    private ?bool $forcedInstalled;

    private bool $lockSeen = false;

    public function __construct(private string $directory, ?bool $forcedInstalled = null)
    {
        $this->forcedInstalled = $forcedInstalled;
    }

    /**
     * Point the container's InstallState at a throwaway directory (tests).
     *
     * @param  array<string, mixed>  $state  Initial install-state.json content.
     */
    public static function fake(bool $installed = false, array $state = []): self
    {
        /** @var self $instance */
        $instance = app(self::class);

        $directory = rtrim(sys_get_temp_dir(), '/').'/chat-install-'.Str::lower(Str::random(12));
        mkdir($directory, 0775, true);
        register_shutdown_function(static function () use ($directory): void {
            foreach (glob($directory.'/*') ?: [] as $file) {
                @unlink($file);
            }
            @rmdir($directory);
        });

        $instance->directory = $directory;
        $instance->forcedInstalled = null;
        $instance->lockSeen = false;

        if ($state !== []) {
            $instance->mutate(fn (array $current): array => array_replace($current, $state));
        }

        if ($installed) {
            $instance->writeLock(['mode' => 'fortify']);
        }

        return $instance;
    }

    public function directory(): string
    {
        return $this->directory;
    }

    public function statePath(): string
    {
        return $this->directory.'/'.self::STATE_FILE;
    }

    public function lockPath(): string
    {
        return $this->directory.'/'.self::LOCK_FILE;
    }

    public function runningPath(): string
    {
        return $this->directory.'/'.self::RUNNING_FILE;
    }

    /**
     * Whether the installation has been completed. Cheap: one `is_file` unless already seen.
     */
    public function isInstalled(): bool
    {
        if ($this->forcedInstalled !== null) {
            return $this->forcedInstalled;
        }

        if ($this->lockSeen) {
            return true;
        }

        if (config('install.installed') === true || is_file($this->lockPath())) {
            return $this->lockSeen = true;
        }

        return false;
    }

    /**
     * @param  array<string, mixed>  $meta
     */
    public function writeLock(array $meta = []): void
    {
        $this->ensureDirectory();

        $payload = json_encode([
            'installed_at' => now()->toIso8601String(),
            'mode' => $this->mode(),
            ...$meta,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

        $this->writeAtomically($this->lockPath(), (string) $payload, 0644);
        $this->lockSeen = true;
    }

    /**
     * Delete state, lock and run-lock files (`chat:install:reset`).
     */
    public function reset(): void
    {
        foreach ([$this->statePath(), $this->lockPath(), $this->runningPath()] as $file) {
            if (is_file($file)) {
                @unlink($file);
            }
        }

        $this->lockSeen = false;
        $this->forcedInstalled = null;
    }

    public function mode(): ?string
    {
        return $this->read()['mode'];
    }

    /**
     * @return State
     */
    public function read(): array
    {
        return $this->normalise($this->readRaw());
    }

    /**
     * Read-modify-write under an exclusive lock on the state file.
     *
     * @param  Closure(State): array<string, mixed>  $mutator
     * @return State
     */
    public function mutate(Closure $mutator): array
    {
        $this->ensureDirectory();

        $handle = fopen($this->statePath(), 'c+');
        if ($handle === false) {
            throw new RuntimeException('Unable to open the install state file for writing.');
        }

        try {
            // Private before anything (a password hash) is written into it.
            @chmod($this->statePath(), 0600);
            flock($handle, LOCK_EX);

            $contents = stream_get_contents($handle);
            $current = $this->normalise($this->decode($contents === false ? '' : $contents));
            $next = $this->normalise($mutator($current));
            $next['created_at'] ??= now()->toIso8601String();

            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, (string) json_encode($next, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            fflush($handle);

            return $next;
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /**
     * Record the outcome of one install step.
     *
     * @param  'pending'|'running'|'done'|'failed'  $status
     */
    public function markRun(string $key, string $status, ?string $message = null): void
    {
        $this->mutate(function (array $state) use ($key, $status, $message): array {
            $state['run'][$key] = ['status' => $status, 'message' => $message];

            return $state;
        });
    }

    public function runStatus(string $key): string
    {
        return $this->read()['run'][$key]['status'] ?? 'pending';
    }

    /**
     * @return array<string, mixed>
     */
    private function readRaw(): array
    {
        $path = $this->statePath();

        if (! is_file($path)) {
            return [];
        }

        $contents = @file_get_contents($path);

        return $this->decode($contents === false ? '' : $contents);
    }

    /**
     * @return array<string, mixed>
     */
    private function decode(string $contents): array
    {
        if (trim($contents) === '') {
            return [];
        }

        $decoded = json_decode($contents, true);

        if (! is_array($decoded)) {
            return [];
        }

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    /**
     * @param  array<string, mixed>  $raw
     * @return State
     */
    private function normalise(array $raw): array
    {
        $admin = Arr::get($raw, 'admin');
        $basics = Arr::get($raw, 'basics');
        $run = Arr::get($raw, 'run');
        $environments = Arr::get($raw, 'auth_environments');
        $mode = Arr::get($raw, 'mode');
        $createdAt = Arr::get($raw, 'created_at');

        $normalisedRun = [];
        foreach (is_array($run) ? $run : [] as $key => $entry) {
            if (! is_array($entry)) {
                continue;
            }

            $status = $entry['status'] ?? 'pending';
            $normalisedRun[(string) $key] = [
                'status' => in_array($status, ['pending', 'running', 'done', 'failed'], true) ? $status : 'pending',
                'message' => isset($entry['message']) && is_string($entry['message']) ? $entry['message'] : null,
            ];
        }

        return [
            'mode' => is_string($mode) ? $mode : null,
            'admin' => is_array($admin) && isset($admin['name'], $admin['email'])
                ? [
                    'name' => (string) $admin['name'],
                    'email' => (string) $admin['email'],
                    'password_hash' => isset($admin['password_hash']) && is_string($admin['password_hash']) ? $admin['password_hash'] : null,
                ]
                : null,
            'basics' => is_array($basics) && isset($basics['app_name'], $basics['app_url'], $basics['locale'], $basics['timezone'], $basics['idle_timeout_minutes'])
                ? [
                    'app_name' => (string) $basics['app_name'],
                    'app_url' => (string) $basics['app_url'],
                    'locale' => (string) $basics['locale'],
                    'timezone' => (string) $basics['timezone'],
                    'idle_timeout_minutes' => (int) $basics['idle_timeout_minutes'],
                ]
                : null,
            'auth_environments' => is_array($environments) ? $environments : [],
            'run' => $normalisedRun,
            'created_at' => is_string($createdAt) ? $createdAt : null,
        ];
    }

    private function ensureDirectory(): void
    {
        if (! is_dir($this->directory) && ! @mkdir($this->directory, 0775, true) && ! is_dir($this->directory)) {
            throw new RuntimeException("Unable to create the install state directory [{$this->directory}].");
        }
    }

    private function writeAtomically(string $path, string $contents, int $mode): void
    {
        $temporary = $path.'.'.Str::lower(Str::random(8)).'.tmp';

        if (file_put_contents($temporary, $contents, LOCK_EX) === false) {
            throw new RuntimeException("Unable to write [{$path}].");
        }

        @chmod($temporary, $mode);

        if (! rename($temporary, $path)) {
            @unlink($temporary);

            throw new RuntimeException("Unable to move [{$temporary}] into place.");
        }
    }
}
