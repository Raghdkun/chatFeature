@php
    $htmlLocale = str_replace('_', '-', app()->getLocale());
    // Keep in sync with RTL_LANGUAGES in resources/js/lib/i18n.ts.
    $htmlDirection = in_array(strtolower(explode('-', $htmlLocale)[0]), ['ar', 'he', 'fa', 'ur'], true) ? 'rtl' : 'ltr';
@endphp
<!DOCTYPE html>
<html lang="{{ $htmlLocale }}" dir="{{ $htmlDirection }}" @class(['dark' => ($appearance ?? 'system') == 'dark'])>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="light dark">
        {{-- The nonce of this response's CSP: the builder preview builds an `srcdoc` document that inherits the policy, so its inline scripts must carry it. --}}
        <meta name="csp-nonce" content="{{ \Illuminate\Support\Facades\Vite::cspNonce() }}">

        {{-- Inline script to detect system dark mode preference and apply it immediately. It carries the per-request CSP nonce (SecurityHeaders): the dashboard's script policy has no 'unsafe-inline'. --}}
        <script nonce="{{ \Illuminate\Support\Facades\Vite::cspNonce() }}">
            (function() {
                const appearance = '{{ $appearance ?? "system" }}';

                if (appearance === 'system') {
                    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

                    if (prefersDark) {
                        document.documentElement.classList.add('dark');
                    }
                }
            })();
        </script>

        {{-- Inline style to paint the page with the theme background before app.css loads (match --background in resources/css/app.css) --}}
        <style>
            html {
                background-color: oklch(0.985 0.004 175);
            }

            html.dark {
                background-color: oklch(0.17 0.012 190);
            }
        </style>

        <link rel="icon" href="/favicon.ico" sizes="any">
        <link rel="icon" href="/favicon.svg" type="image/svg+xml">
        <link rel="apple-touch-icon" href="/apple-touch-icon.png">
        {{-- Web app manifest (installable dashboard; iOS delivers web push only to an installed app). Not before the install: the install gate would answer it with the setup page. --}}
        @if ($page['props']['installed'] ?? false)
            <link rel="manifest" href="/manifest.webmanifest">
        @endif

        @fonts

        @viteReactRefresh
        @vite(['resources/css/app.css', 'resources/js/app.tsx', "resources/js/pages/{$page['component']}.tsx"])
        <x-inertia::head>
            <title>{{ $page['props']['name'] ?? config('app.name', 'Laravel') }}</title>
        </x-inertia::head>
    </head>
    <body class="font-sans antialiased">
        <x-inertia::app />
    </body>
</html>
