<?php

namespace App\Domain\Widgets\Config;

use App\Domain\Widgets\Data\WidgetConfigData;
use App\Domain\Widgets\Data\WidgetTexts;
use App\Domain\Widgets\Enums\DismissPolicy;
use App\Domain\Widgets\Enums\LauncherIcon;
use App\Domain\Widgets\Enums\LauncherSize;
use App\Domain\Widgets\Enums\LauncherStyle;
use App\Domain\Widgets\Enums\OfflineMode;
use App\Domain\Widgets\Enums\PanelPosition;
use App\Domain\Widgets\Enums\RoutingStatus;
use App\Domain\Widgets\Enums\ShadowLevel;
use App\Domain\Widgets\Enums\ThemeMode;
use App\Domain\Widgets\Rules\SafeAssetUrl;
use App\Domain\Widgets\Support\AppOrigin;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Illuminate\Validation\Validator as ValidatorInstance;
use Throwable;

/**
 * Strict validation of the widget config (docs/contracts/widget-config.md).
 *
 * - unknown keys are rejected with a field-level error (`config.theme.colour`: "Unknown option.");
 * - scalar types are exact (`"16"` is not an integer), colours are 3/6/8-digit hex, URLs are https or relative,
 *   numbers outside their range are rejected with a field error (never silently clamped);
 * - everything missing is filled from the contract's defaults, so the result is always complete;
 * - `null` for a field that has a non-null default means "use the default" (an emptied text input falls back).
 *
 * The rule table is the single source of the schema: the set of allowed keys is derived from it.
 */
final class WidgetConfigValidator
{
    /** BCP 47-ish language tag: `en`, `ar`, `pt-BR`, `zh-Hant-TW`. */
    private const LOCALE = '/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/D';

    private const HEX = '/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/D';

    private const CLOCK = '/^(?:[01]\d|2[0-3]):[0-5]\d$/D';

    private const CLOCK_END = '/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/D';

    /** Letters, digits, spaces and the punctuation of a CSS font stack; no `;{}()<>:\` that could break out of a declaration. */
    private const FONT_FAMILY = '/^[\p{L}\p{N} ,\'"._-]+$/uD';

    private const MAX_LOCALES = 20;

    /** Keys whose value is a list, not an object. */
    private const LISTS = ['hours.schedule', 'hours.holidays', 'routing.waves', 'routing.waves.*.statuses'];

    /** @var array<string, list<string>>|null */
    private ?array $children = null;

    public function __construct(private readonly AppOrigin $appOrigin) {}

    /**
     * Validate request input and return the complete, normalised config.
     *
     * @param  string  $field  Prefix of the error keys (the request body key that holds the config).
     *
     * @throws ValidationException
     */
    public function validate(mixed $input, string $field = 'config'): WidgetConfigData
    {
        $defaults = (new WidgetConfigData)->toArray();
        $input = is_array($input) ? $this->stripNulls($input, $defaults) : $input;

        $validator = Validator::make(
            [$field => $input],
            $this->prefixed($this->rules(), $field),
            [],
            [],
        );

        $merged = [];

        $validator->after(function (ValidatorInstance $validator) use ($field, $input, $defaults, &$merged): void {
            if (! is_array($input)) {
                return;
            }

            $unknown = [];
            $this->walk($input, '', $field, $unknown);

            foreach ($unknown as $path => $message) {
                $validator->errors()->add($path, $message);
            }

            if ($validator->errors()->isNotEmpty()) {
                return;
            }

            $merged = $this->withoutEmptyTextBlocks($this->merge($defaults, $input));

            foreach ($this->crossFieldErrors($merged, $field) as $path => $message) {
                $validator->errors()->add($path, $message);
            }
        });

        if ($validator->fails()) {
            throw new ValidationException($validator);
        }

        return WidgetConfigData::from($merged);
    }

