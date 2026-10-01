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
            'text locale key invalid' => [['texts' => ['<x>' => ['title' => 'Hi']]], 'config.texts.<x>'],
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
            'always offline with named timezone' => [['hours' => ['mode' => 'always_offline', 'timezone' => 'Asia/Riyadh']]],
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
}
