<?php

namespace Tests\Support;

use App\Models\WhatsAppSession;
use App\Models\Widget;
use Tests\TestCase;

/**
 * A widget that really offers WhatsApp: the global switch on, `features.whatsapp` published, a `ready` session with a number linked.
 *
 * @mixin TestCase
 */
trait InteractsWithWhatsAppWidgets
{
    protected function publishWhatsAppFeature(Widget $widget, bool $on = true): Widget
    {
        $config = $widget->config;
        $config['features']['whatsapp'] = $on;
        $widget->forceFill(['config' => $config])->save();

        return $widget->refresh();
    }

    /**
     * @return array{0: Widget, 1: WhatsAppSession}
     */
    protected function whatsAppWidget(Widget $widget, string $phone = '+4915123456789'): array
    {
        settings()->set('whatsapp.enabled', true);
        $session = WhatsAppSession::factory()->ready($phone)->create(['name' => 'support-main']);
        $this->publishWhatsAppFeature($widget);
        $widget->forceFill(['whatsapp_session_id' => $session->id])->save();

        return [$widget->refresh(), $session];
    }
}
