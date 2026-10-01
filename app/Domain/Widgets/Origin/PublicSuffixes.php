<?php

namespace App\Domain\Widgets\Origin;

/**
 * A compact, built-in stand-in for the Public Suffix List, used for one decision only: a wildcard domain entry
 * (`*.example.com`) must hang below a name one party owns, never below a name many parties share (`*.com`, `*.co.uk`,
 * `*.github.io`), or one customer's whitelist entry would admit every site under that suffix.
 *
 * It is deliberately small (no dependency, no data file to keep in sync). Three layers:
 * - a name with a single label (`com`, `net`, `org`, `localhost`, ...) is always a suffix;
 * - the regular "second level under a country code" shape: `co`, `com`, `org`, `net`, `ac`, `gov`, ... under a
 *   two-letter ccTLD (`co.uk`, `com.au`, `ac.jp`, `gov.in`, ...), which covers most ccTLD registries without a long list;
 * - an explicit list of irregular country-code suffixes and of platforms that hand out sub-domains to unrelated customers
 *   (`github.io`, `herokuapp.com`, `vercel.app`, ...).
 *
 * A suffix that is missing here only means a wildcard under it is accepted (as it was before this class existed): add it
 * to SHARED_SUFFIXES.
 */
final class PublicSuffixes
{
    /** Labels that act as a registry-level "second level" below a two-letter country code (`co.uk`, `com.au`, `ac.jp`). */
    private const SECOND_LEVEL_LABELS = [
        'co', 'com', 'org', 'net', 'edu', 'gov', 'mil', 'ac', 'or', 'ne', 'go', 'gob', 'gouv', 'nom', 'sch', 'ltd', 'plc',
    ];

    /** Irregular country-code suffixes and shared hosting platforms. */
    private const SHARED_SUFFIXES = [
        // country codes that do not follow the regular shape
        'nhs.uk', 'police.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'org.uk', 'sch.uk',
        'ac.uk', 'gov.uk', 'co.uk', 'com.au', 'org.au', 'net.au', 'edu.au', 'gov.au', 'id.au',
        'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz', 'school.nz',
        'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'ed.jp', 'gr.jp',
        'co.kr', 'or.kr', 'ne.kr', 'ac.kr', 'go.kr',
        'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
        'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
        'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
        'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
        'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
        'com.sg', 'org.sg', 'net.sg', 'edu.sg', 'gov.sg',
        'com.my', 'org.my', 'net.my', 'edu.my', 'gov.my',
        'com.mx', 'org.mx', 'net.mx', 'edu.mx', 'gob.mx',
        'com.ar', 'org.ar', 'net.ar', 'edu.ar', 'gob.ar',
        'com.tr', 'org.tr', 'net.tr', 'edu.tr', 'gov.tr',
        'com.ua', 'org.ua', 'net.ua', 'edu.ua', 'gov.ua',
        'com.pl', 'org.pl', 'net.pl', 'edu.pl', 'gov.pl',
        'com.sa', 'org.sa', 'net.sa', 'edu.sa', 'gov.sa',
        'com.eg', 'org.eg', 'net.eg', 'edu.eg', 'gov.eg',
        'com.pk', 'org.pk', 'net.pk', 'edu.pk', 'gov.pk',
        'com.ng', 'org.ng', 'net.ng', 'edu.ng', 'gov.ng',
        'com.co', 'org.co', 'net.co', 'edu.co', 'gov.co',
        'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
        'co.id', 'or.id', 'ac.id', 'go.id', 'web.id',
        'co.th', 'or.th', 'ac.th', 'go.th', 'in.th',
        'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'edu.in', 'firm.in', 'gen.in', 'ind.in',
        'com.vn', 'org.vn', 'net.vn', 'edu.vn', 'gov.vn',
        'com.ph', 'org.ph', 'net.ph', 'edu.ph', 'gov.ph',
        'co.ke', 'or.ke', 'ac.ke', 'go.ke',
        'co.ae', 'net.ae', 'org.ae', 'ac.ae', 'gov.ae',
        // platforms that give unrelated customers a sub-domain
        'github.io', 'gitlab.io', 'githubusercontent.com', 'herokuapp.com', 'herokussl.com', 'vercel.app', 'now.sh',
        'netlify.app', 'netlify.com', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com',
        'blogspot.com', 'wordpress.com', 'wixsite.com', 'weebly.com', 'myshopify.com', 'squarespace.com',
        'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'amazonaws.com', 'elasticbeanstalk.com',
        'onrender.com', 'fly.dev', 'railway.app', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'repl.co',
        'glitch.me', 'surge.sh', 'neocities.org', 'bubbleapps.io', 'webflow.io', 'framer.app', 'carrd.co',
        'tumblr.com', 'medium.com', 'substack.com', 'notion.site', 'my.id', 'rhcloud.com', 'dyndns.org', 'no-ip.org',
    ];

    /**
     * Whether `$host` (lower-case, punycode, no port) is a suffix under which unrelated parties register names.
     */
    public static function isPublicSuffix(string $host): bool
    {
        $host = strtolower(trim($host, '.'));

        if ($host === '') {
            return true;
        }

        if (! str_contains($host, '.') || in_array($host, self::SHARED_SUFFIXES, true)) {
            return true;
        }

        $labels = explode('.', $host);

        if (count($labels) === 2 && in_array($labels[0], self::SECOND_LEVEL_LABELS, true) && self::looksLikeCountryCode($labels[1])) {
            return true;
        }

        return false;
    }

    private static function looksLikeCountryCode(string $label): bool
    {
        return strlen($label) === 2 && ctype_alpha($label);
    }
}
