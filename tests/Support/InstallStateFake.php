<?php

namespace Tests\Support;

use App\Domain\Install\InstallState;
use Illuminate\Support\Str;

/**
 * Test helper: points the container's InstallState at a throwaway directory.
 */
final class InstallStateFake
{
    /**
     * @param  array<string, mixed>  $state  Initial install-state.json content.
     */
    public static function make(bool $installed = false, array $state = []): InstallState
    {
        $instance = app(InstallState::class);

        $directory = rtrim(sys_get_temp_dir(), '/').'/chat-install-'.Str::lower(Str::random(12));
        mkdir($directory, 0775, true);
        register_shutdown_function(static function () use ($directory): void {
            foreach (glob($directory.'/*') ?: [] as $file) {
                @unlink($file);
            }
            @rmdir($directory);
        });

        $instance->useDirectory($directory);

        if ($state !== []) {
            $instance->mutate(fn (array $current): array => array_replace($current, $state));
        }

        if ($installed) {
            $instance->writeLock(['mode' => 'fortify']);
        }

        return $instance;
    }
}