    /**
     * Build the config object from JSON we stored ourselves: lenient (unknown keys are ignored), defaults filled.
     * A document that cannot be read at all falls back to the defaults rather than taking the widget down.
     *
     * @param  array<string, mixed>|null  $stored
     */
    public function hydrate(?array $stored): WidgetConfigData
    {
        $defaults = (new WidgetConfigData)->toArray();

        try {
            return WidgetConfigData::from($this->withoutEmptyTextBlocks($this->merge($defaults, $this->stripNulls($stored ?? [], $defaults))));
        } catch (Throwable $exception) {
            report($exception);

            return new WidgetConfigData;
        }
    }

    /**
     * @return array<string, list<mixed>>
     */
    private function rules(): array
    {
        $hex = ['string', 'regex:'.self::HEX];
        $asset = ['nullable', new SafeAssetUrl];
        $fontHosts = ['fonts.googleapis.com', 'fonts.bunny.net', $this->appOrigin->host()];
        $flag = ['boolean:strict'];
        $locale = ['string', 'regex:'.self::LOCALE];

        $rules = [
            'v' => ['integer:strict', 'in:1'],
            'defaultLocale' => $locale,
            'localeDetect' => $flag,

            'theme' => ['array'],
            'theme.mode' => [Rule::enum(ThemeMode::class)],
            'theme.primary' => $hex,
            'theme.primaryText' => $hex,
            'theme.accent' => $hex,
            'theme.surface' => $hex,
            'theme.text' => $hex,
            'theme.fontFamily' => ['string', 'max:200', 'regex:'.self::FONT_FAMILY],
            'theme.fontUrl' => ['nullable', new SafeAssetUrl($fontHosts)],
            'theme.radius' => ['integer:strict', 'between:0,28'],
            'theme.shadow' => [Rule::enum(ShadowLevel::class)],
            'theme.launcherSize' => [Rule::enum(LauncherSize::class)],
            'theme.panelWidth' => ['integer:strict', 'between:280,600'],
            'theme.panelHeight' => ['integer:strict', 'between:360,900'],
            'theme.position' => [Rule::enum(PanelPosition::class)],
            'theme.offsetX' => ['integer:strict', 'between:0,200'],
            'theme.offsetY' => ['integer:strict', 'between:0,200'],
            'theme.zIndex' => ['integer:strict', 'between:1,2147483647'],

            'launcher' => ['array'],
            'launcher.style' => [Rule::enum(LauncherStyle::class)],
            'launcher.icon' => [Rule::enum(LauncherIcon::class)],
            'launcher.iconUrl' => $asset,
            'launcher.label' => ['string', 'max:40'],
            'launcher.avatarUrl' => $asset,

            'texts' => ['array', 'max:'.self::MAX_LOCALES],
            'texts.*' => ['array'],

            'features' => ['array'],
            'preChat' => ['array'],
            'preChat.fields' => ['array'],
            'preChat.consentText' => ['nullable', 'string', 'max:500'],

            'greetings' => ['array'],
            'greetings.enabled' => $flag,
            'greetings.onPageLoad' => $flag,
            'greetings.delaySeconds' => ['integer:strict', 'between:0,600'],
            'greetings.intervalMinutes' => ['integer:strict', 'between:1,1440'],
            'greetings.autoHideSeconds' => ['integer:strict', 'between:3,3600'],
            'greetings.dismissPolicy' => [Rule::enum(DismissPolicy::class)],
            'greetings.showAgent' => $flag,

            'hours' => ['array'],
            'hours.mode' => [Rule::enum(OfflineMode::class)],
            'hours.timezone' => ['string', 'timezone:all'],
            'hours.schedule' => ['array', 'max:42'],
            'hours.schedule.*' => ['array'],
            'hours.schedule.*.day' => ['required', 'integer:strict', 'between:0,6'],
            'hours.schedule.*.start' => ['required', 'string', 'regex:'.self::CLOCK],
            'hours.schedule.*.end' => ['required', 'string', 'regex:'.self::CLOCK_END],
            'hours.holidays' => ['array', 'max:400'],
            'hours.holidays.*' => ['array'],
            'hours.holidays.*.date' => ['required', 'string', 'date_format:Y-m-d', 'distinct'],
            'hours.holidays.*.label' => ['nullable', 'string', 'max:80'],

            'routing' => ['array'],
            'routing.waves' => ['array', 'min:1', 'max:5'],
            'routing.waves.*' => ['array'],
            'routing.waves.*.afterSeconds' => ['required', 'integer:strict', 'between:0,600'],
            'routing.waves.*.statuses' => ['required', 'array', 'min:1', 'max:3'],
            'routing.waves.*.statuses.*' => [Rule::enum(RoutingStatus::class), 'distinct'],
            'routing.wakeOfflineViaPush' => $flag,
            'routing.queueTimeoutSeconds' => ['integer:strict', 'between:15,600'],

            'session' => ['array'],
            'session.idleTimeoutMinutes' => ['integer:strict', 'between:5,10080'],
        ];

        foreach (['attachments', 'rating', 'sounds', 'preChat', 'whatsapp', 'offlineForm', 'titleBadge', 'endChatByVisitor', 'poweredBy'] as $feature) {
            $rules['features.'.$feature] = $flag;
        }

        foreach (['name', 'email', 'phone'] as $input) {
            $rules['preChat.fields.'.$input] = ['array'];
            $rules['preChat.fields.'.$input.'.enabled'] = $flag;
            $rules['preChat.fields.'.$input.'.required'] = $flag;
        }

        foreach (WidgetTexts::keys() as $key) {
            $rules['texts.*.'.$key] = ['string', 'max:500'];
        }

        return $rules;
    }

