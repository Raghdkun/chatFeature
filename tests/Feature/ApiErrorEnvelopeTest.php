<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

class ApiErrorEnvelopeTest extends TestCase
{
    use RefreshDatabase;

    public function test_validation_errors_use_the_documented_envelope(): void
    {
        Route::post('/api/v1/_validate', fn () => throw ValidationException::withMessages(['name' => ['Required.']]));

        $this->postJson('/api/v1/_validate')
            ->assertStatus(422)
            ->assertExactJson(['error' => ['code' => 'validation_failed', 'message' => 'The given data was invalid.', 'details' => ['name' => ['Required.']]]]);
    }

    public function test_unauthenticated_and_not_found_use_the_envelope(): void
    {
        Route::middleware('auth:sanctum')->get('/api/v1/_secret', fn () => ['ok' => true]);

        $this->getJson('/api/v1/_secret')->assertStatus(401)->assertJsonPath('error.code', 'unauthenticated');
        $this->getJson('/api/v1/does-not-exist')->assertStatus(404)->assertJsonPath('error.code', 'not_found');
    }

    public function test_forbidden_aborts_use_the_envelope(): void
    {
        Route::get('/api/v1/_nope', fn () => abort(403, 'Not yours.'));

        $this->getJson('/api/v1/_nope')->assertStatus(403)->assertJsonPath('error.code', 'forbidden')->assertJsonPath('error.message', 'Not yours.');
    }

    public function test_web_requests_are_not_affected(): void
    {
        $this->actingAs(User::factory()->agent()->create());

        $this->get('/definitely-missing')->assertNotFound();
    }
}
