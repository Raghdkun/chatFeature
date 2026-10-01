<?php

namespace App\Auth\Pizzasys;

use App\Auth\Pizzasys\Actions\EnvironmentInput;
use App\Models\AuthEnvironment;

/**
 * "Never reuse a stored secret for a new destination."
 *
 * The service token and the NATS token are write-only: an edit that leaves them out keeps the stored ones. That is only
 * safe while the secret keeps going to the place it was given for. Changing the portal address, the service name, the
 * NATS address, or switching certificate verification off would otherwise let an administrator (or a stolen admin
 * session) point the stored token at a server they control and read it off the wire. So whenever one of those changes,
 * the matching secret has to be submitted again.
 *
 * Pure function over plain arrays so the Settings form, the setup wizard, the CLI and the action that persists the
 * change all apply exactly the same rule.
 */
final class SecretReentry
{
    public const SERVICE_TOKEN = 'service_token';

    public const NATS_TOKEN = 'nats_token';

    /**
     * @param  array{base_url: string|null, service_name: string|null, nats_url: string|null, verify_tls: bool, has_service_token: bool, has_nats_token: bool}  $stored  What is saved now.
     * @param  array{base_url: string, service_name: string, nats_url: string|null, verify_tls: bool, service_token_given: bool, nats_token_given: bool}  $submitted  What is being saved. A NATS token counts as given when it was typed OR explicitly cleared.
     * @return array{service_token?: string, nats_token?: string} Field => message, empty when nothing has to be re-entered.
     */
    public static function missing(array $stored, array $submitted): array
    {
        $missing = [];

        $addressChanged = self::normalise($stored['base_url']) !== self::normalise($submitted['base_url']);
        $nameChanged = self::normalise($stored['service_name']) !== self::normalise($submitted['service_name']);
        $verificationOff = $stored['verify_tls'] && ! $submitted['verify_tls'];

        if ($stored['has_service_token'] && ! $submitted['service_token_given']) {
            if ($addressChanged) {
                $missing[self::SERVICE_TOKEN] = __('Re-enter the service token to change the portal address.');
            } elseif ($nameChanged) {
                $missing[self::SERVICE_TOKEN] = __('Re-enter the service token to change the service name.');
            } elseif ($verificationOff) {
                $missing[self::SERVICE_TOKEN] = __('Re-enter the service token to turn off certificate verification.');
            }
        }

        $natsUrl = self::normalise($submitted['nats_url']);
        $natsAddressChanged = $natsUrl !== '' && $natsUrl !== self::normalise($stored['nats_url']);

        if ($natsUrl !== '' && $stored['has_nats_token'] && ! $submitted['nats_token_given']) {
            if ($natsAddressChanged) {
                $missing[self::NATS_TOKEN] = __('Re-enter the NATS token to change the NATS address.');
            } elseif ($verificationOff) {
                $missing[self::NATS_TOKEN] = __('Re-enter the NATS token to turn off certificate verification.');
            }
        }

        return $missing;
    }

    /**
     * The same rule for a saved environment and a submitted {@see EnvironmentInput}.
     *
     * @return array{service_token?: string, nats_token?: string}
     */
    public static function missingForEnvironment(AuthEnvironment $stored, EnvironmentInput $input): array
    {
        return self::missing(
            [
                'base_url' => $stored->base_url,
                'service_name' => $stored->service_name,
                'nats_url' => $stored->nats_url,
                'verify_tls' => $stored->verify_tls,
                'has_service_token' => $stored->hasServiceToken(),
                'has_nats_token' => $stored->hasNatsToken(),
            ],
            [
                'base_url' => $input->baseUrl,
                'service_name' => $input->serviceName,
                'nats_url' => $input->natsUrl,
                'verify_tls' => $input->verifyTls ?? $stored->verify_tls,
                'service_token_given' => $input->hasServiceToken(),
                'nats_token_given' => $input->natsTokenGiven,
            ],
        );
    }

    private static function normalise(?string $value): string
    {
        return strtolower(rtrim(trim((string) $value), '/'));
    }
}
