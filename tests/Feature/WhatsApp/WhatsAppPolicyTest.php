<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Policies\WhatsAppPolicy;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Gate;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * Decision P6-D1: every WhatsApp ability is for active administrators and nobody else. The matrix is run through the Gate (which
 * `Gate::before` short-circuits for admins) AND through the policy itself, so the policy alone keeps agents out.
 */
class WhatsAppPolicyTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures;

    private const ABILITIES = ['viewAny', 'view', 'reply', 'manageSessions', 'manageSettings', 'archive', 'delete', 'export'];

    /** @var array<string, bool> who may: person => allowed */
    private const MATRIX = [
        'admin' => true,
        'adminAndAgent' => true,
        'agent' => false,
        'inactiveAdmin' => false,
        'inactiveAgent' => false,
        'noRole' => false,
    ];

    /**
     * @return iterable<string, array{string, string}>
     */
    public static function everyPersonAndAbility(): iterable
    {
        foreach (array_keys(self::MATRIX) as $person) {
            foreach (self::ABILITIES as $ability) {
                yield "{$person} / {$ability}" => [$person, $ability];
            }
        }
    }

    /**
     * What each ability is asked about: a chat, a message, a session, or nothing (the class name).
     */
    private function subject(string $ability): mixed
    {
        return match ($ability) {
            'viewAny' => WaChat::class,
            'view' => WaChat::factory()->create(),
            'reply', 'archive', 'delete', 'export' => WaChat::factory()->create(),
            'manageSessions' => WhatsAppSession::factory()->create(),
            'manageSettings' => WhatsAppSession::class,
        };
    }

    public function test_the_policy_is_registered_for_chats_messages_and_sessions(): void
    {
        foreach ([WaChat::class, WaMessage::class, WhatsAppSession::class] as $model) {
            $this->assertInstanceOf(WhatsAppPolicy::class, Gate::getPolicyFor($model), $model);
        }
    }

    #[DataProvider('everyPersonAndAbility')]
    public function test_the_gate_lets_in_active_administrators_only(string $person, string $ability): void
    {
        $user = $this->whatsAppPeople()[$person];

        $this->assertSame(self::MATRIX[$person], Gate::forUser($user)->allows($ability, $this->subject($ability)), "{$person} may {$ability}");
        $this->assertSame(self::MATRIX[$person], $user->can($ability, $this->subject($ability)));
    }

    #[DataProvider('everyPersonAndAbility')]
    public function test_the_policy_decides_the_same_without_the_gate_before_rule(string $person, string $ability): void
    {
        $user = $this->whatsAppPeople()[$person];
        $subject = $this->subject($ability);
        $policy = new WhatsAppPolicy;

        $allowed = match ($ability) {
            'viewAny', 'manageSettings' => $policy->{$ability}($user),
            default => $policy->{$ability}($user, is_object($subject) ? $subject : null),
        };

        $this->assertSame(self::MATRIX[$person], $allowed, "{$person} may {$ability}");
    }

    public function test_a_message_and_a_session_are_viewed_by_administrators_only(): void
    {
        $people = $this->whatsAppPeople();
        $message = WaMessage::factory()->create();
        $session = WhatsAppSession::factory()->create();
        $policy = new WhatsAppPolicy;

        foreach (self::MATRIX as $person => $allowed) {
            $this->assertSame($allowed, $policy->view($people[$person], $message), $person);
            $this->assertSame($allowed, $policy->view($people[$person], $session), $person);
            $this->assertSame($allowed, Gate::forUser($people[$person])->allows('view', $message), $person);
        }
    }

    public function test_a_guest_is_denied_every_ability(): void
    {
        foreach (self::ABILITIES as $ability) {
            $this->assertFalse(Gate::forUser(null)->allows($ability, $this->subject($ability)), "a guest may {$ability}");
        }
    }

    public function test_an_agent_who_is_assigned_to_the_chats_category_still_has_no_access(): void
    {
        $agent = User::factory()->agent()->create();
        $chat = WaChat::factory()->linked()->create();
        $chat->category?->users()->attach($agent->id);

        $this->assertFalse($agent->can('view', $chat));
        $this->assertFalse($agent->can('reply', $chat));
        $this->assertFalse($agent->can('viewAny', WaChat::class));
    }

    public function test_deactivating_an_administrator_takes_the_access_away(): void
    {
        $admin = User::factory()->admin()->create();
        $this->assertTrue($admin->can('viewAny', WaChat::class));

        $admin->forceFill(['is_active' => false])->save();

        $this->assertFalse($admin->fresh()?->can('viewAny', WaChat::class));
    }
}
