<?php

namespace App\Http\Requests\Settings;

use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Laravel\Fortify\InteractsWithTwoFactorState;

class TwoFactorAuthenticationRequest extends FormRequest
{
    use InteractsWithTwoFactorState;

    /**
     * Get the validation rules that apply to the request.
     *
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [];
    }

    /** How long a started setup (QR code shown, code not confirmed yet) is kept when the Security page is loaded again. */
    private const CONFIRMATION_WINDOW_SECONDS = 900;

    /**
     * Fortify decides that a confirmation was abandoned when the Security page loads again in another second without the code in the old
     * input. The code is never flashed back (`bootstrap/app.php` `dontFlash`: it is a credential), so the page that follows a WRONG code
     * looked like an abandoned setup: it deleted the pending secret, and the right code could never work (the authenticator held a dead
     * key). A setup is abandoned when it has been left alone for a while; an unconfirmed secret enforces nothing at sign-in meanwhile.
     */
    protected function neverFinishedConfirmingTwoFactorAuthentication(int $currentTime): bool
    {
        return $this->user()->two_factor_confirmed_at === null
            && $currentTime - (int) $this->session()->get('two_factor_confirming_at', 0) > self::CONFIRMATION_WINDOW_SECONDS;
    }
}
