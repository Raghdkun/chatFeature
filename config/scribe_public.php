<?php

use App\Support\ApiDocs\ApiAudience;
use App\Support\ApiDocs\ScribeConfig;
use Knuckles\Scribe\Scribe;

/*
|--------------------------------------------------------------------------
| API reference: Public (visitor) API (php artisan scribe:generate --config=scribe_public / composer docs:api)
|--------------------------------------------------------------------------
| `/api/v1/public/*` plus the loader, iframe and hosted-page routes. See config/scribe.php.
*/
return class_exists(Scribe::class) ? ScribeConfig::for(ApiAudience::Public, is_string(env('API_DOCS_OUTPUT_PUBLIC')) ? env('API_DOCS_OUTPUT_PUBLIC') : null) : [];
