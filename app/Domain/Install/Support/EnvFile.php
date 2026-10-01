<?php

namespace App\Domain\Install\Support;

use RuntimeException;

/**
 * Minimal, dependency-free `.env` editor used by `chat:bootstrap-secrets`: reads active
 * `KEY=value` lines, appends missing keys and writes the file back atomically, keeping every
 * other line (comments, ordering, quoting) untouched.
 */
final class EnvFile
{
    public function __construct(private readonly string $path) {}

    public function path(): string
    {
        return $this->path;
    }

    public function exists(): bool
    {
        return is_file($this->path);
    }

    /** Value of an active (uncommented) key, unquoted; null when the key is absent. */
    public function get(string $key): ?string
    {
        if (! $this->exists()) {
            return null;
        }

        $contents = (string) file_get_contents($this->path);

        if (preg_match('/^'.preg_quote($key, '/').'=(.*)$/m', $contents, $matches) !== 1) {
            return null;
        }

        return $this->unquote(trim($matches[1]));
    }

    /** Whether the key exists with a non-empty value. */
    public function has(string $key): bool
    {
        $value = $this->get($key);

        return $value !== null && $value !== '' && $value !== 'null';
    }

    /**
     * Set several keys in one atomic write. Existing active lines are replaced in place,
     * new keys are appended.
     *
     * @param  array<string, string>  $values
     */
    public function set(array $values): void
    {
        $contents = $this->exists() ? (string) file_get_contents($this->path) : '';

        foreach ($values as $key => $value) {
            $line = $key.'='.$this->quoteIfNeeded($value);
            $pattern = '/^'.preg_quote($key, '/').'=.*$/m';

            if (preg_match($pattern, $contents) === 1) {
                $contents = (string) preg_replace_callback($pattern, fn (): string => $line, $contents, 1);

                continue;
            }

            $contents .= ($contents !== '' && ! str_ends_with($contents, "\n") ? "\n" : '').$line."\n";
        }

        $this->write($contents);
    }

    private function write(string $contents): void
    {
        $mode = $this->exists() ? (fileperms($this->path) & 0777) : 0600;
        $temporary = $this->path.'.tmp'.bin2hex(random_bytes(4));

        if (file_put_contents($temporary, $contents, LOCK_EX) === false) {
            throw new RuntimeException("Unable to write [{$this->path}].");
        }

        chmod($temporary, $mode);

        if (! rename($temporary, $this->path)) {
            @unlink($temporary);

            throw new RuntimeException("Unable to replace [{$this->path}].");
        }
    }

    private function unquote(string $value): string
    {
        if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'") && str_ends_with($value, $value[0])) {
            return substr($value, 1, -1);
        }

        return $value;
    }

    private function quoteIfNeeded(string $value): string
    {
        return preg_match('/[\s#"\'\\\\$]/', $value) === 1 ? '"'.addcslashes($value, '"\\$').'"' : $value;
    }
}
