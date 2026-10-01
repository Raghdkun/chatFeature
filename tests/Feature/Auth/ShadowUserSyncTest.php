<?php

namespace Tests\Feature\Auth;

use App\Auth\Pizzasys\Results\PortalClaims;
use App\Auth\Shadow\ShadowSyncResult;
use App\Auth\Shadow\ShadowUserSync;
use App\Models\AuthEnvironment;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use Tests\TestCase;

class ShadowUserSyncTest extends TestCase
{
    use RefreshDatabase;

    private AuthEnvironment $production;

    private ShadowUserSync $sync;

    protected function setUp(): void
    {
        parent::setUp();

        $this->production = AuthEnvironment::factory()->production()->create();
        $this->sync = app(ShadowUserSync::class);
    }

    private function claims(string $sub = '42', string $email = 'ada@example.test', string $name = 'Ada Lovelace', array $permissions = ['chat.agent']): PortalClaims
    {
        return new PortalClaims($sub, $name, $email, [], $permissions);
    }

    public function test_a_first_login_creates_the_shadow_user_and_its_identity(): void
    {
        $result = $this->sync->upsert($this->production, $this->claims());

        $this->assertTrue($result->isSynced());
        $this->assertTrue($result->created);

        $user = $result->user;
        $this->assertSame('ada@example.test', $user->email);
        $this->assertSame('Ada Lovelace', $user->name);
        $this->assertSame('Ada Lovelace', $user->display_name);
        $this->assertNull($user->password);
        $this->assertSame('pizzasys', $user->auth_source);
        $this->assertNotNull($user->email_verified_at);
        $this->assertTrue($user->is_active);
        $this->assertFalse($user->is_admin, 'roles are the resolver\'s job, not the sync\'s');
        $this->assertFalse($user->is_agent);

        $identity = $result->identity;
        $this->assertSame($this->production->id, $identity->auth_environment_id);
        $this->assertSame('42', $identity->external_id);
        $this->assertSame(['chat.agent'], $identity->permissions);
        $this->assertTrue($identity->active);
        $this->assertNotNull($identity->last_verified_at);
        $this->assertNull($identity->stale_at);
    }

    public function test_the_identity_is_matched_by_the_portal_id_and_never_duplicated(): void
    {
        $this->sync->upsert($this->production, $this->claims());
        $this->sync->upsert($this->production, $this->claims());
        $this->sync->upsert($this->production, $this->claims());

        $this->assertSame(1, User::query()->count());
        $this->assertSame(1, UserExternalIdentity::query()->count());
    }

    public function test_name_and_email_follow_the_portal_on_every_sync(): void
    {
        $first = $this->sync->upsert($this->production, $this->claims())->user;

        $second = $this->sync->upsert($this->production, $this->claims(email: 'Ada.New@Example.test', name: 'Ada King'))->user;

        $this->assertTrue($first->is($second));
        $this->assertSame('ada.new@example.test', $second->email);
        $this->assertSame('Ada King', $second->name);
        $this->assertSame('Ada King', $second->display_name, 'an uncustomised display name follows');
        $this->assertSame(1, UserExternalIdentity::query()->count());
    }

    public function test_a_display_name_is_never_an_email_address(): void
    {
        // The portal sends the address as the name: the account name keeps it, the name visitors see does not.
        $user = $this->sync->upsert($this->production, $this->claims(email: 'ada.lovelace@example.test', name: 'ada.lovelace@example.test'))->user;

        $this->assertSame('ada.lovelace@example.test', $user->name);
        $this->assertSame('Ada Lovelace', $user->display_name);
        $this->assertSame('Ada Lovelace', $user->public_label);

        // An address stored as the display name by an earlier version is corrected on the next sync; a real name then follows the portal.
        $user->forceFill(['display_name' => 'ada.lovelace@example.test'])->save();
        $this->sync->upsert($this->production, $this->claims(email: 'ada.lovelace@example.test', name: 'Ada King'));
        $this->assertSame('Ada King', $user->refresh()->display_name);
    }

