<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="robots" content="noindex">
        <meta name="color-scheme" content="light dark">
        <title>@yield('title') - {{ config('app.name') }}</title>
        {{-- Self-contained on purpose (no Vite, no script): an error page must render when the app itself is what failed. --}}
        <style>
            :root { color-scheme: light dark; --fg: #0f1d1b; --muted: #4b5e5b; --card: #ffffff; --bg: #f3f7f6; --line: #d5e0de; --brand: #0f766e; --on-brand: #ffffff; }
            @media (prefers-color-scheme: dark) { :root { --fg: #e8f1ef; --muted: #a3b8b4; --card: #14211f; --bg: #0b1412; --line: #26403c; --brand: #5eead4; --on-brand: #04201c; } }
            * { box-sizing: border-box; }
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--fg); }
            main { width: 100%; max-width: 30rem; padding: 2.25rem 2rem; text-align: center; background: var(--card); border: 1px solid var(--line); border-radius: 1rem; }
            .brand { margin: 0 0 1.5rem; font-size: .8rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
            .code { margin: 0; font-size: 3.25rem; font-weight: 700; line-height: 1; letter-spacing: -.02em; color: var(--brand); }
            h1 { margin: .75rem 0 .5rem; font-size: 1.25rem; font-weight: 650; text-wrap: balance; }
            p.message { margin: 0 0 1.75rem; line-height: 1.55; color: var(--muted); text-wrap: pretty; }
            .actions { display: flex; flex-wrap: wrap; gap: .625rem; justify-content: center; }
            .actions a { display: inline-block; padding: .6rem 1.1rem; border-radius: .6rem; border: 1px solid var(--line); color: inherit; text-decoration: none; font-size: .9rem; font-weight: 550; }
            .actions a.primary { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
            .actions a:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
        </style>
    </head>
    <body>
        <main role="main">
            <p class="brand">{{ config('app.name') }}</p>
            <p class="code" aria-hidden="true">@yield('code')</p>
            <h1>@yield('title')</h1>
            <p class="message">@yield('message')</p>
            <div class="actions">
                <a class="primary" href="{{ url('/') }}">{{ __('Go to the dashboard') }}</a>
                @hasSection('retry')
                    <a href="{{ url()->current() }}">@yield('retry')</a>
                @endif
            </div>
        </main>
    </body>
</html>
