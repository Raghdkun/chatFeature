<?php

namespace Tests\Support;

use App\Domain\Visitors\VisitorTokenService;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationEvent;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\RealtimeGrant;
use App\Models\User;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\Widget;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * A visitor with everything the application can hold about them: sessions, closed conversations with messages, attachments (with real files
 * on the fake disk), a rating, timeline events, offers, a recorded socket subscription and an offline ticket. For the privacy tests.
 *
 * @mixin TestCase
 */
trait PrivacyWorld
{
    /**
     * @param  array<string, mixed>  $visitor
     * @return array{visitor: Visitor, conversations: list<Conversation>, files: list<string>, session: VisitorSession}
     */
    protected function visitorWithHistory(Widget $widget, Category $category, array $visitor = [], int $conversations = 2, ?User $agent = null): array
    {
        $person = Visitor::factory()->create(['widget_id' => $widget->id] + $visitor);
        $issued = app(VisitorTokenService::class)->issue($person);
        $agent ??= User::query()->where('email', 'agent.smith@secret.example')->first() ?? User::factory()->agent()->create(['name' => 'Agent Smith', 'email' => 'agent.smith@secret.example']);
        $made = [];
        $files = [];

        for ($i = 0; $i < $conversations; $i++) {
            $conversation = Conversation::factory()->forCategory($category)->closed($agent)->create([
                'widget_id' => $widget->id, 'visitor_id' => $person->id, 'visitor_session_id' => $issued->session->id, 'closed_at' => now()->subDays(40 + $i),
            ]);
            $conversation->forceFill(['created_at' => now()->subDays(41 + $i)])->saveQuietly();

            foreach ([1, 2, 3] as $seq) {
                $message = Message::factory()->for($conversation)->create(['seq' => $seq, 'sender_type' => $seq === 2 ? 'agent' : 'visitor', 'sender_user_id' => $seq === 2 ? $agent->id : null, 'body' => 'private words '.$person->ulid.' '.$seq]);

                if ($seq === 1) {
                    $path = 'chat/attachments/2026/10/'.strtolower($person->ulid).$i.'.png';
                    $thumb = 'chat/attachments/2026/10/'.strtolower($person->ulid).$i.'_t.png';
                    Storage::disk('local')->put($path, 'png-bytes');
                    Storage::disk('local')->put($thumb, 'thumb-bytes');
                    Attachment::factory()->create(['conversation_id' => $conversation->id, 'message_id' => $message->id, 'path' => $path, 'thumb_path' => $thumb, 'mime' => 'image/png', 'original_name' => 'receipt-of-'.$person->ulid.'.png']);
                    array_push($files, $path, $thumb);
                }
            }

            Rating::factory()->create(['conversation_id' => $conversation->id, 'score' => 5, 'comment' => 'Great help, '.$person->ulid]);
            ConversationEvent::factory()->create(['conversation_id' => $conversation->id, 'type' => 'created', 'actor_type' => 'visitor', 'actor_id' => $person->id]);
            ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $agent->id]);
            RealtimeGrant::query()->create(['user_id' => $agent->id, 'conversation_id' => $conversation->id, 'granted_at' => now()]);
            $made[] = $conversation;
        }

        $ticket = Conversation::factory()->forCategory($category)->offline()->create([
            'widget_id' => $widget->id, 'visitor_id' => $person->id, 'visitor_session_id' => null, 'status' => 'closed', 'closed_at' => now()->subDays(50),
        ]);
        Message::factory()->for($ticket)->create(['seq' => 1, 'body' => 'offline form text '.$person->ulid]);
        $made[] = $ticket;

        return ['visitor' => $person, 'conversations' => $made, 'files' => $files, 'session' => $issued->session];
    }
}
