<?php

namespace Tests\Feature\Install;

use App\Domain\Install\InstallContext;
use App\Domain\Install\Steps\CreateAdminStep;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\Support\InstallStateFake;
use Tests\TestCase;

class CreateAdminGuardTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<string, mixed> */
    private function answers(string $email = 'owner@example.test'): array
    {
        return [
            'mode' => 'fortify',
            'admin' => ['name' => 'Owner', 'email' => $email, 'password_hash' => Hash::make('a-long-passphrase')],
        ];
    }

    public function test_it_creates_the_first_administrator_in_an_empty_database(): void
    {
        $state = InstallStateFake::make(state: $this->answers());

        $result = app(CreateAdminStep::class)->run(InstallContext::fromState($state));

        $this->assertTrue($result->isOk());
        $this->assertTrue(User::query()->where('email', 'owner@example.test')->firstOrFail()->is_admin);
    }

    public function test_a_retry_after_a_partial_install_reuses_the_administrator_it_created(): void
    {
        $state = InstallStateFake::make(state: $this->answers());
        $step = app(CreateAdminStep::class);

        $this->assertTrue($step->run(InstallContext::fromState($state))->isOk());
        $this->assertTrue($step->run(InstallContext::fromState($state))->isOk());
        $this->assertSame(1, User::query()->count());
    }

    public function test_it_refuses_to_touch_an_existing_non_admin_account(): void
    {
        $victim = User::factory()->agent()->create(['email' => 'owner@example.test']);
        $oldHash = $victim->password;
        $state = InstallStateFake::make(state: $this->answers());

        $result = app(CreateAdminStep::class)->run(InstallContext::fromState($state));

        $this->assertFalse($result->isOk());
        $victim->refresh();
        $this->assertFalse($victim->is_admin);
        $this->assertSame($oldHash, $victim->password);
    }

    public function test_it_refuses_a_database_that_already_has_other_users(): void
    {
        User::factory()->agent()->create(['email' => 'someone@example.test']);
        $state = InstallStateFake::make(state: $this->answers());

        $result = app(CreateAdminStep::class)->run(InstallContext::fromState($state));

        $this->assertFalse($result->isOk());
        $this->assertSame(1, User::query()->count());
    }

    public function test_changing_the_answer_after_the_step_ran_updates_the_wizards_own_administrator(): void
    {
        $step = app(CreateAdminStep::class);

        $first = InstallStateFake::make(state: $this->answers('first@example.test'));
        $this->assertTrue($step->run(InstallContext::fromState($first))->isOk());

        $second = InstallStateFake::make(state: $this->answers('second@example.test'));
        $this->assertTrue($step->run(InstallContext::fromState($second))->isOk());

        $this->assertSame(1, User::query()->count());
        $this->assertTrue(User::query()->where('email', 'second@example.test')->firstOrFail()->is_admin);
    }
}