    public function test_a_customised_display_name_is_kept(): void
    {
        $user = $this->sync->upsert($this->production, $this->claims())->user;
        $user->forceFill(['display_name' => 'Support Ada'])->save();

        $this->sync->upsert($this->production, $this->claims(name: 'Ada King'));

        $this->assertSame('Ada King', $user->refresh()->name);
        $this->assertSame('Support Ada', $user->display_name);
    }

    public function test_an_email_that_belongs_to_another_user_is_not_taken_over(): void
    {
        $user = $this->sync->upsert($this->production, $this->claims())->user;
        User::factory()->create(['email' => 'taken@example.test']);

        $this->sync->upsert($this->production, $this->claims(email: 'taken@example.test', name: 'Ada Renamed'));

        $this->assertSame('ada@example.test', $user->refresh()->email);
        $this->assertSame('Ada Renamed', $user->name);
    }

    public function test_roles_and_permissions_are_stored_and_staleness_is_cleared_on_each_sync(): void
    {
        $identity = $this->sync->upsert($this->production, $this->claims())->identity;
        $identity->forceFill(['stale_at' => now()->subMinute()])->save();

        $updated = $this->sync->upsert($this->production, new PortalClaims('42', 'Ada Lovelace', 'ada@example.test', ['super-admin'], ['chat.agent', 'chat.admin']))->identity;

        $this->assertTrue($identity->is($updated));
        $this->assertSame(['super-admin'], $updated->roles);
        $this->assertSame(['chat.agent', 'chat.admin'], $updated->permissions);
        $this->assertNull($updated->stale_at);
    }

    public function test_an_existing_portal_user_is_linked_by_email_when_the_identity_is_new(): void
    {
        $existing = User::factory()->agent()->create(['email' => 'ada@example.test', 'auth_source' => 'pizzasys', 'password' => null]);

        $result = $this->sync->upsert($this->production, $this->claims(sub: '7'));

        $this->assertFalse($result->created);
        $this->assertTrue($existing->is($result->user));
        $this->assertSame(1, User::query()->count());
        $this->assertSame('7', $existing->externalIdentities()->sole()->external_id);
    }

    public function test_the_email_link_ignores_letter_case(): void
    {
        $existing = User::factory()->create(['email' => 'ada@example.test', 'auth_source' => 'pizzasys']);

        $result = $this->sync->upsert($this->production, $this->claims(email: 'ADA@Example.TEST'));

        $this->assertTrue($existing->is($result->user));
    }

    public function test_a_local_account_with_the_same_email_is_never_adopted(): void
    {
        User::factory()->create(['email' => 'ada@example.test', 'auth_source' => 'local']);

        $result = $this->sync->upsert($this->production, $this->claims());

        $this->assertFalse($result->isSynced());
        $this->assertSame(ShadowSyncResult::EMAIL_CONFLICT, $result->refusal);
        $this->assertSame(0, UserExternalIdentity::query()->count());
    }

    public function test_a_deactivated_identity_cannot_sign_in(): void
    {
        $identity = $this->sync->upsert($this->production, $this->claims())->identity;
        $identity->forceFill(['active' => false, 'deactivated_at' => now()])->save();

        $result = $this->sync->upsert($this->production, $this->claims());

        $this->assertFalse($result->isSynced());
        $this->assertSame(ShadowSyncResult::IDENTITY_DEACTIVATED, $result->refusal);
        $this->assertNotNull($identity->refresh()->deactivated_at, 'nothing was resurrected');
    }

    public function test_a_deactivated_local_user_cannot_sign_in(): void
    {
        $user = $this->sync->upsert($this->production, $this->claims())->user;
        $user->forceFill(['is_active' => false])->save();

        $result = $this->sync->upsert($this->production, $this->claims());

        $this->assertSame(ShadowSyncResult::ACCOUNT_DEACTIVATED, $result->refusal);
    }

    public function test_it_can_refuse_to_create_accounts_for_people_without_a_chat_role(): void
    {
        $result = $this->sync->upsert($this->production, $this->claims(), createIfMissing: false);

        $this->assertSame(ShadowSyncResult::NOT_CREATED, $result->refusal);
        $this->assertSame(0, User::query()->count());

        // but an account that already exists is still refreshed
        $this->sync->upsert($this->production, $this->claims());
        $refreshed = $this->sync->upsert($this->production, $this->claims(name: 'Ada New'), createIfMissing: false);
        $this->assertTrue($refreshed->isSynced());
        $this->assertSame('Ada New', $refreshed->user->name);
    }

