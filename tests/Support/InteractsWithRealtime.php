<?php

namespace Tests\Support;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Realtime\Sockets\SocketTerminator;
use App\Providers\RealtimeServiceProvider;
use Illuminate\Support\Facades\Broadcast;
use Tests\TestCase;

/**
 * Wires the realtime layer into a test: registers `RealtimeServiceProvider` (the orchestrator registers it in
 * `bootstrap/providers.php`; registering twice is a no-op), binds fake attachment URLs, and either
 *   - `recordBroadcasts()` publishes into a `RecordingBroadcaster` (the queue is `sync`, so the whole pipeline runs inline), or
 *   - `useReverbBroadcaster()` configures the real Pusher/Reverb broadcaster with throwaway credentials (signatures, auth responses).
 *
 * @mixin TestCase
 */
trait InteractsWithRealtime
{
    protected const REVERB_KEY = 'test-app-key';

    protected const REVERB_SECRET = 'test-app-secret';

    /** What the application asked Reverb to close (the stale-socket cut-off); nothing is sent to a server. */
    protected RecordingSocketTerminator $sockets;

    protected function useRealtime(): void
    {
        $this->app->register(RealtimeServiceProvider::class);
        $this->app->instance(AttachmentUrls::class, new FakeAttachmentUrls);
        $this->sockets = new RecordingSocketTerminator;
        $this->app->instance(SocketTerminator::class, $this->sockets);
    }

    protected function recordBroadcasts(): RecordingBroadcaster
    {
        $this->useRealtime();

        $broadcaster = new RecordingBroadcaster;

        Broadcast::extend('recording', fn (): RecordingBroadcaster => $broadcaster);
        config(['broadcasting.connections.recording' => ['driver' => 'recording'], 'broadcasting.default' => 'recording']);
        Broadcast::purge('recording');

        return $broadcaster;
    }

    protected function useReverbBroadcaster(): void
    {
        $this->useRealtime();

        config([
            'broadcasting.default' => 'reverb',
            'broadcasting.connections.reverb.key' => self::REVERB_KEY,
            'broadcasting.connections.reverb.secret' => self::REVERB_SECRET,
            'broadcasting.connections.reverb.app_id' => '123456',
            'broadcasting.connections.reverb.options.host' => 'reverb.test',
            'reverb.apps.apps.0.options.host' => 'chat.example.test',
            'reverb.apps.apps.0.options.port' => 443,
            'reverb.apps.apps.0.options.scheme' => 'https',
        ]);
        Broadcast::purge('reverb');

        // The channels register themselves in whichever broadcaster is the default when the application boots (the `null` one in
        // tests): load them again into the Reverb broadcaster that is now the default.
        require base_path('routes/channels.php');
    }

    /**
     * The auth string Pusher / Reverb expect for a channel: `key:hmac_sha256("socket:channel[:channel_data]", secret)`. Every private
     * channel of this application is signed with the principal's tag as its `channel_data` (`{"user_id": <tag>}`, see `SocketTags`).
     */
    protected function expectedChannelAuth(string $socketId, string $channel, ?string $channelData = null): string
    {
        return self::REVERB_KEY.':'.hash_hmac('sha256', $socketId.':'.$channel.($channelData === null ? '' : ':'.$channelData), self::REVERB_SECRET);
    }

    /** The `channel_data` a private channel is signed with for this tag, exactly as the server serialises it. */
    protected function channelDataFor(string $tag): string
    {
        return json_encode(['user_id' => $tag], JSON_THROW_ON_ERROR);
    }
}
