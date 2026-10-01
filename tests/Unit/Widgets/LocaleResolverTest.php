<?php

namespace Tests\Unit\Widgets;

use App\Domain\Widgets\Config\LocaleResolver;
use App\Domain\Widgets\Data\WidgetTexts;
use PHPUnit\Framework\TestCase;

class LocaleResolverTest extends TestCase
{
    public function test_resolution_order(): void
    {
        $available = ['en', 'ar', 'pt-BR', 'de-AT'];

        $this->assertSame('en', LocaleResolver::resolve(null, 'en', $available));
        $this->assertSame('ar', LocaleResolver::resolve('ar', 'en', $available));
        $this->assertSame('ar', LocaleResolver::resolve('AR', 'en', $available), 'case-insensitive');
        $this->assertSame('pt-BR', LocaleResolver::resolve('pt-br', 'en', $available));
        $this->assertSame('ar', LocaleResolver::resolve('ar-SA', 'en', $available), 'region falls back to the language');
        $this->assertSame('pt-BR', LocaleResolver::resolve('pt', 'en', $available), 'a language falls back to any of its variants');
        $this->assertSame('de-AT', LocaleResolver::resolve('de-CH', 'en', $available), 'another variant of the language');
        $this->assertSame('en', LocaleResolver::resolve('fr', 'en', $available), 'unknown language falls back to the default');
        $this->assertSame('ar', LocaleResolver::resolve('fr', 'ar', $available));
    }

    public function test_sanitising_user_supplied_locales(): void
    {
        $this->assertSame('en', LocaleResolver::sanitize('en'));
        $this->assertSame('pt-BR', LocaleResolver::sanitize('pt_BR'));
        $this->assertNull(LocaleResolver::sanitize('<script>'));
        $this->assertNull(LocaleResolver::sanitize(''));
        $this->assertNull(LocaleResolver::sanitize(['en']));
        $this->assertNull(LocaleResolver::sanitize("en\n"));
        $this->assertNull(LocaleResolver::sanitize(str_repeat('a', 40)));
    }

    public function test_texts_fall_back_to_the_default_locale_and_then_to_english(): void
    {
        $texts = [
            'ar' => ['title' => 'الدعم', 'send' => 'إرسال'],
            'fr' => ['title' => 'Aide'],
        ];

        $french = LocaleResolver::completeTexts($texts, 'ar', 'fr');

        $this->assertSame('Aide', $french['title'], 'the locale itself wins');
        $this->assertSame('إرسال', $french['send'], 'then the default locale');
        $this->assertSame(WidgetTexts::ENGLISH['welcome'], $french['welcome'], 'then built-in English');
        $this->assertSame(WidgetTexts::keys(), array_keys($french), 'every key is present');
    }

    public function test_empty_strings_do_not_override_a_fallback(): void
    {
        $texts = ['en' => ['title' => 'Support'], 'de' => ['title' => '', 'send' => 'Senden']];

        $german = LocaleResolver::completeTexts($texts, 'en', 'de');

        $this->assertSame('Support', $german['title']);
        $this->assertSame('Senden', $german['send']);
    }

    public function test_translated_names(): void
    {
        $translations = ['ar' => 'الفواتير', 'pt-BR' => 'Faturamento', 'de' => ''];

        $this->assertSame('الفواتير', LocaleResolver::translate('Billing', $translations, 'ar'));
        $this->assertSame('الفواتير', LocaleResolver::translate('Billing', $translations, 'ar-SA'), 'region falls back to the language');
        $this->assertSame('Faturamento', LocaleResolver::translate('Billing', $translations, 'pt'));
        $this->assertSame('Billing', LocaleResolver::translate('Billing', $translations, 'fr'), 'no translation: the base name');
        $this->assertSame('Billing', LocaleResolver::translate('Billing', $translations, 'de'), 'an empty translation does not blank the label');
        $this->assertSame('Billing', LocaleResolver::translate('Billing', $translations, null));
        $this->assertSame('Billing', LocaleResolver::translate('Billing', [], 'ar'));
    }
}
