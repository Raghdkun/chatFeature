<?php

namespace App\Http\Requests\Widgets;

use App\Domain\Widgets\Origin\OriginMatcher;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Body of `PUT /api/v1/widgets/{ulid}/domains`: `{ domains: string[] }`. Each entry is normalised
 * (lower-case, punycode, no scheme/path/userinfo, `*.` wildcard only as the first label, optional port) or rejected.
 */
class ReplaceDomainsRequest extends FormRequest
{
    public const MAX_DOMAINS = 50;

    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'domains' => ['present', 'array', 'max:'.self::MAX_DOMAINS],
            'domains.*' => ['string', 'max:260'],
        ];
    }

    /**
     * @return array<int, callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $matcher = app(OriginMatcher::class);

                foreach ((array) $this->input('domains', []) as $index => $domain) {
                    if (is_string($domain) && $matcher->normalizeEntry($domain) === null) {
                        $validator->errors()->add("domains.{$index}", __('":domain" is not a valid domain. Use a host such as example.com, *.example.com or localhost:3000.', ['domain' => $domain]));
                    }
                }
            },
        ];
    }

    /**
     * @return list<string> normalised and de-duplicated
     */
    public function normalizedDomains(): array
    {
        $matcher = app(OriginMatcher::class);
        $domains = [];

        foreach ((array) $this->validated('domains') as $domain) {
            $normalised = $matcher->normalizeEntry((string) $domain);

            if ($normalised !== null) {
                $domains[$normalised] = $normalised;
            }
        }

        return array_values($domains);
    }
}