    public function test_the_same_portal_id_in_the_other_environment_is_a_different_identity(): void
    {
        $testing = AuthEnvironment::factory()->testing()->create();

        $a = $this->sync->upsert($this->production, $this->claims(sub: '5', email: 'a@example.test'));
        $b = $this->sync->upsert($testing, $this->claims(sub: '5', email: 'b@example.test'));

        $this->assertFalse($a->user->is($b->user));
        $this->assertSame(2, UserExternalIdentity::query()->count());
    }

    public function test_the_same_person_in_both_environments_is_one_local_user_with_two_identities(): void
    {
        $testing = AuthEnvironment::factory()->testing()->create();

        $a = $this->sync->upsert($this->production, $this->claims(sub: '5'));
        $b = $this->sync->upsert($testing, $this->claims(sub: '905'));

        $this->assertTrue($a->user->is($b->user), 'matched by email when the new environment has no identity yet');
        $this->assertSame(2, $a->user->externalIdentities()->count());
        $this->assertSame(1, User::query()->count());
    }

    // ---- account takeover by email linking ---------------------------------------------------------------------

    public function test_a_second_portal_account_with_the_same_email_is_refused_while_the_first_identity_is_live(): void
    {
        $first = $this->sync->upsert($this->production, $this->claims(sub: '1', permissions: ['chat.admin']));

        $second = $this->sync->upsert($this->production, $this->claims(sub: '2', permissions: ['chat.agent']));

        $this->assertFalse($second->isSynced());
        $this->assertSame(ShadowSyncResult::IDENTITY_CONFLICT, $second->refusal);
        $this->assertNull($second->user, 'the refusal does not hand out the account that already exists');
        $this->assertNull($second->identity);
        $this->assertSame(1, User::query()->count());
        $this->assertSame(['1'], UserExternalIdentity::query()->pluck('external_id')->all(), 'no identity was linked for the newcomer');
        $this->assertSame(['chat.admin'], $first->identity->refresh()->permissions, 'the first identity is untouched');
    }

    public function test_the_refusal_is_logged_with_ids_only(): void
    {
        $this->sync->upsert($this->production, $this->claims(sub: '1', email: 'secret.person@example.test'));
        $logged = [];
        Log::listen(function ($event) use (&$logged): void {
            $logged[] = $event->message.' '.json_encode($event->context);
        });

        $this->sync->upsert($this->production, $this->claims(sub: '2', email: 'secret.person@example.test', name: 'Secret Person'));

        $dump = implode("\n", $logged);
        $this->assertStringContainsString('identity_conflict', $dump);
        $this->assertStringNotContainsString('secret.person@example.test', $dump);
        $this->assertStringNotContainsString('Secret Person', $dump);
    }

    public function test_the_conflict_check_ignores_the_letter_case_of_the_email(): void
    {
        $this->sync->upsert($this->production, $this->claims(sub: '1', email: 'ada@example.test'));

        $result = $this->sync->upsert($this->production, $this->claims(sub: '2', email: 'ADA@Example.TEST'));

        $this->assertSame(ShadowSyncResult::IDENTITY_CONFLICT, $result->refusal);
        $this->assertSame(1, UserExternalIdentity::query()->count());
    }

    public function test_a_stored_mixed_case_email_is_matched_too(): void
    {
        $user = User::factory()->create(['email' => 'Ada@Example.test', 'auth_source' => 'pizzasys', 'password' => null]);
        UserExternalIdentity::factory()->create(['user_id' => $user->id, 'auth_environment_id' => $this->production->id, 'external_id' => '1']);

        $result = $this->sync->upsert($this->production, $this->claims(sub: '2', email: 'ada@example.test'));

        $this->assertSame(ShadowSyncResult::IDENTITY_CONFLICT, $result->refusal);
    }

