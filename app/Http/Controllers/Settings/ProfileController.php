<?php

namespace App\Http\Controllers\Settings;

use App\Domain\Chat\Actions\RequeueAgentConversations;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Http\Controllers\Controller;
use App\Http\Requests\Settings\ProfileDeleteRequest;
use App\Http\Requests\Settings\ProfileUpdateRequest;
use App\Models\User;
use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

class ProfileController extends Controller
{
    /**
     * Show the user's profile settings page.
     */
    public function edit(Request $request): Response
    {
        return Inertia::render('settings/profile', [
            'mustVerifyEmail' => $request->user() instanceof MustVerifyEmail,
            'status' => $request->session()->get('status'),
        ]);
    }

    /**
     * Update the user's profile information.
     */
    public function update(ProfileUpdateRequest $request): RedirectResponse
    {
        $request->user()->fill($request->validated());

        if ($request->user()->isDirty('email')) {
            $request->user()->email_verified_at = null;
        }

        $request->user()->save();

        Inertia::flash('toast', ['type' => 'success', 'message' => __('Profile updated.')]);

        return to_route('profile.edit');
    }

    /**
     * Delete the user's profile.
     */
    public function destroy(ProfileDeleteRequest $request): RedirectResponse
    {
        $user = $request->user();

        // The wizard is gone after the install: with no administrator left nobody could sign in to repair anything but the CLI.
        if ($user->is_admin && ! User::query()->where('is_admin', true)->where('is_active', true)->whereKeyNot($user->getKey())->exists()) {
            throw ValidationException::withMessages([
                'password' => __('You are the only administrator, so this account cannot be deleted. Make someone else an administrator first.'),
            ]);
        }

        // The chats this person was handling go back to the queue first, as when they are deactivated: with the account gone they would
        // stay `active` with nobody assigned (and the visitor looking at a deleted agent) until the idle timer closes them.
        app(RequeueAgentConversations::class)->handle($user, SessionRevokeReason::Deactivated->value);

        Auth::logout();

        $user->delete();

        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect('/');
    }
}
