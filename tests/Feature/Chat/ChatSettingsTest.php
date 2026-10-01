<?php

namespace Tests\Feature\Chat;

use App\Domain\Settings\SettingGroup;
use App\Domain\Settings\SettingType;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * The live-chat settings P4 adds (group Chat): their defaults and the ranges they are validated against.
 */
class ChatSettingsTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return iterable<string, array{string, int, int, int}>
     */
    public static function settingsWithRanges(): iterable
    {
        yield 'rating window (minutes)' => ['chat.rating_window_minutes', 10, 1, 1440];
        yield 'attachment size (bytes)' => ['chat.attachment_max_bytes', 5 * 1024 * 1024, 10_240, 26_214_400];
        yield 'attachment dimension (pixels)' => ['chat.attachment_max_dimension', 4096, 256, 8192];
        yield 'visitor session (days)' => ['chat.visitor_session_ttl_days', 30, 1, 365];
        yield 'offer wave delay (seconds)' => ['chat.offer_wave_delay_seconds', 20, 0, 300];
        yield 'message length (characters)' => ['chat.max_message_length', 4000, 100, 20_000];
    }

    #[DataProvider('settingsWithRanges')]
    public function test_the_setting_has_its_documented_default_and_type(string $key, int $default, int $min, int $max): void
    {
        $definition = settings()->registry()->require($key);

        $this->assertSame(SettingGroup::Chat, $definition->group);
        $this->assertSame(SettingType::Int, $definition->type);
        $this->assertSame($default, $definition->defaultValue());
        $this->assertSame($default, settings($key));
        $this->assertTrue($definition->seed, 'a fresh install writes it');
    }

    #[DataProvider('settingsWithRanges')]
    public function test_the_setting_accepts_its_range_and_refuses_outside_it(string $key, int $default, int $min, int $max): void
    {
        settings()->set($key, $min);
        $this->assertSame($min, settings()->int($key));

        settings()->set($key, $max);
        $this->assertSame($max, settings()->int($key));

        foreach ([$min - 1, $max + 1, 'many'] as $invalid) {
            try {
                settings()->set($key, $invalid);
                $this->fail("{$key} accepted ".json_encode($invalid));
            } catch (ValidationException $exception) {
                $this->assertArrayHasKey($key, $exception->errors());
            }
        }

        $this->assertSame($max, settings()->int($key), 'a refused value changes nothing');
    }

    public function test_the_previous_chat_setting_is_unchanged(): void
    {
        $this->assertSame(120, settings('chat.default_idle_timeout_minutes'));
    }
}
