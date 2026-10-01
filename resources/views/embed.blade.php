<!DOCTYPE html>
<html lang="{{ $locale }}" dir="{{ $direction }}">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <meta name="robots" content="noindex, nofollow">
        <meta name="color-scheme" content="light dark">
        <title>{{ __('Chat') }}</title>

        {{-- Transparent page: the host decides what is behind the panel. --}}
        <style>
            html, body { margin: 0; height: 100%; background: transparent; }
            #chat-root { height: 100%; }
        </style>

        {{-- Boot data for resources/js/embed/main.tsx (docs/contracts/widget-config.md). Never contains secrets. --}}
        <script>window.__PNE_EMBED__ = {{ Illuminate\Support\Js::from($embed) }};</script>
        @vite('resources/js/embed/main.tsx')
    </head>
    <body>
        <div id="chat-root"></div>
        <noscript>{{ __('Please enable JavaScript to use the chat.') }}</noscript>
    </body>
</html>
