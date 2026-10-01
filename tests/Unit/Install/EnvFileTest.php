<?php

namespace Tests\Unit\Install;

use App\Domain\Install\Support\EnvFile;
use PHPUnit\Framework\TestCase;

class EnvFileTest extends TestCase
{
    private string $path;

    protected function setUp(): void
    {
        parent::setUp();

        $this->path = sys_get_temp_dir().'/envfile-'.uniqid().'.env';
    }

    protected function tearDown(): void
    {
        @unlink($this->path);

        parent::tearDown();
    }

    public function test_it_reads_active_keys_and_ignores_comments(): void
    {
        file_put_contents($this->path, "# APP_KEY=commented\nAPP_NAME=\"PNE Chat\"\nEMPTY=\nQUOTED='single'\n");
        $env = new EnvFile($this->path);

        $this->assertNull($env->get('APP_KEY'));
        $this->assertSame('PNE Chat', $env->get('APP_NAME'));
        $this->assertSame('', $env->get('EMPTY'));
        $this->assertSame('single', $env->get('QUOTED'));
        $this->assertTrue($env->has('APP_NAME'));
        $this->assertFalse($env->has('EMPTY'));
        $this->assertFalse($env->has('MISSING'));
    }

    public function test_it_replaces_existing_lines_in_place_and_appends_new_keys(): void
    {
        file_put_contents($this->path, "A=1\nAPP_KEY=\nB=2");
        $env = new EnvFile($this->path);

        $env->set(['APP_KEY' => 'base64:abc=', 'NEW' => 'value with space']);

        $this->assertSame("A=1\nAPP_KEY=base64:abc=\nB=2\nNEW=\"value with space\"\n", (string) file_get_contents($this->path));
    }

    public function test_it_keeps_the_file_mode_and_leaves_no_temp_files(): void
    {
        file_put_contents($this->path, "A=1\n");
        chmod($this->path, 0640);

        (new EnvFile($this->path))->set(['B' => '2']);

        $this->assertSame('0640', substr(sprintf('%o', fileperms($this->path)), -4));
        $this->assertSame([], glob($this->path.'.tmp*'));
    }

    public function test_it_creates_a_missing_file_with_private_permissions(): void
    {
        (new EnvFile($this->path))->set(['A' => '1']);

        $this->assertSame("A=1\n", (string) file_get_contents($this->path));
        $this->assertSame('0600', substr(sprintf('%o', fileperms($this->path)), -4));
    }
}
