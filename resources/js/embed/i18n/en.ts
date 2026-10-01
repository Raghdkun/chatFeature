/**
 * Built-in English strings of the chat panel. The first block holds the keys an admin can override per locale in the widget builder
 * (`WidgetTexts::keys()`, docs/contracts/widget-config.md); the rest is panel chrome that has no builder field.
 *
 * Why not `lang/en.json`: that file carries the whole dashboard (about 16 KB gzip) and the iframe bundle has to stay lean, so the
 * panel keeps its own table under the same `embed.chat.*` naming. `:name` style placeholders, as everywhere else.
 */
export const EN = {
    /* Admin-editable texts (defaults, overridden by the widget config). */
    title: 'Support',
    subtitle: 'We usually reply in a few minutes',
    welcome: 'Hi! How can we help you today?',
    categoryPrompt: 'What do you need help with?',
    connecting: 'Connecting you to an agent…',
    noAgents: 'No agent is available right now.',
    offlineTitle: 'Leave us a message',
    offlineBody: "We'll get back to you by email.",
    placeholder: 'Type your message…',
    send: 'Send',
    attach: 'Attach image',
    endChat: 'End chat',
    ratingTitle: 'How was this chat?',
    ratingPlaceholder: 'Add a comment (optional)',
    thanks: 'Thanks for your feedback!',
    startNewChat: 'Start a new chat',
    poweredBy: 'Powered by PNE Chat',
    closeChat: 'Close chat',
    unread: 'unread messages',
    dismiss: 'Dismiss',

    /* Panel chrome. */
    'embed.chat.loading': 'Loading chat…',
    'embed.chat.back': 'Back',
    'embed.chat.idle.start': 'Start chat',
    'embed.chat.prechat.title': 'Before we start',
    'embed.chat.prechat.submit': 'Start chat',
    'embed.chat.prechat.consent_required': 'Please accept to continue.',
    'embed.chat.field.name': 'Your name',
    'embed.chat.field.email': 'Email',
    'embed.chat.field.phone': 'Phone',
    'embed.chat.field.message': 'Message',
    'embed.chat.field.topic': 'Topic',
    'embed.chat.field.optional': '(optional)',
    'embed.chat.field.error.required': 'This field is required.',
    'embed.chat.field.error.email': 'Enter a valid email address.',
    'embed.chat.field.error.phone': 'Enter a valid phone number.',
    'embed.chat.field.error.too_long': 'This is too long.',
    'embed.chat.category.online': 'Online',
    'embed.chat.category.offline': 'Offline: leave a message',
    'embed.chat.queued.waiting': 'Waiting :time',
    'embed.chat.queued.hint':
        "Keep this window open. We'll connect you as soon as someone is free.",
    'embed.chat.queued.transferred': 'Connecting you to another agent…',
    'embed.chat.queued.cancel': 'Cancel',
    'embed.chat.active.agent_fallback': 'Support',
    'embed.chat.active.log_label': 'Conversation',
    'embed.chat.active.typing': ':name is typing…',
    'embed.chat.active.new_messages': 'New messages',
    'embed.chat.composer.label': 'Message',
    'embed.chat.composer.remove_attachment': 'Remove image',
    'embed.chat.composer.uploading': 'Uploading…',
    'embed.chat.composer.upload_failed': 'Upload failed',
    'embed.chat.composer.too_big': 'Images must be :size or smaller.',
    'embed.chat.composer.bad_type':
        'Only JPEG, PNG, WebP and GIF images can be sent.',
    'embed.chat.composer.too_many': 'You can attach up to :count images.',
    'embed.chat.composer.rejected':
        "That image can't be sent. Try a smaller JPEG, PNG, WebP or GIF.",
    'embed.chat.composer.disabled': "Images can't be sent in this chat.",
    'embed.chat.composer.rate_limited':
        'Too many uploads. Wait a moment and try again.',
    'embed.chat.message.you': 'You',
    'embed.chat.message.sending': 'Sending',
    'embed.chat.message.sent': 'Sent',
    'embed.chat.message.delivered': 'Delivered',
    'embed.chat.message.seen': 'Seen',
    'embed.chat.message.failed': 'Not sent. Tap to retry.',
    'embed.chat.message.retry': 'Retry',
    'embed.chat.message.discard': 'Delete',
    'embed.chat.message.image_alt': 'Image from :name',
    'embed.chat.lightbox.close': 'Close image',
    'embed.chat.end.title': 'End this chat?',
    'embed.chat.end.body': 'You can start a new chat any time.',
    'embed.chat.end.keep': 'Keep chatting',
    'embed.chat.rating.star': 'Rate :count out of 5',
    'embed.chat.rating.submit': 'Send feedback',
    'embed.chat.rating.skip': 'Skip',
    'embed.chat.rating.comment_label': 'Comment',
    'embed.chat.rating.required': 'Choose a rating, or skip.',
    'embed.chat.offline.next_open': "We're back :time.",
    'embed.chat.offline.missed':
        'Nobody was free to take your chat. Leave a message and we will get back to you.',
    'embed.chat.offline.submit': 'Send message',
    'embed.chat.offline.sent_title': 'Message sent',
    'embed.chat.offline.sent_body':
        "We'll reply to :email. Your ticket number is :ticket.",
    'embed.chat.closed.title': 'Chat closed',
    'embed.chat.closed.idle':
        'This chat was closed because it had been quiet for a while.',
    'embed.chat.closed.cancelled': 'You cancelled the chat.',
    'embed.chat.closed.ended': 'This chat has ended.',
    'embed.chat.closed.expired':
        'Your session expired. Start a new chat to continue.',
    'embed.chat.status.reconnecting': 'Reconnecting…',
    'embed.chat.error.generic': 'Something went wrong. Please try again.',
    'embed.chat.error.network':
        "We can't reach the server. Check your connection and try again.",
    'embed.chat.error.rate_limited':
        'Too many attempts. Try again in :seconds seconds.',
    'embed.chat.error.unavailable': 'Chat is not available right now.',
    'embed.chat.error.identity':
        "We couldn't verify your sign-in. Reload the page and try again.",
    'embed.chat.error.feature_disabled': "That isn't available in this chat.",
    'embed.chat.whatsapp.title': 'Continue on WhatsApp',
} as const;

export type MessageKey = keyof typeof EN;
export type Messages = Partial<Record<MessageKey, string>>;

/** The keys the widget builder lets an admin override. */
export const WIDGET_TEXT_KEYS = [
    'title',
    'subtitle',
    'welcome',
    'categoryPrompt',
    'connecting',
    'noAgents',
    'offlineTitle',
    'offlineBody',
    'placeholder',
    'send',
    'attach',
    'endChat',
    'ratingTitle',
    'ratingPlaceholder',
    'thanks',
    'startNewChat',
    'poweredBy',
    'closeChat',
    'unread',
    'dismiss',
] as const satisfies readonly MessageKey[];
