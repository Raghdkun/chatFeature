<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Support\Facades\Crypt;

/**
 * Generates a new HS256 identity secret (32 random bytes, hex) and stores it encrypted. The plaintext is returned
 * to the caller exactly once; tokens signed with the previous secret stop verifying immediately.
 */
final class RotateIdentitySecret
{
    public const BYTES = 32;

    public function __construct(private readonly AuditLogger $audit) {}

    public function handle(Widget $widget, ?User $actor = null): string
    {
        $secret = bin2hex(random_bytes(self::BYTES));

        $widget->forceFill(['identity_secret_encrypted' => Crypt::encryptString($secret)])->save();
        $this->audit->record('widget.secret_rotated', $widget, [], $actor);

        return $secret;
    }
}
