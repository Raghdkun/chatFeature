<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\WhatsApp\Services\WaMediaStore;
use App\Models\WaMessage;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * `GET /whatsapp/media/{message}` (route `whatsapp.media.show`, the target of the signed URLs in `WaMediaData`): the stored image of an
 * inbound message. Two credentials: the URL's signature (an `<img>` cannot send a bearer token, and the signature names exactly one message
 * and expires) AND an administrator's session, so a URL that leaks is useless to anybody else. The file is streamed from the private disk
 * with the sniffed content type, `nosniff`, a CSP that sandboxes it and a neutral file name: the sender's own file name never reaches a header.
 */
class WhatsAppMediaController extends WhatsAppController
{
    public function show(Request $request, WaMessage $message): Response
    {
        Gate::forUser($this->admin($request))->authorize('view', $message);

        $path = $message->media_path;
        $disk = Storage::disk(WaMediaStore::disk());

        if ($path === null || $path === '' || ! $disk->exists($path)) {
            throw new NotFoundHttpException;
        }

        return $disk->response($path, 'image.'.pathinfo($path, PATHINFO_EXTENSION), [
            'Content-Type' => $message->media_mime ?? 'application/octet-stream',
            'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => "default-src 'none'; sandbox",
            'Cache-Control' => 'private, max-age=600',
        ]);
    }
}
