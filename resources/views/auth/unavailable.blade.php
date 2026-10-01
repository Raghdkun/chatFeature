<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="robots" content="noindex">
        <title>{{ __('Sign-in service unavailable') }}</title>
        <style>
            :root { color-scheme: light dark; }
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: Canvas; color: CanvasText; }
            main { max-width: 28rem; padding: 2rem 1.5rem; text-align: center; }
            h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
            p { line-height: 1.55; margin: 0 0 1.5rem; opacity: .85; }
            a { display: inline-block; padding: .5rem 1rem; border-radius: .5rem; border: 1px solid currentColor; color: inherit; text-decoration: none; font-size: .9rem; }
        </style>
    </head>
    <body>
        <main role="alert">
            <h1>{{ __('Sign-in service unavailable') }}</h1>
            <p>{{ $message }}</p>
            <a href="{{ url()->current() }}">{{ __('Try again') }}</a>
        </main>
    </body>
</html>
