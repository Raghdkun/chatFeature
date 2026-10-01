<?php

namespace App\Domain\Settings;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Validation\Rule;

/**
 * A typed, validated, optionally encrypted setting known to the application.
 * Bounded contexts register their own definitions through SettingsRegistry::define().
 */
final readonly class SettingDefinition
{
    /**
     * @param  mixed  $default  Literal default, or a Closure resolved lazily (may read config()).
     * @param  list<ValidationRule|Rule|string>  $rules  Laravel validation rules for the value.
     * @param  bool  $encrypted  Store the value encrypted at rest (secrets).
     * @param  bool  $seed  Whether `seed-defaults` writes the default on a fresh install.
     */
    public function __construct(
        public string $key,
        public SettingGroup $group,
        public SettingType $type,
        public mixed $default = null,
        public array $rules = [],
        public bool $encrypted = false,
        public bool $seed = true,
    ) {}

    public function defaultValue(): mixed
    {
        return $this->default instanceof Closure ? ($this->default)() : $this->default;
    }
}
