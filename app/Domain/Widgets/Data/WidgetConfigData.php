<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The widget configuration object (`widgets.config` = published, `widgets.draft_config` = draft).
 * Source of truth for docs/contracts/widget-config.md; defaults here are the contract's defaults.
 *
 * Instances come out of WidgetConfigValidator (strict, defaults filled) or WidgetConfigValidator::hydrate()
 * (trusted stored JSON). Never build one from request input directly.
 */
#[TypeScript]
class WidgetConfigData extends Data
{
    /**
     * @param  array<string, array<string, string>>  $texts  locale => (text key => string); `en` is always complete
     */
    public function __construct(
        public int $v = 1,
        public string $defaultLocale = 'en',
        public bool $localeDetect = true,
        public ThemeConfigData $theme = new ThemeConfigData,
        public LauncherConfigData $launcher = new LauncherConfigData,
        public array $texts = ['en' => WidgetTexts::ENGLISH],
        public FeaturesConfigData $features = new FeaturesConfigData,
        public PreChatConfigData $preChat = new PreChatConfigData,
        public GreetingsConfigData $greetings = new GreetingsConfigData,
        public HoursConfigData $hours = new HoursConfigData,
        public RoutingConfigData $routing = new RoutingConfigData,
        public SessionConfigData $session = new SessionConfigData,
    ) {}
}
