<?php

namespace Tests\Unit\Install;

use App\Domain\Install\SetupTokenManager;
use Illuminate\Http\Request;
use Illuminate\Session\ArraySessionHandler;
use Illuminate\Session\Store;
use Tests\TestCase;

class SetupTokenManagerTest extends TestCase
{
    private SetupTokenManager $manager;

    protected function setUp(): void
    {
        parent::setUp();

        config(['install.setup_token' => 'correct-horse-battery']);
        $this->manager = new SetupTokenManager;
    }

    private function freshSession(): Store
    {
        return new Store('test', new ArraySessionHandler(10));
    }

    public function test_the_correct_token_verifies_and_anything_else_does_not(): void
    {
        $this->assertTrue($this->manager->verify('correct-horse-battery'));
        $this->assertFalse($this->manager->verify('correct-horse-batterz'));
        $this->assertFalse($this->manager->verify('correct-horse-battery '));
        $this->assertFalse($this->manager->verify('c'));
        $this->assertFalse($this->manager->verify(''));
        $this->assertFalse($this->manager->verify(str_repeat('x', 5000)));
    }

    public function test_the_configured_token_is_trimmed(): void
    {
        config(['install.setup_token' => "  correct-horse-battery\n"]);

        $this->assertTrue($this->manager->verify('correct-horse-battery'));
    }

    public function test_it_is_required_everywhere_but_local(): void
    {
        $this->assertTrue($this->manager->isRequired(), 'testing');

        $this->app->detectEnvironment(fn () => 'production');
        $this->assertTrue($this->manager->isRequired());

        $this->app->detectEnvironment(fn () => 'local');
        $this->assertFalse($this->manager->isRequired());
        $this->assertTrue($this->manager->isVerified($this->freshSession()), 'nothing to verify locally');
    }

    public function test_local_needs_a_loopback_peer_and_no_proxy(): void
    {
        $this->app->detectEnvironment(fn () => 'local');
        $fromHere = Request::create('/setup', server: ['REMOTE_ADDR' => '127.0.0.1']);
        $fromElsewhere = Request::create('/setup', server: ['REMOTE_ADDR' => '203.0.113.9']);
        $proxied = Request::create('/setup', server: ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_FORWARDED_FOR' => '203.0.113.9']);

        $this->assertFalse($this->manager->isRequired($fromHere));
        $this->assertTrue($this->manager->isRequired($fromElsewhere));
        $this->assertTrue($this->manager->isRequired($proxied));
        $this->assertTrue($this->manager->isVerified($this->freshSession(), $fromHere));
        $this->assertFalse($this->manager->isVerified($this->freshSession(), $fromElsewhere));
        $this->assertFalse($this->manager->isMisconfigured($fromHere));

        config(['install.setup_token' => null]);
        $this->assertTrue($this->manager->isMisconfigured($fromElsewhere), 'no token configured and a stranger asking: fail closed');
    }

    public function test_an_unconfigured_token_fails_closed(): void
    {
        foreach ([null, '', '   '] as $value) {
            config(['install.setup_token' => $value]);

            $this->assertTrue($this->manager->isMisconfigured());
            $this->assertFalse($this->manager->verify('anything'));
            $this->assertFalse($this->manager->verify(''));
        }

        $this->app->detectEnvironment(fn () => 'local');
        $this->assertFalse($this->manager->isMisconfigured(), 'local does not need one');
    }

    public function test_verification_is_remembered_per_session_only(): void
    {
        $verified = $this->freshSession();
        $other = $this->freshSession();

        $this->assertFalse($this->manager->isVerified($verified));
        $this->manager->markVerified($verified);

        $this->assertTrue($this->manager->isVerified($verified));
        $this->assertFalse($this->manager->isVerified($other));
    }
}
