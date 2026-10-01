<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Domain\Widgets\Data\WidgetConfigData;
use App\Domain\Widgets\Data\WidgetTexts;
use App\Domain\Widgets\Enums\OfflineMode;
use App\Domain\Widgets\Enums\RoutingStatus;
use App\Domain\Widgets\Enums\ThemeMode;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class WidgetConfigValidatorTest extends TestCase
{
    use RefreshDatabase;

    private WidgetConfigValidator $validator;

    protected function setUp(): void
    {
        parent::setUp();

        $this->validator = app(WidgetConfigValidator::class);
    }

    /**
     * @return array<string, mixed>
     */
    private function defaults(): array
    {
        return (new WidgetConfigData)->toArray();
    }

    /**
     * @return array<string, array<int, string>>
     */
    private function errorsFor(mixed $input): array
    {
        try {
            $this->validator->validate($input);
        } catch (ValidationException $exception) {
            return $exception->errors();
        }

        $this->fail('Expected the config to be rejected.');
    }

    public function test_an_empty_object_yields_the_contract_defaults(): void
    {
        $config = $this->validator->validate([]);

        $this->assertSame($this->defaults(), $config->toArray());
        $this->assertSame(1, $config->v);
        $this->assertSame('#0f766e', $config->theme->primary);
        $this->assertSame(ThemeMode::Auto, $config->theme->mode);
        $this->assertSame(380, $config->theme->panelWidth);
        $this->assertSame(3, $config->greetings->delaySeconds);
        $this->assertSame(30, $config->greetings->intervalMinutes);
        $this->assertSame(180, $config->greetings->autoHideSeconds);
        $this->assertSame(OfflineMode::AutoHours, $config->hours->mode);
        $this->assertSame([RoutingStatus::Online], $config->routing->waves[0]->statuses);
        $this->assertSame(20, $config->routing->waves[1]->afterSeconds);
        $this->assertSame(90, $config->routing->queueTimeoutSeconds);
        $this->assertSame(120, $config->session->idleTimeoutMinutes);
        $this->assertTrue($config->preChat->fields->name->required);
        $this->assertFalse($config->features->whatsapp);
        $this->assertSame(WidgetTexts::ENGLISH, $config->texts['en']);
    }

    public function test_partial_input_is_merged_onto_the_defaults(): void
    {
        $config = $this->validator->validate([
            'theme' => ['primary' => '#112233', 'radius' => 8],
            'features' => ['sounds' => false],
            'texts' => ['en' => ['title' => 'Help'], 'ar' => ['title' => 'مساعدة']],
            'hours' => ['schedule' => [['day' => 2, 'start' => '10:00', 'end' => '14:00']]],
        ]);

        $this->assertSame('#112233', $config->theme->primary);
        $this->assertSame(8, $config->theme->radius);
        $this->assertSame('#ffffff', $config->theme->primaryText, 'untouched fields keep their default');
        $this->assertFalse($config->features->sounds);
        $this->assertTrue($config->features->rating);
        $this->assertSame('Help', $config->texts['en']['title']);
        $this->assertSame(WidgetTexts::ENGLISH['welcome'], $config->texts['en']['welcome'], 'the english block stays complete');
        $this->assertSame(['title' => 'مساعدة'], $config->texts['ar'], 'other locales stay partial');
        $this->assertCount(1, $config->hours->schedule, 'lists replace, they are not merged');
        $this->assertSame(2, $config->hours->schedule[0]->day);
    }

    public function test_empty_locale_blocks_are_dropped(): void
    {
        $config = $this->validator->validate(['texts' => ['fr' => [], 'de' => ['title' => null], 'ar' => ['title' => 'الدعم']]]);

        $this->assertSame(['en', 'ar'], array_keys($config->texts));
        $this->assertSame(['en'], array_keys($this->validator->hydrate(['texts' => ['fr' => []]])->texts));
    }

    public function test_a_validated_config_survives_a_round_trip(): void
    {
        $first = $this->validator->validate([
            'theme' => ['mode' => 'dark', 'position' => 'bottom-left', 'launcherSize' => 'lg'],
            'launcher' => ['style' => 'pill', 'label' => 'Talk to us'],
            'greetings' => ['dismissPolicy' => 'interval'],
            'routing' => ['waves' => [['afterSeconds' => 0, 'statuses' => ['online', 'away']], ['afterSeconds' => 30, 'statuses' => ['offline']]]],
            'hours' => ['holidays' => [['date' => '2026-12-25', 'label' => 'Christmas']]],
        ]);

        $second = $this->validator->validate($first->toArray());

        $this->assertSame($first->toArray(), $second->toArray());
        $this->assertSame($first->toArray(), $this->validator->hydrate($first->toArray())->toArray());
    }

    public function test_unknown_keys_are_rejected_with_their_path(): void
    {
        $errors = $this->errorsFor([
            'colour' => 'red',
            'theme' => ['primary' => '#112233', 'primaryColor' => '#ffffff'],
            'features' => ['telepathy' => true],
            'preChat' => ['fields' => ['name' => ['enabled' => true, 'hidden' => true], 'fax' => ['enabled' => true]]],
            'hours' => ['schedule' => [['day' => 1, 'start' => '09:00', 'end' => '17:00', 'note' => 'x']]],
            'routing' => ['waves' => [['afterSeconds' => 0, 'statuses' => ['online'], 'boost' => 1]]],
            'texts' => ['en' => ['title' => 'Hi', 'headline' => 'No']],
        ]);

        $this->assertSame(['Unknown option.'], $errors['config.colour']);
        $this->assertSame(['Unknown option.'], $errors['config.theme.primaryColor']);
        $this->assertSame(['Unknown option.'], $errors['config.features.telepathy']);
        $this->assertSame(['Unknown option.'], $errors['config.preChat.fields.name.hidden']);
        $this->assertSame(['Unknown option.'], $errors['config.preChat.fields.fax']);
        $this->assertSame(['Unknown option.'], $errors['config.hours.schedule.0.note']);
        $this->assertSame(['Unknown option.'], $errors['config.routing.waves.0.boost']);
        $this->assertSame(['Unknown option.'], $errors['config.texts.en.headline']);
        $this->assertArrayNotHasKey('config.theme.primary', $errors);
    }

    public function test_the_config_must_be_an_object(): void
    {
        $this->assertArrayHasKey('config', $this->errorsFor('nope'));
        $this->assertArrayHasKey('config', $this->errorsFor(null));
        $this->assertNotEmpty($this->errorsFor(['theme' => ['red', 'green']]), 'a list where an object belongs');
        $this->assertNotEmpty($this->errorsFor(['hours' => ['schedule' => ['monday' => ['day' => 1]]]]), 'an object where a list belongs');
    }

    public function test_the_version_must_be_one(): void
    {
        $this->assertArrayHasKey('config.v', $this->errorsFor(['v' => 2]));
        $this->assertSame(1, $this->validator->validate(['v' => 1])->v);
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string}>
     */
    public static function invalidValues(): array
    {
        return [
            'radius above range' => [['theme' => ['radius' => 29]], 'config.theme.radius'],
            'radius below range' => [['theme' => ['radius' => -1]], 'config.theme.radius'],
            'radius as string' => [['theme' => ['radius' => '16']], 'config.theme.radius'],
            'radius as float' => [['theme' => ['radius' => 16.5]], 'config.theme.radius'],
            'panel width too small' => [['theme' => ['panelWidth' => 100]], 'config.theme.panelWidth'],
            'panel height too large' => [['theme' => ['panelHeight' => 5000]], 'config.theme.panelHeight'],
            'offset out of range' => [['theme' => ['offsetX' => 500]], 'config.theme.offsetX'],
            'z-index zero' => [['theme' => ['zIndex' => 0]], 'config.theme.zIndex'],
            'z-index too large' => [['theme' => ['zIndex' => 2147483648]], 'config.theme.zIndex'],
            'unknown theme mode' => [['theme' => ['mode' => 'sepia']], 'config.theme.mode'],
            'unknown position' => [['theme' => ['position' => 'top-left']], 'config.theme.position'],
            'unknown launcher size' => [['theme' => ['launcherSize' => 'xl']], 'config.theme.launcherSize'],
            'unknown shadow' => [['theme' => ['shadow' => 'huge']], 'config.theme.shadow'],
            'colour name' => [['theme' => ['primary' => 'red']], 'config.theme.primary'],
            'colour without hash' => [['theme' => ['primary' => '0f766e']], 'config.theme.primary'],
            'colour two digits' => [['theme' => ['primary' => '#12']], 'config.theme.primary'],
            'colour five digits' => [['theme' => ['primary' => '#12345']], 'config.theme.primary'],
            'colour seven digits' => [['theme' => ['primary' => '#1234567']], 'config.theme.primary'],
            'colour not hex' => [['theme' => ['accent' => '#gggggg']], 'config.theme.accent'],
            'colour with css function' => [['theme' => ['surface' => 'rgb(0,0,0)']], 'config.theme.surface'],
            'colour with trailing newline' => [['theme' => ['text' => "#ffffff\n"]], 'config.theme.text'],
            'font family css injection' => [['theme' => ['fontFamily' => 'Inter; } body { display:none']], 'config.theme.fontFamily'],
            'font family with parentheses' => [['theme' => ['fontFamily' => 'url(x)']], 'config.theme.fontFamily'],
            'font url over http' => [['theme' => ['fontUrl' => 'http://fonts.googleapis.com/css2?family=Inter']], 'config.theme.fontUrl'],
            'font url on another host' => [['theme' => ['fontUrl' => 'https://evil.example/x.css']], 'config.theme.fontUrl'],
            'font url protocol relative' => [['theme' => ['fontUrl' => '//fonts.googleapis.com/css2']], 'config.theme.fontUrl'],
            'font url with userinfo' => [['theme' => ['fontUrl' => 'https://fonts.googleapis.com@evil.example/x.css']], 'config.theme.fontUrl'],
            'launcher icon url javascript' => [['launcher' => ['iconUrl' => 'javascript:alert(1)']], 'config.launcher.iconUrl'],
            'launcher icon url data uri' => [['launcher' => ['iconUrl' => 'data:image/svg+xml;base64,AAAA']], 'config.launcher.iconUrl'],
            'launcher icon url http' => [['launcher' => ['iconUrl' => 'http://example.com/a.png']], 'config.launcher.iconUrl'],
            'launcher avatar protocol relative' => [['launcher' => ['avatarUrl' => '//evil.example/a.png']], 'config.launcher.avatarUrl'],
            'launcher avatar backslash' => [['launcher' => ['avatarUrl' => '/\\evil.example/a.png']], 'config.launcher.avatarUrl'],
            'launcher label too long' => [['launcher' => ['label' => str_repeat('x', 41)]], 'config.launcher.label'],
            'launcher style unknown' => [['launcher' => ['style' => 'square']], 'config.launcher.style'],
            'custom icon without url' => [['launcher' => ['icon' => 'custom']], 'config.launcher.iconUrl'],
            'greeting delay too long' => [['greetings' => ['delaySeconds' => 601]], 'config.greetings.delaySeconds'],
            'greeting interval zero' => [['greetings' => ['intervalMinutes' => 0]], 'config.greetings.intervalMinutes'],
            'greeting auto hide too short' => [['greetings' => ['autoHideSeconds' => 1]], 'config.greetings.autoHideSeconds'],
            'greeting dismiss policy' => [['greetings' => ['dismissPolicy' => 'forever']], 'config.greetings.dismissPolicy'],
            'feature as string' => [['features' => ['sounds' => 'yes']], 'config.features.sounds'],
            'feature as integer' => [['features' => ['rating' => 1]], 'config.features.rating'],
            'required field disabled' => [['preChat' => ['fields' => ['email' => ['enabled' => false, 'required' => true]]]], 'config.preChat.fields.email.enabled'],
            'consent text too long' => [['preChat' => ['consentText' => str_repeat('x', 501)]], 'config.preChat.consentText'],
            'invalid timezone' => [['hours' => ['timezone' => 'Mars/Olympus']], 'config.hours.timezone'],
            'invalid hours mode' => [['hours' => ['mode' => 'sometimes']], 'config.hours.mode'],
            'schedule day out of range' => [['hours' => ['schedule' => [['day' => 7, 'start' => '09:00', 'end' => '17:00']]]], 'config.hours.schedule.0.day'],
            'schedule bad clock' => [['hours' => ['schedule' => [['day' => 1, 'start' => '9:00', 'end' => '17:00']]]], 'config.hours.schedule.0.start'],
            'schedule hour 24 start' => [['hours' => ['schedule' => [['day' => 1, 'start' => '24:00', 'end' => '24:00']]]], 'config.hours.schedule.0.start'],
            'schedule minute 60' => [['hours' => ['schedule' => [['day' => 1, 'start' => '09:00', 'end' => '17:60']]]], 'config.hours.schedule.0.end'],
            'schedule ends before it starts' => [['hours' => ['schedule' => [['day' => 1, 'start' => '17:00', 'end' => '09:00']]]], 'config.hours.schedule.0.end'],
            'schedule empty range' => [['hours' => ['schedule' => [['day' => 1, 'start' => '09:00', 'end' => '09:00']]]], 'config.hours.schedule.0.end'],
            'schedule overlap' => [['hours' => ['schedule' => [['day' => 1, 'start' => '09:00', 'end' => '12:00'], ['day' => 1, 'start' => '11:00', 'end' => '15:00']]]], 'config.hours.schedule.1.start'],
            'schedule missing field' => [['hours' => ['schedule' => [['day' => 1, 'start' => '09:00']]]], 'config.hours.schedule.0.end'],
            'holiday not a date' => [['hours' => ['holidays' => [['date' => '25/12/2026']]]], 'config.hours.holidays.0.date'],
            'holiday impossible date' => [['hours' => ['holidays' => [['date' => '2026-02-30']]]], 'config.hours.holidays.0.date'],
            'holiday duplicated' => [['hours' => ['holidays' => [['date' => '2026-12-25'], ['date' => '2026-12-25']]]], 'config.hours.holidays.0.date'],
            'holiday label too long' => [['hours' => ['holidays' => [['date' => '2026-12-25', 'label' => str_repeat('x', 81)]]]], 'config.hours.holidays.0.label'],
            'no routing waves' => [['routing' => ['waves' => []]], 'config.routing.waves'],
            'too many routing waves' => [['routing' => ['waves' => array_map(fn (int $i): array => ['afterSeconds' => $i * 10, 'statuses' => ['online']], range(0, 5))]], 'config.routing.waves'],
            'wave statuses empty' => [['routing' => ['waves' => [['afterSeconds' => 0, 'statuses' => []]]]], 'config.routing.waves.0.statuses'],
            'wave status unknown' => [['routing' => ['waves' => [['afterSeconds' => 0, 'statuses' => ['busy']]]]], 'config.routing.waves.0.statuses.0'],
            'waves not ascending' => [['routing' => ['waves' => [['afterSeconds' => 20, 'statuses' => ['online']], ['afterSeconds' => 20, 'statuses' => ['away']]]]], 'config.routing.waves.1.afterSeconds'],
            'queue timeout too short' => [['routing' => ['queueTimeoutSeconds' => 14]], 'config.routing.queueTimeoutSeconds'],
            'queue timeout too long' => [['routing' => ['queueTimeoutSeconds' => 601]], 'config.routing.queueTimeoutSeconds'],
            'idle timeout too short' => [['session' => ['idleTimeoutMinutes' => 4]], 'config.session.idleTimeoutMinutes'],
            'idle timeout too long' => [['session' => ['idleTimeoutMinutes' => 10081]], 'config.session.idleTimeoutMinutes'],
            'default locale invalid' => [['defaultLocale' => 'english please'], 'config.defaultLocale'],
            'default locale longer than the column' => [['defaultLocale' => 'zh-Hant-12345'], 'config.defaultLocale'],
            'default locale at the longest shape' => [['defaultLocale' => 'abc-abcdefgh-abcdefgh'], 'config.defaultLocale'],
            'text locale key invalid' => [['texts' => ['<x>' => ['title' => 'Hi']]], 'config.texts.<x>'],
            'text locale key longer than the column' => [['texts' => ['zh-Hant-12345' => ['title' => 'Hi']]], 'config.texts.zh-Hant-12345'],
            'text value too long' => [['texts' => ['en' => ['title' => str_repeat('x', 501)]]], 'config.texts.en.title'],
            'text value not a string' => [['texts' => ['en' => ['title' => 5]]], 'config.texts.en.title'],
            'text block as list' => [['texts' => ['en' => ['Hi', 'There']]], 'config.texts.en'],
        ];
    }

    /**
     * @param  array<string, mixed>  $input
     */
    #[DataProvider('invalidValues')]
    public function test_invalid_values_are_rejected_with_a_field_error(array $input, string $field): void
    {
        $errors = $this->errorsFor($input);

        $this->assertArrayHasKey($field, $errors, 'got errors for: '.implode(', ', array_keys($errors)));
    }

    /**
     * @return array<string, array{0: array<string, mixed>}>
     */
    public static function validEdgeValues(): array
    {
        return [
            'three digit colour' => [['theme' => ['primary' => '#fff']]],
            'eight digit colour' => [['theme' => ['primary' => '#0f766eCC']]],
            'upper case colour' => [['theme' => ['primary' => '#ABCDEF']]],
            'radius bounds' => [['theme' => ['radius' => 0]]],
            'radius upper bound' => [['theme' => ['radius' => 28]]],
            'z-index maximum' => [['theme' => ['zIndex' => 2147483647]]],
            'font url on google fonts' => [['theme' => ['fontUrl' => 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap']]],
            'font url on bunny fonts' => [['theme' => ['fontUrl' => 'https://fonts.bunny.net/css?family=inter']]],
            'font url on the app itself' => [['theme' => ['fontUrl' => '/fonts/brand.css']]],
            'quoted multi word font family' => [['theme' => ['fontFamily' => '"Open Sans", \'Segoe UI\', sans-serif']]],
            'unicode font family' => [['theme' => ['fontFamily' => 'Noto Sans Arabic, Tahoma']]],
            'https icon url' => [['launcher' => ['icon' => 'custom', 'iconUrl' => 'https://cdn.example.com/chat.svg']]],
            'relative avatar url' => [['launcher' => ['avatarUrl' => '/img/avatar.png']]],
            'schedule to midnight' => [['hours' => ['schedule' => [['day' => 5, 'start' => '18:00', 'end' => '24:00']]]]],
            'two ranges one day' => [['hours' => ['schedule' => [['day' => 1, 'start' => '09:00', 'end' => '12:00'], ['day' => 1, 'start' => '12:00', 'end' => '15:00']]]]],
            'empty schedule' => [['hours' => ['schedule' => []]]],
            'leap day holiday' => [['hours' => ['holidays' => [['date' => '2028-02-29']]]]],
            'region locale text block' => [['texts' => ['pt-BR' => ['title' => 'Ajuda']]]],
            'default locale at the column width' => [['defaultLocale' => 'zh-Hant-1234']],
            'text locale key at the column width' => [['texts' => ['zh-Hant-1234' => ['title' => 'Hi']]]],
            'loader accessibility texts' => [['texts' => ['ar' => ['closeChat' => 'إغلاق', 'unread' => 'رسائل غير مقروءة', 'dismiss' => 'تجاهل']]]],
            'holiday without a name' => [['hours' => ['holidays' => [['date' => '2026-12-25', 'label' => null]]]]],
            'always offline with named timezone' => [['hours' => ['mode' => 'always_offline', 'timezone' => 'Asia/Riyadh']]],
            'legacy timezone name (accepted by the widget settings too)' => [['hours' => ['timezone' => 'Asia/Calcutta']]],
            'legacy timezone alias' => [['hours' => ['timezone' => 'US/Pacific']]],
        ];
    }

    /**
     * @param  array<string, mixed>  $input
     */
    #[DataProvider('validEdgeValues')]
    public function test_boundary_values_that_are_allowed(array $input): void
    {
        $this->assertInstanceOf(WidgetConfigData::class, $this->validator->validate($input));
    }

    public function test_null_means_use_the_default_for_fields_that_have_one(): void
    {
        $config = $this->validator->validate([
            'launcher' => ['label' => null, 'iconUrl' => null],
            'texts' => ['en' => ['title' => null]],
            'theme' => ['primary' => null],
        ]);

        $this->assertSame('Chat with us', $config->launcher->label);
        $this->assertNull($config->launcher->iconUrl);
        $this->assertSame(WidgetTexts::ENGLISH['title'], $config->texts['en']['title']);
        $this->assertSame('#0f766e', $config->theme->primary);
    }

    public function test_the_error_prefix_follows_the_request_field(): void
    {
        try {
            $this->validator->validate(['theme' => ['radius' => 99]], 'draft');
            $this->fail('Expected a validation error.');
        } catch (ValidationException $exception) {
            $this->assertArrayHasKey('draft.theme.radius', $exception->errors());
        }
    }

    public function test_hydrating_stored_json_is_lenient(): void
    {
        $config = $this->validator->hydrate(['theme' => ['primary' => '#112233', 'legacyOption' => true], 'obsolete' => 1]);

        $this->assertSame('#112233', $config->theme->primary);
        $this->assertSame('Inter, system-ui, sans-serif', $config->theme->fontFamily);
        $this->assertSame($this->defaults()['routing'], $config->routing->toArray());
    }

    public function test_hydrating_garbage_falls_back_to_the_defaults(): void
    {
        $config = $this->validator->hydrate(['theme' => 'not an object', 'hours' => ['schedule' => 5]]);

        $this->assertSame($this->defaults(), $config->toArray());
        $this->assertSame($this->defaults(), $this->validator->hydrate(null)->toArray());
    }

    public function test_a_holiday_always_has_a_string_label(): void
    {
        $config = $this->validator->validate(['hours' => ['holidays' => [
            ['date' => '2026-12-25', 'label' => null],
            ['date' => '2026-12-26'],
            ['date' => '2026-12-27', 'label' => 'Boxing weekend'],
        ]]]);

        $this->assertSame(['', '', 'Boxing weekend'], array_map(fn ($holiday): string => $holiday->label, $config->hours->holidays));
        $this->assertSame('', $config->toArray()['hours']['holidays'][0]['label'], 'the JSON shape carries "", never null');

        // Stored JSON from before this rule (label: null) hydrates to the same shape.
        $stored = $this->validator->hydrate(['hours' => ['holidays' => [['date' => '2026-12-25', 'label' => null], ['date' => '2026-12-26']]]]);
        $this->assertSame(['', ''], array_map(fn ($holiday): string => $holiday->label, $stored->hours->holidays));
    }

    public function test_the_loaders_accessibility_texts_have_english_defaults_and_can_be_translated(): void
    {
        $this->assertSame('Close chat', WidgetTexts::ENGLISH['closeChat']);
        $this->assertSame('unread messages', WidgetTexts::ENGLISH['unread']);
        $this->assertSame('Dismiss', WidgetTexts::ENGLISH['dismiss']);
        $this->assertSame(WidgetTexts::ENGLISH, $this->validator->validate([])->texts['en']);

        $config = $this->validator->validate(['texts' => ['ar' => ['closeChat' => 'إغلاق']]]);
        $this->assertSame(['closeChat' => 'إغلاق'], $config->texts['ar']);

        $this->assertArrayHasKey('config.texts.ar.close', $this->errorsFor(['texts' => ['ar' => ['close' => 'x']]]), 'only the known keys');
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string, 2: string}>
     */
    public static function readableMessages(): array
    {
        return [
            'range' => [['theme' => ['panelHeight' => 5000]], 'config.theme.panelHeight', 'The panel height field must be between 360 and 900.'],
            'integer' => [['theme' => ['radius' => '16']], 'config.theme.radius', 'The corner radius field must be an integer.'],
            'colour' => [['theme' => ['primary' => 'red']], 'config.theme.primary', 'The primary colour must be a hex colour such as #0f766e (3, 6 or 8 digits).'],
            'text colour' => [['theme' => ['text' => 'red']], 'config.theme.text', 'The text colour must be a hex colour such as #0f766e (3, 6 or 8 digits).'],
            'enum' => [['theme' => ['mode' => 'sepia']], 'config.theme.mode', 'The selected colour mode is invalid.'],
            'feature flag' => [['features' => ['sounds' => 'yes']], 'config.features.sounds', 'The sounds option field must be true or false.'],
            'greeting delay' => [['greetings' => ['delaySeconds' => 601]], 'config.greetings.delaySeconds', 'The greeting delay field must be between 0 and 600.'],
            'opening time' => [['hours' => ['schedule' => [['day' => 1, 'start' => '9:00', 'end' => '17:00']]]], 'config.hours.schedule.0.start', 'The opening time must be a time such as 09:00 (24-hour clock).'],
            'closing time' => [['hours' => ['schedule' => [['day' => 1, 'start' => '09:00', 'end' => '25:00']]]], 'config.hours.schedule.0.end', 'The closing time must be a time such as 17:00 (24-hour clock; 24:00 is allowed).'],
            'day' => [['hours' => ['schedule' => [['day' => 9, 'start' => '09:00', 'end' => '17:00']]]], 'config.hours.schedule.0.day', 'The day of the week field must be between 0 and 6.'],
            'holiday date' => [['hours' => ['holidays' => [['date' => '25/12/2026']]]], 'config.hours.holidays.0.date', 'The holiday date must be a date written as YYYY-MM-DD.'],
            'holiday duplicate' => [['hours' => ['holidays' => [['date' => '2026-12-25'], ['date' => '2026-12-25']]]], 'config.hours.holidays.0.date', 'The holiday date is listed twice.'],
            'timezone' => [['hours' => ['timezone' => 'Mars/Olympus']], 'config.hours.timezone', 'The timezone field must be a valid timezone.'],
            'default language' => [['defaultLocale' => 'english please'], 'config.defaultLocale', 'The default language must be a language code such as "en" or "pt-BR".'],
            'text length' => [['texts' => ['en' => ['welcome' => str_repeat('x', 501)]]], 'config.texts.en.welcome', 'The welcome text field must not be greater than 500 characters.'],
            'prompt text' => [['texts' => ['en' => ['categoryPrompt' => 5]]], 'config.texts.en.categoryPrompt', 'The category prompt text field must be a string.'],
            'wave time' => [['routing' => ['waves' => [['afterSeconds' => 601, 'statuses' => ['online']]]]], 'config.routing.waves.0.afterSeconds', 'The wave start time field must be between 0 and 600.'],
            'queue timeout' => [['routing' => ['queueTimeoutSeconds' => 14]], 'config.routing.queueTimeoutSeconds', 'The queue timeout field must be between 15 and 600.'],
            'idle timeout' => [['session' => ['idleTimeoutMinutes' => 4]], 'config.session.idleTimeoutMinutes', 'The idle timeout field must be between 5 and 10080.'],
            'consent text' => [['preChat' => ['consentText' => str_repeat('x', 501)]], 'config.preChat.consentText', 'The consent text field must not be greater than 500 characters.'],
            'prechat field' => [['preChat' => ['fields' => ['email' => ['enabled' => 'yes']]]], 'config.preChat.fields.email.enabled', 'The email field visibility field must be true or false.'],
        ];
    }

    /**
     * Messages name fields the way the builder does; the error KEYS stay the dotted config paths.
     *
     * @param  array<string, mixed>  $input
     */
    #[DataProvider('readableMessages')]
    public function test_error_messages_use_human_field_names_while_keys_stay_dotted_paths(array $input, string $key, string $message): void
    {
        $errors = $this->errorsFor($input);

        $this->assertArrayHasKey($key, $errors);
        $this->assertContains($message, $errors[$key]);

        foreach ($errors[$key] as $text) {
            $this->assertStringNotContainsString('config.', $text, 'no dotted path inside a message');
        }
    }
}
