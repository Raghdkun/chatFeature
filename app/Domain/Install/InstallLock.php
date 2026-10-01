<?php

namespace App\Domain\Install;

use App\Domain\Install\Exceptions\InstallBusyException;
use Closure;
use RuntimeException;

/**
 * flock() on `install.running`: only one wizard/CLI run may execute steps at a time.
 * The lock is released automatically if the process dies.
 */
final class InstallLock
{
    /** @var resource|null */
    private $handle = null;

    public function __construct(private readonly InstallState $state) {}

    public function acquire(): bool
    {
        if ($this->handle !== null) {
            return true;
        }

        $handle = $this->open();

        if (! flock($handle, LOCK_EX | LOCK_NB)) {
            fclose($handle);

            return false;
        }

        $this->handle = $handle;

        return true;
    }

    public function release(): void
    {
        if ($this->handle === null) {
            return;
        }

        flock($this->handle, LOCK_UN);
        fclose($this->handle);
        $this->handle = null;
    }

    /** Whether some other holder (or this instance) currently owns the lock. */
    public function isHeld(): bool
    {
        if ($this->handle !== null) {
            return true;
        }

        $probe = $this->open();
        $free = flock($probe, LOCK_EX | LOCK_NB);

        if ($free) {
            flock($probe, LOCK_UN);
        }

        fclose($probe);

        return ! $free;
    }

    /**
     * @template T
     *
     * @param  Closure(): T  $callback
     * @return T
     *
     * @throws InstallBusyException
     */
    public function run(Closure $callback): mixed
    {
        if (! $this->acquire()) {
            throw new InstallBusyException;
        }

        try {
            return $callback();
        } finally {
            $this->release();
        }
    }

    /**
     * @return resource
     */
    private function open()
    {
        $directory = $this->state->directory();

        if (! is_dir($directory) && ! @mkdir($directory, 0775, true) && ! is_dir($directory)) {
            throw new RuntimeException("Unable to create the install state directory [{$directory}].");
        }

        $handle = fopen($this->state->runningPath(), 'c');

        if ($handle === false) {
            throw new RuntimeException('Unable to open the install lock file.');
        }

        return $handle;
    }
}
