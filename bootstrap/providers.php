<?php

use App\Providers\AnalyticsServiceProvider;
use App\Providers\AppServiceProvider;
use App\Providers\AuditServiceProvider;
use App\Providers\AuthModeServiceProvider;
use App\Providers\CatalogServiceProvider;
use App\Providers\ChatServiceProvider;
use App\Providers\FortifyServiceProvider;
use App\Providers\InstallAwareConfigProvider;
use App\Providers\InstallServiceProvider;
use App\Providers\NotificationsServiceProvider;
use App\Providers\PresenceServiceProvider;
use App\Providers\SettingsServiceProvider;
use App\Providers\TypeScriptTransformerServiceProvider;
use App\Providers\VisitorsServiceProvider;
use App\Providers\WhatsAppServiceProvider;
use App\Providers\WidgetsServiceProvider;

return [
    // MUST stay first: forces file/sync/null drivers until the app is installed (no DB/Redis before the wizard ran).
    InstallAwareConfigProvider::class,
    AnalyticsServiceProvider::class,
    AppServiceProvider::class,
    AuditServiceProvider::class,
    AuthModeServiceProvider::class,
    CatalogServiceProvider::class,
    ChatServiceProvider::class,
    FortifyServiceProvider::class,
    InstallServiceProvider::class,
    NotificationsServiceProvider::class,
    PresenceServiceProvider::class,
    SettingsServiceProvider::class,
    TypeScriptTransformerServiceProvider::class,
    VisitorsServiceProvider::class,
    WhatsAppServiceProvider::class,
    WidgetsServiceProvider::class,
];
