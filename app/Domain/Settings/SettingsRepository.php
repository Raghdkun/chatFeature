<?php

namespace App\Domain\Settings;

use App\Domain\Install\InstallState;
use App\Models\Setting;
use Illuminate\Contracts\Cache\Repository as CacheRepository;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Contracts\Encryption\Encrypter;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * Typed settings store (`settings` table), cached per workspace.
 *
 * Before the installation lock exists NO database (or cache) access happens: every read returns
 * the definition default. Encrypted values are encrypted at rest, also inside the cache.
 *
 * @phpstan-type Row array{value: string|null, encrypted: bool}
 */
final class SettingsRepository
{
    public const CACHE_PREFIX = 'settings.rows.';

    public const CACHE_TTL = 3600;

    /** @var array<int, array<string, Row>> */
    private array $memo = [];

    public function __construct(
        private readonly SettingsRegistry $registry,
        private readonly InstallState $install,
        private readonly CacheRepository $cache,
        private readonly Encrypter $encrypter,
    ) {}

    public function registry(): SettingsRegistry
    {
        return $this->registry;
    }

    /**
     * Stored value, else the definition default, else $default.
     */
    public function get(string $key, mixed $default = null, ?int $workspaceId = null): mixed
    {
        $definition = $this->registry->find($key);
        $fallback = $definition !== null ? $definition->defaultValue() : $default;

        if (! $this->install->isInstalled()) {
            return $fallback;
        }

        $row = $this->rows($workspaceId)[$key] ?? null;

        if ($row === null || $row['value'] === null) {
            return $fallback;
        }

        try {
            $raw = $row['encrypted'] ? $this->encrypter->decryptString($row['value']) : $row['value'];
        } catch (DecryptException) {
            return $fallback;
        }

        $value = json_decode($raw, true);

        return $definition !== null ? $definition->type->cast($value) : $value;
    }

    public function bool(string $key, bool $default = false, ?int $workspaceId = null): bool
    {
        return (bool) $this->get($key, $default, $workspaceId);
    }

    public function string(string $key, string $default = '', ?int $workspaceId = null): string
    {
        $value = $this->get($key, $default, $workspaceId);

        return is_scalar($value) ? (string) $value : $default;
    }

    public function int(string $key, int $default = 0, ?int $workspaceId = null): int
    {
        $value = $this->get($key, $default, $workspaceId);

        return is_numeric($value) ? (int) $value : $default;
    }

    /**
     * Validate and persist a value (writes the DB regardless of install state; the caller must
     * be past `run-migrations`).
     *
     * @throws ValidationException
     */
    public function set(string $key, mixed $value, ?int $workspaceId = null, ?int $updatedBy = null): void
    {
        $definition = $this->registry->require($key);
        $value = $definition->type->cast($value);

        if ($definition->rules !== []) {
            // Dotted setting keys would be read as nested array paths, so validate under a neutral field name.
            $validator = Validator::make(['value' => $value], ['value' => $definition->rules], [], ['value' => $key]);

            if ($validator->fails()) {
                throw ValidationException::withMessages([$key => $validator->errors()->get('value')]);
            }
        }

        $payload = $definition->type->encode($value);
        $attributes = [
            'group' => $definition->group->value,
            'value' => $definition->encrypted ? $this->encrypter->encryptString($payload) : $payload,
            'is_encrypted' => $definition->encrypted,
            'updated_by' => $updatedBy,
        ];

        try {
            Setting::query()->updateOrCreate(['workspace_id' => $workspaceId, 'key' => $key], $attributes);
        } catch (UniqueConstraintViolationException) {
            Setting::query()->where('workspace_id', $workspaceId)->where('key', $key)->update($attributes);
        }

        $this->forget($workspaceId);
    }

    /**
     * Insert a default only if no row exists (used by `seed-defaults`; reads the DB directly).
     *
     * @return bool Whether a row was written.
     */
    public function seedMissing(string $key, mixed $value, ?int $workspaceId = null): bool
    {
        $exists = Setting::query()
            ->where('workspace_key', $workspaceId ?? 0)
            ->where('key', $key)
            ->exists();

        if ($exists) {
            return false;
        }

        $this->set($key, $value, $workspaceId);

        return true;
    }

    /**
     * Every defined, non-encrypted setting with its effective value.
     *
     * @return array<string, mixed>
     */
    public function all(?int $workspaceId = null): array
    {
        $values = [];

        foreach ($this->registry->all() as $key => $definition) {
            if (! $definition->encrypted) {
                $values[$key] = $this->get($key, null, $workspaceId);
            }
        }

        return $values;
    }

    /** Drop the cached rows of a workspace (the global scope when null). */
    public function forget(?int $workspaceId = null): void
    {
        $workspace = $workspaceId ?? 0;

        $this->cache->forget($this->cacheKey($workspace));
        unset($this->memo[$workspace]);
    }

    /**
     * Cache key of one workspace's rows. It carries the database it was read from, so two installs
     * that happen to share a cache (one Redis for several environments) never read each other's settings.
     */
    public function cacheKey(int $workspace = 0): string
    {
        $connection = config('database.default');
        $database = is_string($connection) ? config("database.connections.{$connection}.database") : null;
        $host = is_string($connection) ? config("database.connections.{$connection}.host") : null;

        return self::CACHE_PREFIX.substr(sha1((string) $connection.'|'.(is_string($host) ? $host : '').'|'.(is_string($database) ? $database : '')), 0, 12).'.'.$workspace;
    }

    /**
     * @return array<string, Row>
     */
    private function rows(?int $workspaceId): array
    {
        $workspace = $workspaceId ?? 0;

        return $this->memo[$workspace] ??= $this->cache->remember(
            $this->cacheKey($workspace),
            self::CACHE_TTL,
            fn (): array => Setting::query()
                ->where('workspace_key', $workspace)
                ->get(['key', 'value', 'is_encrypted'])
                ->mapWithKeys(fn (Setting $setting): array => [
                    (string) $setting->key => ['value' => $setting->value, 'encrypted' => (bool) $setting->is_encrypted],
                ])
                ->all(),
        );
    }
}
