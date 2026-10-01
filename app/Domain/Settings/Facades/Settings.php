<?php

namespace App\Domain\Settings\Facades;

use App\Domain\Settings\SettingsRepository;
use Illuminate\Support\Facades\Facade;

/**
 * @method static mixed get(string $key, mixed $default = null, ?int $workspaceId = null)
 * @method static bool bool(string $key, bool $default = false, ?int $workspaceId = null)
 * @method static string string(string $key, string $default = '', ?int $workspaceId = null)
 * @method static int int(string $key, int $default = 0, ?int $workspaceId = null)
 * @method static void set(string $key, mixed $value, ?int $workspaceId = null, ?int $updatedBy = null)
 * @method static bool seedMissing(string $key, mixed $value, ?int $workspaceId = null)
 * @method static array<string, mixed> all(?int $workspaceId = null)
 * @method static void forget(?int $workspaceId = null)
 *
 * @see SettingsRepository
 */
final class Settings extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return SettingsRepository::class;
    }
}