    /**
     * @param  array<string, list<mixed>>  $rules
     * @return array<string, list<mixed>>
     */
    private function prefixed(array $rules, string $field): array
    {
        $prefixed = [$field => ['present', 'array']];

        foreach ($rules as $path => $rule) {
            $prefixed[$field.'.'.$path] = $rule;
        }

        return $prefixed;
    }

    /**
     * Allowed child segments per rule path (`'theme'` => `['mode', 'primary', ...]`, `'hours.schedule'` => `['*']`).
     *
     * @return array<string, list<string>>
     */
    private function children(): array
    {
        if ($this->children !== null) {
            return $this->children;
        }

        $children = [];

        foreach (array_keys($this->rules()) as $path) {
            $segments = explode('.', $path);

            foreach ($segments as $index => $segment) {
                $parent = implode('.', array_slice($segments, 0, $index));

                if (! in_array($segment, $children[$parent] ?? [], true)) {
                    $children[$parent][] = $segment;
                }
            }
        }

        return $this->children = $children;
    }

    /**
     * Collect keys that are not part of the schema (and malformed list/object shapes).
     *
     * @param  array<array-key, mixed>  $value
     * @param  array<string, string>  $errors  error path => message
     */
    private function walk(array $value, string $pattern, string $path, array &$errors): void
    {
        $allowed = $this->children()[$pattern] ?? null;

        if ($allowed === null) {
            return;
        }

        $isMap = in_array('*', $allowed, true);
        $isList = in_array($pattern, self::LISTS, true);

        if ($isList && $value !== [] && ! array_is_list($value)) {
            $errors[$path] = 'This must be a list.';

            return;
        }

        if (! $isList && ! $isMap && $value !== [] && array_is_list($value)) {
            $errors[$path] = 'This must be an object.';

            return;
        }

        foreach ($value as $key => $child) {
            $segment = (string) $key;
            $childPath = $path.'.'.$segment;

            if ($isMap) {
                if ($pattern === 'texts' && preg_match(self::LOCALE, $segment) !== 1) {
                    $errors[$childPath] = 'This is not a valid locale code.';

                    continue;
                }

                $childPattern = ltrim($pattern.'.*', '.');
            } else {
                if (! in_array($segment, $allowed, true)) {
                    $errors[$childPath] = 'Unknown option.';

                    continue;
                }

                $childPattern = ltrim($pattern.'.'.$segment, '.');
            }

            if (is_array($child)) {
                $this->walk($child, $childPattern, $childPath, $errors);
            }
        }
    }

