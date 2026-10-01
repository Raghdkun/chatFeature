<?php

namespace App\Domain\Widgets\Data;

/**
 * The visitor-facing strings of a widget (`config.texts.<locale>`).
 *
 * Lookup order for any key: the requested locale, the widget's default locale, then these built-in English strings.
 */
final class WidgetTexts
{
    /** @var array<string, string> */
    public const ENGLISH = [
        'title' => 'Support',
        'subtitle' => 'We usually reply in a few minutes',
        'welcome' => 'Hi! How can we help you today?',
        'categoryPrompt' => 'What do you need help with?',
        'connecting' => 'Connecting you to an agent…',
        'noAgents' => 'No agent is available right now.',
        'offlineTitle' => 'Leave us a message',
        'offlineBody' => "We'll get back to you by email.",
        'placeholder' => 'Type your message…',
        'send' => 'Send',
        'attach' => 'Attach image',
        'endChat' => 'End chat',
        'ratingTitle' => 'How was this chat?',
        'ratingPlaceholder' => 'Add a comment (optional)',
        'thanks' => 'Thanks for your feedback!',
        'startNewChat' => 'Start a new chat',
        'poweredBy' => 'Powered by PNE Chat',
    ];

    /**
     * @return list<string>
     */
    public static function keys(): array
    {
        return array_keys(self::ENGLISH);
    }
}
