<?php

namespace Tests\Support;

use App\Domain\Chat\Realtime\Sockets\SocketTerminator;
use RuntimeException;
use Throwable;

/**
 * Remembers which socket tags the application asked Reverb to close, in order (nothing is sent anywhere). `failWith()` makes every call
 * throw, like a Reverb that cannot be reached.
 */
final class RecordingSocketTerminator implements SocketTerminator
{
    /** @var list<string> */
    public array $terminated = [];

    /** @var (callable(string): void)|null called with the tag just before it is recorded (ordering assertions) */
    public $onTerminate;

    private ?Throwable $failure = null;

    public function terminate(string $tag): void
    {
        if ($this->failure !== null) {
            throw $this->failure;
        }

        if ($this->onTerminate !== null) {
            ($this->onTerminate)($tag);
        }

        $this->terminated[] = $tag;
    }

    public function failWith(?Throwable $failure = null): void
    {
        $this->failure = $failure ?? new RuntimeException('Reverb cannot be reached');
    }

    public function recover(): void
    {
        $this->failure = null;
    }

    public function reset(): void
    {
        $this->terminated = [];
    }

    public function count(string $tag): int
    {
        return count(array_filter($this->terminated, fn (string $terminated): bool => $terminated === $tag));
    }

    public function was(string $tag): bool
    {
        return in_array($tag, $this->terminated, true);
    }
}
