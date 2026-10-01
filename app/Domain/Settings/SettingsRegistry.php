<?php

namespace App\Domain\Settings;

use App\Domain\Settings\Exceptions\UnknownSettingException;

/** All known setting definitions, keyed by dotted name (`auth.mode`). */
final class SettingsRegistry
{
    /** @var array<string, SettingDefinition> */
    private array $definitions = [];

    public function define(SettingDefinition ...$definitions): void
    {
        foreach ($definitions as $definition) {
            $this->definitions[$definition->key] = $definition;
        }
    }

    public function find(string $key): ?SettingDefinition
    {
        return $this->definitions[$key] ?? null;
    }

    /**
     * @throws UnknownSettingException
     */
    public function require(string $key): SettingDefinition
    {
        return $this->find($key) ?? throw new UnknownSettingException($key);
    }

    /**
     * @return array<string, SettingDefinition>
     */
    public function all(): array
    {
        return $this->definitions;
    }
}