    /**
     * Checks that span several fields; only run once every field is individually valid.
     *
     * @param  array<string, mixed>  $config  Merged with defaults.
     * @return array<string, string>
     */
    private function crossFieldErrors(array $config, string $field): array
    {
        $errors = [];

        foreach (['name', 'email', 'phone'] as $input) {
            $entry = $config['preChat']['fields'][$input];

            if ($entry['required'] && ! $entry['enabled']) {
                $errors["{$field}.preChat.fields.{$input}.enabled"] = 'A required field must be enabled.';
            }
        }

        if ($config['launcher']['icon'] === LauncherIcon::Custom->value && $config['launcher']['iconUrl'] === null) {
            $errors["{$field}.launcher.iconUrl"] = 'A custom launcher icon needs an icon URL.';
        }

        $previous = -1;

        foreach ($config['routing']['waves'] as $index => $wave) {
            if ($wave['afterSeconds'] <= $previous) {
                $errors["{$field}.routing.waves.{$index}.afterSeconds"] = 'Waves must start strictly later than the previous one.';
            }

            $previous = $wave['afterSeconds'];
        }

        $byDay = [];

        foreach ($config['hours']['schedule'] as $index => $range) {
            if ($range['end'] <= $range['start']) {
                $errors["{$field}.hours.schedule.{$index}.end"] = 'A range must end after it starts (use two ranges to span midnight).';

                continue;
            }

            $byDay[$range['day']][$index] = $range;
        }

        foreach ($byDay as $ranges) {
            uasort($ranges, static fn (array $a, array $b): int => strcmp($a['start'], $b['start']));
            $lastEnd = null;

            foreach ($ranges as $index => $range) {
                if ($lastEnd !== null && $range['start'] < $lastEnd) {
                    $errors["{$field}.hours.schedule.{$index}.start"] = 'Ranges on the same day must not overlap.';
                }

                $lastEnd = max($lastEnd ?? '', $range['end']);
            }
        }

        return $errors;
    }

    /**
     * A locale with no texts at all is no locale (it would serialise as `[]` instead of `{}`).
     *
     * @param  array<array-key, mixed>  $config
     * @return array<array-key, mixed>
     */
    private function withoutEmptyTextBlocks(array $config): array
    {
        if (isset($config['texts']) && is_array($config['texts'])) {
            $config['texts'] = array_filter($config['texts'], static fn (mixed $block): bool => ! is_array($block) || $block !== []);
        }

        return $config;
    }

    /**
     * Drop `null` where the default is a real value, so an emptied field falls back to its default.
     *
     * @param  array<array-key, mixed>  $input
     * @param  array<array-key, mixed>  $defaults
     * @return array<array-key, mixed>
     */
    private function stripNulls(array $input, array $defaults): array
    {
        foreach ($input as $key => $value) {
            $default = $defaults[$key] ?? null;

            if ($value === null && $default !== null) {
                unset($input[$key]);

                continue;
            }

            if (is_array($value) && is_array($default) && ! array_is_list($default)) {
                $input[$key] = $this->stripNulls($value, $default);
            }
        }

        if (isset($input['texts']) && is_array($input['texts'])) {
            foreach ($input['texts'] as $locale => $block) {
                if (is_array($block)) {
                    $input['texts'][$locale] = array_filter($block, static fn (mixed $text): bool => $text !== null);
                }
            }
        }

        return $input;
    }

    /**
     * Deep-merge input onto the defaults: objects merge key by key, lists and scalars replace.
     *
     * @param  array<array-key, mixed>  $defaults
     * @param  array<array-key, mixed>  $input
     * @return array<array-key, mixed>
     */
    private function merge(array $defaults, array $input): array
    {
        foreach ($input as $key => $value) {
            if (is_array($value) && isset($defaults[$key]) && is_array($defaults[$key]) && ! array_is_list($defaults[$key])) {
                $defaults[$key] = $this->merge($defaults[$key], $value);

                continue;
            }

            $defaults[$key] = $value;
        }

        return $defaults;
    }
}
