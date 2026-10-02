<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Models\Setting;
use App\Models\User;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * Settings > WhatsApp: the `whatsapp.*` settings, validated by their own definitions (the OpenWA address by the SSRF guard) and written
 * together or not at all. The API key is write-only (never returned, never in the audit entry); a changed OpenWA address needs the key
 * typed again in the same request, so a stored key is never steered to a new destination (the same rule as the auth portal's token).
 */
final class UpdateWhatsAppSettings
{
    /** Request field => setting key. */
    public const FIELDS = [
        'enabled' => 'whatsapp.enabled',
        'base_url' => 'whatsapp.openwa.base_url',
        'handoff_ttl_minutes' => 'whatsapp.handoff_ttl_minutes',
        'handoff_text' => 'whatsapp.handoff_text',
        'ignore_groups' => 'whatsapp.ignore_groups',
        'reply_only_to_inbound' => 'whatsapp.reply_only_to_inbound',
        'send_min_interval_ms' => 'whatsapp.send_min_interval_ms',
        'daily_send_cap' => 'whatsapp.daily_send_cap',
        'media_max_bytes' => 'whatsapp.media_max_bytes',
    ];

    private const API_KEY = 'whatsapp.openwa.api_key';

    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * @param  array<string, mixed>  $input  Any subset of the fields above plus `api_key` and `clear_api_key`.
     *
     * @throws ValidationException
     */
    public function handle(array $input, User $actor): void
    {
        Gate::forUser($actor)->authorize('manageSettings', WhatsAppSession::class);

        $writes = [];
        $changes = [];

        foreach (self::FIELDS as $field => $key) {
            if (array_key_exists($field, $input)) {
                $writes[$field] = $input[$field];
            }
        }

        $apiKey = isset($input['api_key']) && is_string($input['api_key']) && $input['api_key'] !== '' ? $input['api_key'] : null;
        $clearKey = ($input['clear_api_key'] ?? false) === true;

        $this->assertKeyReentered($writes, $apiKey, $clearKey);
        $this->assertValid($writes, $apiKey);

        DB::transaction(function () use ($writes, $apiKey, $clearKey, $actor, &$changes): void {
            foreach ($writes as $field => $value) {
                $key = self::FIELDS[$field];
                $before = settings()->get($key);
                settings()->set($key, $value, null, $actor->id);
                $after = settings()->get($key);

                if ($before !== $after) {
                    $changes[$key] = ['old' => $before, 'new' => $after];
                }
            }

            if ($apiKey !== null) {
                settings()->set(self::API_KEY, $apiKey, null, $actor->id);
                $changes['openwa_credential'] = 'changed';
            } elseif ($clearKey && settings()->string(self::API_KEY, '') !== '') {
                Setting::query()->where('workspace_key', 0)->where('key', self::API_KEY)->delete();
                settings()->forget();
                $changes['openwa_credential'] = 'removed';
            }
        });

        if ($changes !== []) {
            $this->audit->record('whatsapp.settings.updated', null, $changes, $actor);
        }
    }

    /**
     * @param  array<string, mixed>  $writes
     *
     * @throws ValidationException
     */
    private function assertKeyReentered(array $writes, ?string $apiKey, bool $clearKey): void
    {
        if (! array_key_exists('base_url', $writes) || $apiKey !== null || $clearKey || settings()->string(self::API_KEY, '') === '') {
            return;
        }

        $current = rtrim((string) settings()->string('whatsapp.openwa.base_url'), '/');

        if (rtrim((string) $writes['base_url'], '/') !== $current) {
            throw ValidationException::withMessages(['api_key' => [__('Enter the API key again when you change the OpenWA address.')]]);
        }
    }

    /**
     * Every value against its definition before anything is written.
     *
     * @param  array<string, mixed>  $writes
     *
     * @throws ValidationException
     */
    private function assertValid(array $writes, ?string $apiKey): void
    {
        $errors = [];
        $registry = settings()->registry();

        foreach ($writes as $field => $value) {
            $definition = $registry->require(self::FIELDS[$field]);
            $validator = Validator::make(['value' => $definition->type->cast($value)], ['value' => $definition->rules], [], ['value' => $field]);

            if ($validator->fails()) {
                $errors[$field] = $validator->errors()->get('value');
            }
        }

        if ($apiKey !== null) {
            $definition = $registry->require(self::API_KEY);
            $validator = Validator::make(['value' => $apiKey], ['value' => $definition->rules], [], ['value' => 'api_key']);

            if ($validator->fails()) {
                $errors['api_key'] = $validator->errors()->get('value');
            }
        }

        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }
    }
}
