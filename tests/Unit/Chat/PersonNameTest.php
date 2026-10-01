<?php

namespace Tests\Unit\Chat;

use App\Support\PersonName;
use Tests\TestCase;

class PersonNameTest extends TestCase
{
    public function test_an_address_becomes_a_readable_name(): void
    {
        $this->assertSame('Ann', PersonName::fromEmail('ann@example.test'));
        $this->assertSame('Ann Smith', PersonName::fromEmail('ann.smith@example.test'));
        $this->assertSame('Ann Smith', PersonName::fromEmail('ANN_smith+sales@example.test'));
        $this->assertSame('José García', PersonName::fromEmail('josé-garcía@example.test'));
        $this->assertSame('Agent', PersonName::fromEmail('+@example.test'));
        $this->assertSame('Agent', PersonName::fromEmail(''));
    }

    public function test_a_visitor_facing_name_is_never_an_address(): void
    {
        $this->assertSame('Sam', PersonName::visitorFacing(['Sam', 'Samuel Jones'], 'sam@example.test'));
        $this->assertSame('Samuel Jones', PersonName::visitorFacing([null, ' ', 'Samuel Jones'], 'sam@example.test'));
        // Every candidate is empty or an address: the first address wins, else the account address.
        $this->assertSame('Sam Jones', PersonName::visitorFacing(['sam.jones@example.test', 'other@example.test']));
        $this->assertSame('Sam Jones', PersonName::visitorFacing(['sam.jones@example.test'], 'other@example.test'));
        $this->assertSame('Other', PersonName::visitorFacing([null, ''], 'other@example.test'));
        $this->assertSame('Agent', PersonName::visitorFacing([null]));
    }
}
