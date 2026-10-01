<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Spatie\LaravelData\Data;

/**
 * Shared helpers of the management API controllers: the `{ data }` / `{ data, meta }` envelopes of
 * docs/contracts/rest-shapes.md. Data objects are serialised through their own `toArray()` (enums, nested objects).
 */
abstract class ManagementController extends Controller
{
    /**
     * @param  Data|array<array-key, mixed>  $payload
     */
    protected function data(Data|array $payload, int $status = 200): JsonResponse
    {
        return response()->json(['data' => $payload instanceof Data ? $payload->toArray() : $payload], $status);
    }

    /**
     * A complete (unpaginated) list in the list envelope.
     *
     * @param  iterable<Data|array<array-key, mixed>>  $items
     */
    protected function list(iterable $items): JsonResponse
    {
        $rows = [];

        foreach ($items as $item) {
            $rows[] = $item instanceof Data ? $item->toArray() : $item;
        }

        return response()->json(['data' => $rows, 'meta' => ['next_cursor' => null]]);
    }

    protected function actor(Request $request): ?User
    {
        $user = $request->user();

        return $user instanceof User ? $user : null;
    }
}
