<?php

namespace App\Mail;

use App\Domain\Chat\Services\MessageText;
use App\Models\Conversation;
use App\Models\Message;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/**
 * A staff reply to an offline ticket, e-mailed to the visitor who left the message (queued, plain text; decision P4-D2).
 * The SMTP settings are the administrator's to configure; without them the queue worker reports the failure and the reply
 * stays in the conversation.
 */
class OfflineTicketReply extends Mailable implements ShouldQueue
{
    use Queueable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly Message $reply,
    ) {
        $this->afterCommit();
    }

    public function envelope(): Envelope
    {
        return new Envelope(subject: __('Re: your message (ticket :ticket)', ['ticket' => $this->conversation->ticket_no]));
    }

    public function content(): Content
    {
        return new Content(
            text: 'chat.offline_reply',
            with: [
                // One line whatever is stored (rows older than the model's own cleaning): a name must not add lines to the mail.
                'visitorName' => MessageText::singleLine($this->conversation->visitor->name),
                'agentName' => $this->reply->senderUser?->public_label,
                'ticketNo' => $this->conversation->ticket_no,
                'body' => (string) $this->reply->body,
                'widgetName' => $this->conversation->widget->name,
            ],
        );
    }
}
