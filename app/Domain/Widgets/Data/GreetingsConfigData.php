<?php

namespace App\Domain\Widgets\Data;

use App\Domain\Widgets\Enums\DismissPolicy;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `config.greetings`: scheduling of the greeting popup. The message pool itself lives in `widget_greetings`. */
#[TypeScript]
class GreetingsConfigData extends Data
{
    public function __construct(
        public bool $enabled = true,
        public bool $onPageLoad = true,
        public int $delaySeconds = 3,
        public int $intervalMinutes = 30,
        public int $autoHideSeconds = 180,
        public DismissPolicy $dismissPolicy = DismissPolicy::Session,
        public bool $showAgent = true,
    ) {}
}
