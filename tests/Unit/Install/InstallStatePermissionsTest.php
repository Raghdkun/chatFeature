<?php

namespace Tests\Unit\Install;

use App\Domain\Install\InstallState;
use Illuminate\Support\Str;
use Tests\TestCase;

class InstallStatePermissionsTest extends TestCase
{
    public function test_the_state_file_is_created_private_to_the_owner(): void
    {
        $directory = sys_get_temp_dir().'/chat-perm-'.Str::lower(Str::random(8));
        $state = new InstallState($directory);

        $state->mutate(fn (array $current): array => [...$current, 'mode' => 'fortify']);

        $this->assertSame(0600, fileperms($state->statePath()) & 0777);

        $state->reset();
        @rmdir($directory);
    }
}
