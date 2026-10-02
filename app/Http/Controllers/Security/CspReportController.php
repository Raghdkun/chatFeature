<?php

namespace App\Http\Controllers\Security;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * `POST /csp-report`: the collector of the Content-Security-Policy `report-uri` (`SecurityHeaders`, docs/security.md). It is how a
 * `CSP_MODE=report-only` trial in production is read: browsers post a small JSON document for every blocked (or would-be blocked)
 * load, and each DISTINCT violation (directive, blocked origin, page) is written to the log once an hour.
 *
 * Public by nature (the browser sends no credentials), so it stores nothing but that log line, answers `204` to everything, is
 * rate limited (`csp-report`), reads at most 16 KB and logs only short, printable, sanitised fields: the page path without its query,
 * the blocked URL reduced to its origin (or `inline` / `eval`), the directive, the source file and line. The sample of the blocked code is
 * never logged.
 */
class CspReportController extends Controller
{
    public const LIMITER = 'csp-report';

    private const MAX_BYTES = 16_384;

    public function __invoke(Request $request): Response
    {
        $report = $this->report(substr($request->getContent(), 0, self::MAX_BYTES));

        if ($report !== null) {
            $key = 'csp-report:'.hash('sha256', $report['directive'].'|'.$report['blocked'].'|'.$report['page']);

            if (Cache::add($key, 1, 3600)) {
                Log::warning('csp.violation', $report);
            }
        }

        return response()->noContent();
    }

    /**
     * @return array{directive: string, blocked: string, page: string, source: string, line: int, disposition: string}|null
     */
    private function report(string $raw): ?array
    {
        $json = json_decode($raw, true);

        if (! is_array($json)) {
            return null;
        }

        // `application/csp-report` wraps the report in a `csp-report` key; the Reporting API sends a list of `{type, body}`.
        $body = $json['csp-report'] ?? null;

        if (! is_array($body) && array_is_list($json) && is_array($json[0] ?? null) && ($json[0]['type'] ?? null) === 'csp-violation') {
            $body = $json[0]['body'] ?? null;
        }

        if (! is_array($body)) {
            return null;
        }

        $field = fn (string $legacy, string $modern): string => $this->text($body[$legacy] ?? $body[$modern] ?? '');
        $directive = $field('effective-directive', 'effectiveDirective') ?: $field('violated-directive', 'violatedDirective');

        // Something that is not a violation report (an empty document, a probe) is not worth a log line.
        if ($directive === '') {
            return null;
        }

        return [
            'directive' => $directive,
            'blocked' => $this->origin($field('blocked-uri', 'blockedURL')),
            'page' => $this->path($field('document-uri', 'documentURL')),
            'source' => $this->path($field('source-file', 'sourceFile')),
            'line' => (int) ($body['line-number'] ?? $body['lineNumber'] ?? 0),
            'disposition' => $field('disposition', 'disposition'),
        ];
    }

    /** A short single-line printable string: nothing a log reader could mistake for a second log line. */
    private function text(mixed $value): string
    {
        return is_string($value) ? substr((string) preg_replace('/[^\x20-\x7e]/', '?', $value), 0, 200) : '';
    }

    /** `scheme://host[:port]` of a blocked URL, or the keyword the browser used (`inline`, `eval`, `data`, `blob`...). */
    private function origin(string $url): string
    {
        $parts = parse_url($url);

        if (is_array($parts) && isset($parts['scheme'], $parts['host'])) {
            return $this->text($parts['scheme'].'://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : ''));
        }

        return $this->text($url);
    }

    /** The path of a URL (no query, no fragment: they can hold tokens). */
    private function path(string $url): string
    {
        $parts = parse_url($url);

        return is_array($parts) ? $this->text(($parts['host'] ?? '').($parts['path'] ?? '')) : $this->text($url);
    }
}
