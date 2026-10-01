<?php

namespace Tests\Support\Nats;

use RuntimeException;

/**
 * Starts tests/Support/Nats/stub-nats-server.php (a single-connection NATS protocol model, optionally behind TLS) in a
 * child process and reads back what it saw. Call `stopStub()` from tearDown.
 */
trait RunsNatsStub
{
    /** @var resource|null */
    private $stubProcess = null;

    private string $stubLog = '';

    private string $stubScenario = '';

    private int $stubPort = 0;

    /**
     * @param  array<string, mixed>  $scenario
     */
    private function startStub(array $scenario): void
    {
        $directory = storage_path('framework/testing');
        @mkdir($directory, 0775, true);
        $this->stubLog = $directory.'/nats-stub-'.bin2hex(random_bytes(4)).'.log';
        $this->stubScenario = $this->stubLog.'.json';
        file_put_contents($this->stubScenario, json_encode($scenario + ['token' => null, 'idle_exit' => 20]));
        touch($this->stubLog);

        $process = proc_open(
            [PHP_BINARY, __DIR__.'/stub-nats-server.php', $this->stubScenario, $this->stubLog],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );

        if (! is_resource($process)) {
            throw new RuntimeException('Could not start the NATS stub server.');
        }

        $this->stubProcess = $process;
        stream_set_timeout($pipes[1], 10);

        if (! preg_match('/^PORT (\d+)/', (string) fgets($pipes[1]), $matches)) {
            throw new RuntimeException('The NATS stub server did not start: '.stream_get_contents($pipes[2]));
        }

        $this->stubPort = (int) $matches[1];
    }

    private function stopStub(): void
    {
        if (is_resource($this->stubProcess)) {
            proc_terminate($this->stubProcess);
            proc_close($this->stubProcess);
        }

        @unlink($this->stubLog);
        @unlink($this->stubScenario);
    }

    /**
     * Everything the stub saw, waiting briefly for in-flight frames.
     *
     * @return list<string>
     */
    private function stubLines(): array
    {
        usleep(300_000);

        return array_values(array_filter(explode("\n", (string) file_get_contents($this->stubLog))));
    }

    private function stubSawConnect(): bool
    {
        foreach ($this->stubLines() as $line) {
            if (str_starts_with($line, 'CONNECT')) {
                return true;
            }
        }

        return false;
    }
}
