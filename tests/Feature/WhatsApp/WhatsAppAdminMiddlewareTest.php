<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\Visitors\VisitorTokenService;
use App\Http\Middleware\EnsureWhatsAppAdmin;
use App\Models\User;
use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * `wa.admin` on probe routes: the full management-API stack, the middleware alone, and a web page. Active administrators pass;
 * agents, accounts without a role, deactivated administrators, guests and visitor tokens do not, and are told nothing about WhatsApp.
 */
class WhatsAppAdminMiddlewareTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();

        Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', 'wa.admin'])->get('/api/v1/_wa-probe', fn () => ['ok' => true]);
        Route::middleware(['wa.admin'])->get('/api/v1/_wa-bare', fn () => ['ok' => true]);
        Route::middleware(['web', 'auth', 'wa.admin'])->get('/_wa-page', fn () => 'the inbox');
    }

    public function test_the_alias_is_registered(): void
    {
        $this->assertSame(EnsureWhatsAppAdmin::class, app('router')->getMiddleware()['wa.admin'] ?? null);
    }

    /**
     * @return iterable<string, array{string, int}>
     */
    public static function people(): iterable
    {
        yield 'admin' => ['admin', 200];
        yield 'admin who is also an agent' => ['adminAndAgent', 200];
        yield 'agent' => ['agent', 403];
        yield 'user without a chat role' => ['noRole', 403];
    }

    #[DataProvider('people')]
    public function test_the_management_api_stack(string $person, int $status): void
    {
        $response = $this->actingAs($this->whatsAppPeople()[$person], 'sanctum')->getJson('/api/v1/_wa-probe');

        $response->assertStatus($status);

        if ($status === 403) {
            // `chat.access` turns a user without any chat role away first, with its own code.
            $this->assertContains($response->json('error.code'), ['forbidden', 'no_chat_access']);
        }
    }

    #[DataProvider('people')]
    public function test_the_middleware_alone_decides_the_same(string $person, int $status): void
    {
        $response = $this->actingAs($this->whatsAppPeople()[$person], 'sanctum')->getJson('/api/v1/_wa-bare');

        $response->assertStatus($status);

        if ($status === 403) {
            $response->assertExactJson(['error' => ['code' => 'forbidden', 'message' => 'Only administrators can do this.']]);
        }
    }

    public function test_a_deactivated_administrator_is_turned_away_everywhere(): void
    {
        $inactive = $this->whatsAppPeople()['inactiveAdmin'];

        $this->actingAs($inactive, 'sanctum')->getJson('/api/v1/_wa-bare')->assertForbidden()->assertJsonPath('error.code', 'forbidden');

        $full = $this->actingAs($inactive, 'sanctum')->getJson('/api/v1/_wa-probe');
        $this->assertContains($full->getStatusCode(), [401, 403], 'the session check or the role check ends it');
        $full->assertJsonMissing(['ok' => true]);
    }

    public function test_a_guest_is_unauthenticated_in_the_stack_and_forbidden_on_the_bare_middleware(): void
    {
        $this->getJson('/api/v1/_wa-probe')->assertUnauthorized();
        $this->getJson('/api/v1/_wa-bare')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
    }

    public function test_a_visitor_token_is_not_an_administrator(): void
    {
        $visitor = Visitor::factory()->create(['widget_id' => Widget::factory()->create()->id]);
        $token = app(VisitorTokenService::class)->issue($visitor)->plaintext;

        $this->withToken($token)->getJson('/api/v1/_wa-probe')->assertUnauthorized();
        $this->withToken($token)->getJson('/api/v1/_wa-bare')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
    }

    public function test_an_agent_sees_the_normal_403_page_not_json_on_a_web_route(): void
    {
        $this->actingAs(User::factory()->agent()->create())->get('/_wa-page')->assertForbidden()->assertDontSee('the inbox');
        $this->actingAs(User::factory()->admin()->create())->get('/_wa-page')->assertOk()->assertSee('the inbox');
    }

    public function test_a_web_route_answers_json_to_a_client_that_asks_for_json(): void
    {
        $this->actingAs(User::factory()->agent()->create())->getJson('/_wa-page')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
    }
}
