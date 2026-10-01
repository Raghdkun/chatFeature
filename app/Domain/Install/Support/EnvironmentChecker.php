<?php

namespace App\Domain\Install\Support;

use App\Domain\Install\InstallAwareConfig;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Encryption\Encrypter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;
use Throwable;

/**
 * Environment check for step 0 of the wizard: PHP extensions, writable storage, APP_KEY, the
 * database connection and (optionally) Redis. It only ever *connects* to the database
 * (PDO handshake, no statement is executed) so it is safe before the first migration.
 */
final class EnvironmentChecker
{
    public function __construct(
        private readonly Repository $config,
        private readonly InstallAwareConfig $driverConfig,
    ) {}

    /**
     * @return list<EnvironmentCheck>
     */
    public function run(): array
    {
        return [
            $this->phpVersion(),
            $this->extension('ext_pdo', 'PDO extension', ['pdo']),
            $this->databaseDriverExtension(),
            $this->extension('ext_mbstring', 'mbstring extension', ['mbstring']),
            $this->extension('ext_openssl', 'OpenSSL extension', ['openssl']),
            $this->extension('ext_fileinfo', 'fileinfo extension', ['fileinfo']),
            $this->extension('ext_image', 'Image library (gd or imagick)', ['gd', 'imagick'], any: true),
            $this->extension('ext_intl', 'intl extension', ['intl']),
            $this->storageWritable(),
            $this->appKey(),
            $this->database(),
            $this->redis(),
        ];
    }

    /**
     * @param  list<EnvironmentCheck>  $checks
     */
    public static function passes(array $checks): bool
    {
        foreach ($checks as $check) {
            if (! $check->ok && ! $check->optional) {
                return false;
            }
        }

        return true;
    }

    private function phpVersion(): EnvironmentCheck
    {
        $ok = version_compare(PHP_VERSION, '8.3.0', '>=');

        return new EnvironmentCheck(
            'php_version',
            $this->t('PHP 8.3 or newer'),
            $ok,
            $ok ? PHP_VERSION : $this->t('PHP :version is installed; 8.3 or newer is required.', ['version' => PHP_VERSION]),
        );
    }

    /**
     * @param  list<string>  $extensions
     */
    private function extension(string $key, string $label, array $extensions, bool $any = false): EnvironmentCheck
    {
        $missing = array_values(array_filter($extensions, fn (string $name): bool => ! extension_loaded($name)));
        $ok = $any ? count($missing) < count($extensions) : $missing === [];

        return new EnvironmentCheck(
            $key,
            $this->t($label),
            $ok,
            $ok ? null : $this->t('Missing PHP extension: :extensions.', ['extensions' => implode($any ? ' or ' : ', ', $missing)]),
        );
    }

    private function databaseDriverExtension(): EnvironmentCheck
    {
        $connection = $this->config->get('database.default');
        $driver = is_string($connection) ? $this->config->get("database.connections.{$connection}.driver") : null;

        $needed = match ($driver) {
            'mysql', 'mariadb' => ['pdo_mysql'],
            'sqlite' => ['pdo_sqlite'],
            'pgsql' => ['pdo_pgsql'],
            default => ['pdo_mysql', 'pdo_sqlite'],
        };

        return $this->extension(
            'ext_pdo_driver',
            $needed === ['pdo_mysql', 'pdo_sqlite'] ? 'PDO MySQL or SQLite driver' : 'PDO database driver',
            $needed,
            any: count($needed) > 1,
        );
    }

    private function storageWritable(): EnvironmentCheck
    {
        $paths = [
            storage_path('app'),
            storage_path('framework'),
            storage_path('logs'),
            base_path('bootstrap/cache'),
        ];

        $unwritable = array_values(array_filter($paths, fn (string $path): bool => ! is_dir($path) || ! is_writable($path)));

        return new EnvironmentCheck(
            'storage_writable',
            $this->t('Storage directories are writable'),
            $unwritable === [],
            $unwritable === []
                ? null
                : $this->t('Not writable: :paths.', ['paths' => implode(', ', array_map(fn (string $path): string => Str::after($path, base_path().'/'), $unwritable))]),
        );
    }

    private function appKey(): EnvironmentCheck
    {
        $key = $this->config->get('app.key');
        $cipher = $this->config->get('app.cipher');
        $ok = false;

        if (is_string($key) && $key !== '' && is_string($cipher)) {
            $decoded = str_starts_with($key, 'base64:') ? base64_decode(substr($key, 7), true) : $key;
            $ok = is_string($decoded) && Encrypter::supported($decoded, $cipher);
        }

        return new EnvironmentCheck(
            'app_key',
            $this->t('Application key (APP_KEY)'),
            $ok,
            $ok ? null : $this->t('APP_KEY is missing or invalid. Run "php artisan chat:bootstrap-secrets" and reload.'),
        );
    }

    private function database(): EnvironmentCheck
    {
        $label = $this->t('Database connection');

        try {
            $connection = DB::connection();
            $connection->getPdo();

            return new EnvironmentCheck('database', $label, true, $this->t('Connected to :driver database ":name".', [
                'driver' => $connection->getDriverName(),
                'name' => basename((string) $connection->getDatabaseName()),
            ]));
        } catch (Throwable $exception) {
            return new EnvironmentCheck('database', $label, false, $this->friendlyDatabaseError($exception));
        }
    }

    private function redis(): EnvironmentCheck
    {
        $label = $this->t('Redis (optional)');

        if (! $this->driverConfig->usesRedis()) {
            return new EnvironmentCheck('redis', $label, true, $this->t('Not used by the current configuration.'), optional: true);
        }

        try {
            Redis::connection()->ping();

            return new EnvironmentCheck('redis', $label, true, $this->t('Connected.'), optional: true);
        } catch (Throwable $exception) {
            return new EnvironmentCheck(
                'redis',
                $label,
                false,
                $this->t('Redis is configured in .env (session/cache/queue) but is not reachable: :message', [
                    'message' => Str::limit($exception->getMessage(), 160),
                ]),
            );
        }
    }

    /**
     * @param  array<string, string>  $replace
     */
    private function t(string $key, array $replace = []): string
    {
        $line = trans($key, $replace);

        return is_string($line) ? $line : $key;
    }

    private function friendlyDatabaseError(Throwable $exception): string
    {
        $message = $exception->getMessage();
        $name = (string) $this->config->get('database.connections.'.$this->config->get('database.default').'.database');

        return match (true) {
            str_contains($message, '[1045]'), str_contains($message, 'Access denied') => $this->t('Could not connect to the database: access denied. Check DB_USERNAME and DB_PASSWORD.'),
            str_contains($message, '[1049]'), str_contains($message, 'Unknown database') => $this->t('Could not connect to the database: ":name" does not exist. Create it first.', ['name' => $name]),
            str_contains($message, '[2002]'), str_contains($message, 'Connection refused'), str_contains($message, 'getaddrinfo') => $this->t('Could not connect to the database: the server is not reachable. Check DB_HOST and DB_PORT and that it is running.'),
            str_contains($message, 'could not find driver') => $this->t('Could not connect to the database: the PDO driver for this connection is not installed.'),
            default => $this->t('Could not connect to the database: :message', ['message' => Str::limit(trim((string) strtok($message, "\n")), 180)]),
        };
    }
}
