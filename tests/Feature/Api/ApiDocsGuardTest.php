<?php

namespace Tests\Feature\Api;

use App\Console\Commands\ApiDocsCommand;
use App\Support\ApiDocs\ApiAudience;
use App\Support\ApiDocs\ApiDocsAudit;
use App\Support\ApiDocs\ApiRoutes;
use App\Support\ApiDocs\Catalogue;
use App\Support\ApiDocs\DataProperties;
use App\Support\ApiDocs\ErrorCatalogue;
use App\Support\ApiDocs\FieldDocs;
use App\Support\ApiDocs\RateLimitDocs;
use App\Support\ApiDocs\RequestDocs;
use App\Support\ApiDocs\Strategies\CatalogueUrlParameters;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\File;
use Knuckles\Scribe\Scribe;
use ReflectionClass;
use Symfony\Component\Yaml\Yaml;
use Tests\TestCase;

/**
 * The rot guard of the API reference. A route under `api/v1` or `webhooks` that is not in the generated OpenAPI file fails here, as
 * does a reference that no longer matches the code (the committed files are rebuilt in a child process and compared), an error code the
 * application raises but the catalogue does not know, and prose that names a field that is gone. Routes that are deliberately not documented
 * are listed, with a reason, in `Catalogue::undocumented()`.
 */
class ApiDocsGuardTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        if (! class_exists(Scribe::class)) {
            $this->markTestSkipped('Scribe is a development dependency and is not installed.');
        }
    }

    public function test_every_documented_route_has_exactly_one_entry_and_no_entry_is_stale(): void
    {
        $this->assertSame([], ApiDocsAudit::problems());
    }

    public function test_the_audit_names_the_routes_it_cannot_find_an_entry_for(): void
    {
        $this->app['router']->get('api/v1/_probe/undocumented', fn () => 'x')->name('api.probe.undocumented');

        $problems = ApiDocsAudit::problems();

        $this->assertCount(1, $problems);
        $this->assertStringContainsString('api.probe.undocumented', $problems[0]);
        $this->assertStringContainsString('has no reference entry', $problems[0]);
    }

    public function test_every_api_and_webhook_route_is_in_the_committed_openapi_files(): void
    {
        $specPaths = [];

        foreach (ApiAudience::cases() as $audience) {
            $this->assertFileExists($audience->specPath(), 'run `composer docs:api` and commit docs/api/*.yaml');

            foreach ((array) Yaml::parseFile($audience->specPath())['paths'] as $path => $operations) {
                foreach (array_keys($operations) as $method) {
                    if (in_array($method, ['get', 'post', 'put', 'patch', 'delete'], true)) {
                        $specPaths[$audience->value][strtoupper($method).' '.$path] = true;
                    }
                }
            }
        }

        $routes = [];

        foreach (ApiRoutes::required() as $route) {
            $label = ApiRoutes::label($route);

            if (isset(Catalogue::undocumented()[$route->getName() ?? $label])) {
                continue;
            }

            $audience = ApiAudience::forUri($route->uri(), $route->getName());
            $this->assertNotNull($audience);
            $routes[$audience->value][$label] = true;

            $this->assertArrayHasKey($label, $specPaths[$audience->value] ?? [], "The route [{$label}] is missing from docs/api/openapi-{$audience->value}.yaml: document it and run `composer docs:api`.");
        }

        foreach ($specPaths as $audience => $labels) {
            foreach (array_keys($labels) as $label) {
                $isDelivery = str_starts_with($label, 'GET /w/') || str_starts_with($label, 'GET /widget/') || str_starts_with($label, 'GET /embed/') || str_starts_with($label, 'GET /c/');

                $this->assertTrue($isDelivery || isset($routes[$audience][$label]), "The OpenAPI file [{$audience}] documents [{$label}], which is not a route any more: run `composer docs:api`.");
            }
        }
    }

    public function test_the_committed_openapi_files_are_what_the_code_generates_today(): void
    {
        $status = Artisan::call('docs:api', ['--check' => true]);

        $this->assertSame(0, $status, "docs/api/*.yaml is out of date: run `composer docs:api` and commit the result.\n".Artisan::output());
    }

    public function test_every_error_code_the_application_raises_is_in_the_catalogue_and_every_catalogued_code_is_raised(): void
    {
        $raised = [];

        foreach (File::allFiles(app_path()) as $file) {
            if ($file->getExtension() !== 'php' || str_contains($file->getPathname(), '/Support/ApiDocs/')) {
                continue;
            }

            $source = (string) file_get_contents($file->getPathname());

            preg_match_all('/ApiProblemException::(?:conflict|notFound|unauthorized|forbidden)\(\s*\'([a-z_]+)\'/', $source, $a);
            preg_match_all('/new ApiProblemException\(\s*\d{3},\s*\'([a-z_]+)\'/', $source, $b);
            preg_match_all('/\'error\' => \[\'code\' => \'([a-z_]+)\'/', $source, $c);

            foreach ([...$a[1], ...$b[1], ...$c[1]] as $code) {
                $raised[$code] = $file->getFilename();
            }
        }

        // Raised in a shape the patterns above do not see (a computed code, the generic renderer, the framework).
        $elsewhere = ['validation_failed', 'unauthenticated', 'forbidden', 'not_found', 'bad_request', 'method_not_allowed', 'csrf_mismatch', 'rate_limited', 'server_error', 'conflict', 'unavailable', 'http_error', 'webhook_rejected', 'webhook_limit_reached', 'daily_cap_reached', 'qr_not_available', 'no_chat_access', 'auth_unavailable', 'attachment_quota_exceeded'];
        $catalogued = array_keys(ErrorCatalogue::all());

        foreach ($raised as $code => $file) {
            $this->assertContains($code, $catalogued, "The code [{$code}] (raised in {$file}) is not in App\\Support\\ApiDocs\\ErrorCatalogue: document it.");
        }

        foreach ($catalogued as $code) {
            $this->assertTrue(isset($raised[$code]) || in_array($code, $elsewhere, true) || $this->appMentions($code), "The catalogued code [{$code}] is not raised anywhere in app/: remove it from ErrorCatalogue.");
        }
    }

    private function appMentions(string $code): bool
    {
        foreach (File::allFiles(app_path()) as $file) {
            if (str_contains($file->getPathname(), '/Support/ApiDocs/')) {
                continue;
            }

            if (str_contains((string) file_get_contents($file->getPathname()), "'{$code}'")) {
                return true;
            }
        }

        return false;
    }

    public function test_every_field_description_names_a_property_that_exists(): void
    {
        $classes = $this->dataClassesOfTheCatalogue();

        foreach (FieldDocs::all() as $short => $fields) {
            $matching = array_values(array_filter($classes, static fn (string $class): bool => substr($class, (int) strrpos($class, '\\') + 1) === $short));

            $this->assertNotSame([], $matching, "FieldDocs describes [{$short}], which no endpoint of the reference returns.");

            $names = array_column(DataProperties::of($matching[0]), 'name');

            foreach (array_keys($fields) as $property) {
                $this->assertContains($property, $names, "FieldDocs describes [{$short}::\${$property}], which does not exist.");
            }
        }
    }

    public function test_every_validated_request_field_of_a_documented_route_has_prose_and_no_prose_is_left_behind(): void
    {
        $classes = [];

        foreach (ApiRoutes::required() as $route) {
            $action = $route->getActionName();

            if (! str_contains($action, '@')) {
                continue;
            }

            [$controller, $method] = explode('@', $action);

            foreach ((new ReflectionClass($controller))->getMethod($method)->getParameters() as $parameter) {
                $type = $parameter->getType()?->getName();

                if ($type !== null && is_subclass_of($type, FormRequest::class)) {
                    $classes[$type] = true;
                }
            }
        }

        $this->assertNotEmpty($classes);

        foreach (array_keys($classes) as $class) {
            $key = substr($class, strlen('App\\Http\\Requests\\'));
            $docs = RequestDocs::for($class);
            $this->assertNotSame([], $docs, "The Form Request [{$key}] of a documented route has no entry in RequestDocs.");

            $rules = array_keys((new $class)->rules());

            foreach ($rules as $field) {
                $parent = str_ends_with($field, '.*') ? substr($field, 0, -2) : null;
                $this->assertTrue(isset($docs[$field]) || ($parent !== null && isset($docs[$parent])), "The field [{$field}] of [{$key}] has no description in RequestDocs.");
            }

            foreach (array_keys($docs) as $field) {
                $this->assertContains($field, $rules, "RequestDocs describes [{$key}::{$field}], which the request does not validate.");
            }
        }
    }

    public function test_every_url_parameter_of_a_documented_route_is_described(): void
    {
        $known = array_keys(CatalogueUrlParameters::known());

        foreach (ApiRoutes::required() as $route) {
            foreach (ApiRoutes::parameters($route) as $parameter) {
                $this->assertContains($parameter, $known, 'The URL parameter {'.$parameter.'} of ['.ApiRoutes::label($route).'] is not described in CatalogueUrlParameters.');
            }
        }
    }

    public function test_every_entry_is_filed_in_a_group_its_reference_lists(): void
    {
        foreach (Catalogue::all() as $name => $doc) {
            $route = collect(ApiRoutes::required())->first(fn ($candidate): bool => $candidate->getName() === $name)
                ?? collect(ApiRoutes::forAudience(ApiAudience::Public))->first(fn ($candidate): bool => $candidate->getName() === $name);
            $audience = ApiAudience::forUri($route->uri(), $name);

            $this->assertContains($doc->group, Catalogue::groupOrder($audience), "[{$name}] is filed in the group [{$doc->group}], which the {$audience->value} reference does not list.");
            $this->assertNotSame('', Catalogue::groupDescription($doc->group), "The group [{$doc->group}] has no description.");
        }
    }

    public function test_the_rate_limiters_in_front_of_every_documented_route_are_described(): void
    {
        foreach (ApiRoutes::required() as $route) {
            foreach (ApiRoutes::limiters($route) as $limiter) {
                $this->assertNotNull(RateLimitDocs::describe($limiter), "The limiter [{$limiter}] of [".ApiRoutes::label($route).'] is not described in RateLimitDocs.');
            }
        }
    }

    public function test_the_generated_html_stays_out_of_git_and_the_command_exists(): void
    {
        $this->assertStringContainsString('/public/docs', (string) file_get_contents(base_path('.gitignore')));
        $this->assertTrue(class_exists(ApiDocsCommand::class));
        $this->assertArrayHasKey('docs:api', Artisan::all());
    }

    /**
     * @return list<class-string>
     */
    private function dataClassesOfTheCatalogue(): array
    {
        $classes = [];
        $collect = function (string $class) use (&$classes, &$collect): void {
            if (in_array($class, $classes, true)) {
                return;
            }

            $classes[] = $class;

            foreach (DataProperties::of($class) as $property) {
                if ($property['class'] !== null) {
                    $collect($property['class']);
                }
            }
        };

        foreach (Catalogue::all() as $doc) {
            foreach ($doc->successes as $success) {
                if ($success->class !== null) {
                    $collect($success->class);
                }
            }
        }

        return $classes;
    }
}
