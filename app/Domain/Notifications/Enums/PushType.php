<?php

namespace App\Domain\Notifications\Enums;

/**
 * What a push is about. `Dismiss` is the silent one: it carries no text, the service worker closes the notification with the same tag.
 */
enum PushType: string
{
    /** A new chat request offered to an agent. */
    case Offer = 'offer';
    /** A visitor message in a chat assigned to the agent. */
    case Message = 'message';
    /** Close the notification with this tag (the offer was taken, cancelled or expired; the messages were read). */
    case Dismiss = 'dismiss';
    /** "Send a test notification" on the settings page. */
    case Test = 'test';
}
