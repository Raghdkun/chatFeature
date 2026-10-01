<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ExampleTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_root_url_sends_guests_to_the_login_page()
    {
        $response = $this->get(route('home'));

        $response->assertRedirect(route('login'));
    }
}
