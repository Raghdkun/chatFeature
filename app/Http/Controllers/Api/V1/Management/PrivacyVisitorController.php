<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Privacy\VisitorErasureData;
use App\Domain\Privacy\Actions\EraseVisitor;
use App\Domain\Privacy\Actions\ExportVisitorData;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use App\Models\Visitor;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Data-subject requests about one visitor, administrators only (route middleware `admin`, `VisitorPolicy` inside the actions):
 * `GET /visitors/{ulid}/export` (everything held about them, one JSON document) and `DELETE /visitors/{ulid}` (erasure: identity, sessions,
 * conversations, messages, attachment files, offline tickets). Both are audited with ids and counts only. The erasure is idempotent: a
 * visitor that is already gone answers `200` with `erased: false`.
 */
class PrivacyVisitorController extends ManagementController
{
    public function export(Request $request, string $ulid, ExportVisitorData $export): StreamedResponse
    {
        $visitor = $this->find($ulid) ?? throw ApiProblemException::notFound('not_found', __('This visitor was not found.'));

        return response()->stream(
            $export->handle($visitor, $this->requireActor($request)),
            200,
            [
                'Content-Type' => 'application/json; charset=utf-8',
                'Content-Disposition' => 'attachment; filename="visitor-'.$visitor->ulid.'.json"',
                'Cache-Control' => 'no-store',
                'X-Accel-Buffering' => 'no',
                'X-Content-Type-Options' => 'nosniff',
            ],
        );
    }

    public function destroy(Request $request, string $ulid, EraseVisitor $erase): JsonResponse
    {
        $visitor = $this->find($ulid);

        if ($visitor === null) {
            return $this->data(VisitorErasureData::fromReport(strtolower($ulid), false));
        }

        $report = $erase->handle($visitor, $this->requireActor($request));

        return $this->data(VisitorErasureData::fromReport($visitor->ulid, $report->erased, $report->counts));
    }

    private function find(string $ulid): ?Visitor
    {
        return Str::isUlid($ulid) ? Visitor::query()->where('ulid', strtolower($ulid))->first() : null;
    }

    private function requireActor(Request $request): User
    {
        return $this->actor($request) ?? throw ApiProblemException::unauthorized('unauthenticated', __('Sign in to continue.'));
    }
}