    public function test_a_new_account_may_take_over_the_local_user_once_the_old_identity_is_deactivated(): void
    {
        $old = $this->sync->upsert($this->production, $this->claims(sub: '1', permissions: ['chat.admin']));
        $old->identity->forceFill(['active' => false, 'deactivated_at' => now()])->save();

        $result = $this->sync->upsert($this->production, $this->claims(sub: '2', permissions: ['chat.agent']));

        $this->assertTrue($result->isSynced());
        $this->assertFalse($result->created);
        $this->assertTrue($old->user->is($result->user), 'the person keeps their local account and history');
        $this->assertSame('2', $result->identity->external_id);
        $this->assertSame(['chat.agent'], $result->identity->permissions, 'the newcomer carries its own permissions');
        $this->assertNotNull($old->identity->refresh()->deactivated_at, 'the old identity stays deactivated');
        $this->assertSame(2, UserExternalIdentity::query()->count());
    }

    public function test_an_identity_in_the_other_environment_does_not_block_a_link(): void
    {
        $testing = AuthEnvironment::factory()->testing()->create();
        $this->sync->upsert($testing, $this->claims(sub: '900'));

        $result = $this->sync->upsert($this->production, $this->claims(sub: '1'));

        $this->assertTrue($result->isSynced());
        $this->assertSame(1, User::query()->count());
    }

    public function test_the_database_allows_one_live_identity_per_user_and_environment(): void
    {
        $user = User::factory()->create(['auth_source' => 'pizzasys', 'password' => null]);
        $live = UserExternalIdentity::factory()->create(['user_id' => $user->id, 'auth_environment_id' => $this->production->id, 'external_id' => '1']);

        $this->assertThrows(
            fn () => UserExternalIdentity::factory()->create(['user_id' => $user->id, 'auth_environment_id' => $this->production->id, 'external_id' => '2']),
            UniqueConstraintViolationException::class,
        );

        // deactivated rows do not count, however many there are ...
        UserExternalIdentity::factory()->deactivated()->create(['user_id' => $user->id, 'auth_environment_id' => $this->production->id, 'external_id' => '3']);
        UserExternalIdentity::factory()->deactivated()->create(['user_id' => $user->id, 'auth_environment_id' => $this->production->id, 'external_id' => '4']);

        // ... another environment is independent ...
        $testing = AuthEnvironment::factory()->testing()->create();
        UserExternalIdentity::factory()->create(['user_id' => $user->id, 'auth_environment_id' => $testing->id, 'external_id' => '1']);

        // ... and deactivating the live one frees the slot.
        $live->forceFill(['active' => false, 'deactivated_at' => now()])->save();
        UserExternalIdentity::factory()->create(['user_id' => $user->id, 'auth_environment_id' => $this->production->id, 'external_id' => '5']);

        $this->assertSame(1, UserExternalIdentity::query()->where('auth_environment_id', $this->production->id)->whereNull('deactivated_at')->count());
    }

    // ---- unique-key races ----------------------------------------------------------------------------------------------

    private function failInsertOfIdentity(int $times): void
    {
        $remaining = $times;

        UserExternalIdentity::creating(function () use (&$remaining): void {
            if ($remaining-- > 0) {
                throw new UniqueConstraintViolationException('sqlite', 'insert into "user_external_identities"', [], new \Exception('UNIQUE constraint failed'));
            }
        });
    }

    public function test_losing_a_first_login_race_retries_once_and_succeeds(): void
    {
        $this->failInsertOfIdentity(1);

        $result = $this->sync->upsert($this->production, $this->claims());

        $this->assertTrue($result->isSynced());
        $this->assertSame(1, User::query()->count(), 'the failed attempt left nothing behind');
        $this->assertSame(1, UserExternalIdentity::query()->count());
    }

    public function test_a_second_unique_violation_is_a_refusal_not_a_crash(): void
    {
        $this->failInsertOfIdentity(2);

        $result = $this->sync->upsert($this->production, $this->claims());

        $this->assertSame(ShadowSyncResult::IDENTITY_CONFLICT, $result->refusal);
        $this->assertSame(0, User::query()->count(), 'nothing half-created');
    }
}
