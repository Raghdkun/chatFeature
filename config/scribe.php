<?php

use App\Support\ApiDocs\ApiAudience;
use App\Support\ApiDocs\ScribeConfig;
use Knuckles\Scribe\Scribe;

/*
|--------------------------------------------------------------------------
| API reference: Management API (php artisan scribe:generate / composer docs:api)
|--------------------------------------------------------------------------
| `/api/v1/*` for staff plus the OpenWA webhook. The twin file `scribe_public.php` is the visitor API. Both are built by
| App\Support\ApiDocs\ScribeConfig; the endpoint prose lives in app/Support/ApiDocs/Entries and the shapes come from the code (Data
| classes, Form Requests, route middleware). Scribe is a dev dependency, so without it (`composer install --no-dev`) there is nothing
| to configure and this file returns an empty array.
*/
return class_exists(Scribe::class) ? ScribeConfig::for(ApiAudience::Management, is_string(env('API_DOCS_OUTPUT_MANAGEMENT')) ? env('API_DOCS_OUTPUT_MANAGEMENT') : null) : [];
