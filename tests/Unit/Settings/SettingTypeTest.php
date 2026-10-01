<?php

namespace Tests\Unit\Settings;

use App\Domain\Settings\SettingType;
use PHPUnit\Framework\TestCase;

class SettingTypeTest extends TestCase
{
    public function test_values_are_cast_to_their_declared_type(): void
    {
        $this->assertTrue(SettingType::Bool->cast('true'));
        $this->assertTrue(SettingType::Bool->cast(1));
        $this->assertFalse(SettingType::Bool->cast('false'));
        $this->assertFalse(SettingType::Bool->cast(0));
        $this->assertSame(45, SettingType::Int->cast('45'));
        $this->assertSame('7', SettingType::String->cast(7));
        $this->assertSame(['a' => 1], SettingType::Json->cast(['a' => 1]));
        $this->assertNull(SettingType::String->cast(null));
    }

    public function test_non_numeric_values_are_left_for_validation_to_reject(): void
    {
        $this->assertSame('abc', SettingType::Int->cast('abc'));
        $this->assertSame(['x'], SettingType::String->cast(['x']));
    }

    public function test_values_are_encoded_as_unescaped_json(): void
    {
        $this->assertSame('"https://a.test/ü"', SettingType::String->encode('https://a.test/ü'));
        $this->assertSame('true', SettingType::Bool->encode(true));
        $this->assertSame('120', SettingType::Int->encode(120));
    }
}
