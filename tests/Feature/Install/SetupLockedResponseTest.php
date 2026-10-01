<?php

namespace Tests\Feature\Install;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\InstallStateFake;
use Tests\TestCase;

class SetupLockedResponseTest extends TestCase
{
    use RefreshDatabase;

    public function test_json_callers_get_an_explicit_installed_marker_after_install(): void
    {
        InstallStateFake::make(installed: true);

        $this->postJson('/setup/run/run-migrations')
            ->assertStatus(404)
            ->assertExactJson(['status' => 'installed']);
    }

    public function test_html_callers_get_a_plain_404_after_install(): void
    {
        InstallStateFake::make(installed: true);

        $this->get('/setup')->assertNotFound();
    }
}
