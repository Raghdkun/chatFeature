<?php

namespace Tests\Support;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Domain\Visitors\VisitorTokenService;
use App\Models\AgentPresence;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Http\UploadedFile;
use Tests\TestCase;

/**
 * Helpers of the chat feature tests: an always-open widget, agents who are reachable, visitors with a token, and image uploads.
 *
 * @mixin TestCase
 */
trait ChatFixtures
{
    use WidgetFixtures;

    public const CUSTOMER_ORIGIN = 'https://customer.test';

    /**
     * An enabled, always-open widget with one active category (`billing` unless another slug is given).
     *
     * @param  array<string, mixed>  $attributes
     * @return array{0: Widget, 1: Category}
     */
    protected function chatWidget(array $attributes = [], string $slug = 'billing'): array
    {
        $category = Category::factory()->create(['slug' => $slug, 'name' => ucfirst($slug)]);
        $widget = $this->enabledWidget(['customer.test'], $attributes + ['offline_mode' => 'always_online'], $category);

        return [$widget, $category];
    }

    /**
     * An agent who serves the category and is reachable right now.
     *
     * @param  array<string, mixed>  $attributes
     */
    protected function availableAgent(Category $category, array $attributes = [], PresenceStatus $status = PresenceStatus::Online): User
    {
        $agent = User::factory()->agent()->create($attributes);
        $category->users()->attach($agent->id);
        $this->setPresence($agent, $status);

        return $agent;
    }

    protected function setPresence(User $user, PresenceStatus $status, ?int $heartbeatSecondsAgo = 0): void
    {
        AgentPresence::query()->updateOrCreate(['user_id' => $user->id], [
            'status' => $status,
            'last_seen_at' => now(),
            'last_heartbeat_at' => $heartbeatSecondsAgo === null ? null : now()->subSeconds($heartbeatSecondsAgo),
        ]);
    }

    /**
     * A visitor (anonymous unless attributes say otherwise) with a live session token for the widget.
     *
     * @param  array<string, mixed>  $visitorAttributes
     */
    protected function visitorSession(Widget $widget, array $visitorAttributes = []): IssuedVisitorToken
    {
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id] + $visitorAttributes);

        return app(VisitorTokenService::class)->issue($visitor);
    }

    /**
     * A queued live chat of the token's session, offered to the agents (an open offer each).
     *
     * @param  list<User>  $offeredTo
     * @param  array<string, mixed>  $attributes
     */
    protected function queuedChat(IssuedVisitorToken $token, Category $category, array $offeredTo = [], array $attributes = []): Conversation
    {
        $conversation = Conversation::factory()->forCategory($category)->create([
            'widget_id' => $token->session->widget_id,
            'visitor_id' => $token->session->visitor_id,
            'visitor_session_id' => $token->session->id,
        ] + $attributes);

        foreach ($offeredTo as $agent) {
            ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $agent->id, 'expires_at' => now()->addSeconds(90)]);
        }

        return $conversation;
    }

    /**
     * An active chat of the token's session, handled by `$agent`.
     *
     * @param  array<string, mixed>  $attributes
     */
    protected function activeChat(IssuedVisitorToken $token, Category $category, User $agent, array $attributes = []): Conversation
    {
        return Conversation::factory()->forCategory($category)->active($agent)->create([
            'widget_id' => $token->session->widget_id,
            'visitor_id' => $token->session->visitor_id,
            'visitor_session_id' => $token->session->id,
        ] + $attributes);
    }

    /**
     * @return array<string, string>
     */
    protected function bearer(IssuedVisitorToken $token): array
    {
        return ['Authorization' => 'Bearer '.$token->plaintext];
    }

    /** A real PNG of the given size (no EXIF), as an upload. */
    protected function pngUpload(string $name = 'photo.png', int $width = 40, int $height = 30): UploadedFile
    {
        $image = imagecreatetruecolor($width, $height);
        imagefilledrectangle($image, 0, 0, $width - 1, $height - 1, (int) imagecolorallocate($image, 200, 60, 60));
        ob_start();
        imagepng($image);
        $bytes = (string) ob_get_clean();

        return UploadedFile::fake()->createWithContent($name, $bytes);
    }

    /** A real JPEG carrying an EXIF (APP1) block with a recognisable marker. */
    protected function jpegWithExif(string $marker = 'SECRET-GPS-MARKER', string $name = 'photo.jpg'): UploadedFile
    {
        $image = imagecreatetruecolor(32, 24);
        ob_start();
        imagejpeg($image, null, 90);
        $jpeg = (string) ob_get_clean();

        $exif = "Exif\0\0".'MM'."\x00\x2A\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00".$marker;
        $segment = "\xFF\xE1".pack('n', strlen($exif) + 2).$exif;

        return UploadedFile::fake()->createWithContent($name, substr($jpeg, 0, 2).$segment.substr($jpeg, 2));
    }
}
