<?php

namespace Tests\Feature\Visitors;

use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `visitors.external_id` belongs to the host website: `John` and `john`, `josé` and `jose` are different people. Under MySQL's default
 * (case- and accent-insensitive) collation they would be ONE visitor and one chat, so the column is binary (see the migration).
 * SQLite cannot show this, so the test is opt-in like the other MySQL tests:
 *
 *   CHAT_RACE_TEST=1 DB_CONNECTION=mysql DB_DATABASE=<a dedicated, freshly migrated database> php artisan test tests/Feature/Visitors/VisitorExternalIdMySqlTest.php
 *
 * It commits real rows (through the public API) and deletes the widget afterwards.
 */
class VisitorExternalIdMySqlTest extends TestCase
{
    use ChatFixtures;

    private ?Widget $widget = null;

    protected function setUp(): void
    {
        parent::setUp();

        if (getenv('CHAT_RACE_TEST') !== '1') {
            $this->markTestSkipped('Set CHAT_RACE_TEST=1 (and DB_CONNECTION=mysql, DB_DATABASE=<dedicated database>) to run the MySQL collation test.');
        }

        if (! in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
            $this->markTestSkipped('The collation test needs MySQL / MariaDB.');
        }

        if (in_array(DB::connection()->getDatabaseName(), ['chatfeature', 'chatfeature_testing', ''], true)) {
            $this->markTestSkipped('Refusing to commit test rows into the development database; point DB_DATABASE at a dedicated one.');
        }
    }

    protected function tearDown(): void
    {
        if ($this->widget !== null) {
            Widget::withTrashed()->whereKey($this->widget->id)->forceDelete();
        }

        parent::tearDown();
    }

    public function test_host_identities_that_differ_only_in_case_or_accents_are_different_visitors(): void
    {
        $widget = $this->widget = Widget::factory()->enabled()->withDomains(['customer.test'])->withIdentitySecret('s3cret-s3cret')->create(['offline_mode' => 'always_online']);

        $subjects = ['John', 'john', 'JOHN', 'josé', 'jose', 'Jose', 'trailing', 'trailing '];

        foreach ($subjects as $subject) {
            $token = $this->mintIdentityToken(['iss' => $widget->public_key, 'sub' => $subject, 'exp' => time() + 120], 's3cret-s3cret');
            $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])
                ->postJson('/api/v1/public/widgets/'.$widget->public_key.'/sessions', ['identity_token' => $token])
                ->assertCreated();
        }

        $stored = Visitor::query()->where('widget_id', $widget->id)->pluck('external_id')->all();
        sort($stored);
        $expected = $subjects;
        sort($expected);
        $this->assertSame($expected, $stored, 'every distinct host id is its own visitor');

        // The same id again is the same visitor (the unique index still holds).
        $token = $this->mintIdentityToken(['iss' => $widget->public_key, 'sub' => 'John', 'exp' => time() + 120], 's3cret-s3cret');
        $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->postJson('/api/v1/public/widgets/'.$widget->public_key.'/sessions', ['identity_token' => $token])->assertCreated();
        $this->assertSame(count($subjects), Visitor::query()->where('widget_id', $widget->id)->count());
    }
}
