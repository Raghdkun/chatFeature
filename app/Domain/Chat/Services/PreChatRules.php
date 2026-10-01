<?php

namespace App\Domain\Chat\Services;

use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Models\Visitor;
use App\Models\Widget;

/**
 * Server-side enforcement of the widget's pre-chat form (`config.preChat`, docs/contracts/widget-config.md): a field that is
 * enabled and required must be filled (the visitor may already have it from a verified identity or an earlier form), a
 * disabled field is ignored, and a consent text gates the start behind `consent = true`. With the `preChat` feature switched
 * off nothing is asked.
 */
final class PreChatRules
{
    public const PHONE_PATTERN = '/^[0-9+().\- ]{3,40}$/D';

    public function __construct(private readonly WidgetConfigValidator $configs) {}

    /**
     * Validation rules for `name`, `email`, `phone` and `consent` of the start request.
     *
     * @return array<string, list<mixed>>
     */
    public function rulesFor(Widget $widget, Visitor $visitor): array
    {
        $config = $this->configs->hydrate($widget->config);
        $asked = $config->features->preChat;
        $fields = $config->preChat->fields;

        $formats = [
            'name' => ['string', 'max:120'],
            'email' => ['string', 'email', 'max:190'],
            'phone' => ['string', 'regex:'.self::PHONE_PATTERN],
        ];
        $rules = [];

        foreach ($formats as $field => $format) {
            $setting = $fields->{$field};

            if (! $asked || ! $setting->enabled) {
                $rules[$field] = ['nullable'];

                continue;
            }

            // Required, unless the visitor already has it (a verified identity, an earlier form).
            $rules[$field] = $setting->required && blank($visitor->{$field}) ? ['required', ...$format] : ['nullable', ...$format];
        }

        $rules['consent'] = $asked && filled($config->preChat->consentText) ? ['accepted'] : ['nullable', 'boolean'];

        return $rules;
    }

    /**
     * The fields the visitor's record may take from the form: only those the widget actually asks for.
     *
     * @return list<string>
     */
    public function collectedFields(Widget $widget): array
    {
        $config = $this->configs->hydrate($widget->config);

        if (! $config->features->preChat) {
            return [];
        }

        $fields = $config->preChat->fields;

        return array_values(array_filter(['name', 'email', 'phone'], fn (string $field): bool => $fields->{$field}->enabled));
    }
}
