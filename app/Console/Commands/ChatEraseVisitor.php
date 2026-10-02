<?php

namespace App\Console\Commands;

use App\Domain\Privacy\Actions\EraseVisitor;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Visitor;
use Illuminate\Console\Command;
use Illuminate\Support\Str;

/**
 * Erases a visitor for good (a data-subject request): `chat:erase-visitor 01J...` or `chat:erase-visitor --email=jane@example.com` (every
 * visitor record with that address, one per widget). Same action, same audit entry and same rules as `DELETE /api/v1/visitors/{ulid}`;
 * idempotent (an unknown or already erased visitor is a success that changes nothing). A visitor with a chat that is still open is skipped.
 */
class ChatEraseVisitor extends Command
{
    protected $signature = 'chat:erase-visitor
        {visitor? : The visitor ulid}
        {--email= : Erase every visitor record with this e-mail address}
        {--force : Do not ask for confirmation}';

    protected $description = 'Erase a visitor: identity, sessions, conversations, messages, attachment files and offline tickets';

    public function handle(EraseVisitor $erase): int
    {
        $ulid = $this->argument('visitor');
        $email = $this->option('email');

        if (($ulid === null) === ($email === null || $email === '')) {
            $this->components->error('Give either the visitor ulid or --email=<address>.');

            return self::FAILURE;
        }

        $visitors = $ulid !== null
            ? Visitor::query()->where('ulid', Str::lower((string) $ulid))->get()
            : Visitor::query()->where('email', trim((string) $email))->get();

        if ($visitors->isEmpty()) {
            $this->components->info('Nothing to erase: no such visitor (already erased?).');

            return self::SUCCESS;
        }

        if (! $this->option('force') && ! $this->confirm('Erase '.$visitors->count().' visitor record(s) and everything held about them? This cannot be undone.')) {
            return self::FAILURE;
        }

        $failed = 0;

        foreach ($visitors as $visitor) {
            try {
                $report = $erase->handle($visitor, null)->toArray();
                $this->components->info($visitor->ulid.': '.json_encode(array_diff_key($report, ['erased' => 0])));
            } catch (ApiProblemException $exception) {
                $failed++;
                $this->components->error($visitor->ulid.': '.$exception->getMessage());
            }
        }

        return $failed === 0 ? self::SUCCESS : self::FAILURE;
    }
}
