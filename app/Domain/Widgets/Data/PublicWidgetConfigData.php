<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The part of the config visitors receive: everything except the server-side policy blocks
 * (`routing.*`, `session.*`). `texts` already carries complete blocks (locale fallbacks applied).
 */
#[TypeScript]
class PublicWidgetConfigData extends Data
{
    /**
     * @param  array<string, array<string, string>>  $texts
     */
    public function __construct(
        public int $v,
        public string $defaultLocale,
        public bool $localeDetect,
        public ThemeConfigData $theme,
        public LauncherConfigData $launcher,
        public array $texts,
        public FeaturesConfigData $features,
        public PreChatConfigData $preChat,
        public GreetingsConfigData $greetings,
        public HoursConfigData $hours,
    ) {}

    /**
     * @param  array<string, array<string, string>>  $texts
     */
    public static function fromConfig(WidgetConfigData $config, array $texts): self
    {
        return new self(
            v: $config->v,
            defaultLocale: $config->defaultLocale,
            localeDetect: $config->localeDetect,
            theme: $config->theme,
            launcher: $config->launcher,
            texts: $texts,
            features: $config->features,
            preChat: $config->preChat,
            greetings: $config->greetings,
            hours: $config->hours,
        );
    }
}
