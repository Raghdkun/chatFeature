<?php

namespace App\Domain\Widgets\Embed;

/**
 * The built widget loader (`public/widget/v1/loader.js`, produced by `npm run build:widget`, git-ignored) and the
 * prelude that hands it its boot config. When the bundle has not been built (a dev checkout), the prelude is served
 * with a console warning instead of failing, so the rest of the stack stays testable.
 */
final class LoaderBundle
{
    public const GLOBAL = '__PNE_CHAT_BOOT__';

    private const MISSING_NOTICE = '/* PNE Chat widget loader bundle not built: run `npm run build:widget`. */'."\n"
        .'window.console&&console.warn&&console.warn("[PNE Chat] The widget loader bundle is missing. Run `npm run build:widget`.");';

    public function __construct(private readonly string $path) {}

    public function isBuilt(): bool
    {
        // Long-lived workers (Octane, queue) must notice a rebuilt bundle: never trust PHP's stat cache here.
        clearstatcache(true, $this->path);

        return is_file($this->path) && is_readable($this->path);
    }

    /**
     * Identifies the current bundle (changes whenever it is rebuilt); `missing` while it is not built.
     */
    public function fingerprint(): string
    {
        if (! $this->isBuilt()) {
            return 'missing';
        }

        return md5(filemtime($this->path).'-'.filesize($this->path).'-'.md5_file($this->path));
    }

    /**
     * The loader code, or the console-warning stub while the bundle is missing.
     */
    public function loaderCode(): string
    {
        if (! $this->isBuilt()) {
            return self::MISSING_NOTICE;
        }

        $code = file_get_contents($this->path);

        return $code === false ? self::MISSING_NOTICE : $code;
    }

    /**
     * `/w/{key}.js`: register the resolved boot config for `$key`, then the loader.
     *
     * @param  array<string, mixed>  $boot
     */
    public function forWidget(string $key, array $boot): string
    {
        $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_THROW_ON_ERROR;

        return '(function(){var b=(window.'.self::GLOBAL.'=window.'.self::GLOBAL.'||{});b['
            .json_encode($key, $flags).']='.json_encode($boot, $flags).';})();'."\n"
            .$this->loaderCode();
    }

    /**
     * `/widget/v1/loader.js`: the generic loader (reads `data-widget-key`, fetches the config itself).
     */
    public function generic(): string
    {
        return $this->loaderCode();
    }
}
