<?php

namespace Tests\Unit\Chat;

use App\Domain\Chat\Services\GifFrameCounter;
use PHPUnit\Framework\TestCase;
use Tests\Support\Gifs;

class GifFrameCounterTest extends TestCase
{
    public function test_it_counts_the_frames_without_decoding(): void
    {
        $counter = new GifFrameCounter;

        $this->assertSame(1, $counter->count(Gifs::still()));
        $this->assertSame(7, $counter->count(Gifs::animated(64, 7), stopAfter: 100));
        // A huge canvas costs nothing to walk: only blocks are read.
        $this->assertSame(3, $counter->count(Gifs::animated(3000, 3), stopAfter: 100));
    }

    public function test_it_stops_as_soon_as_the_limit_is_reached(): void
    {
        $this->assertSame(2, (new GifFrameCounter)->count(Gifs::animated(32, 50)));
    }

    public function test_it_survives_malformed_input(): void
    {
        $counter = new GifFrameCounter;
        $gif = Gifs::animated(32, 4);

        $this->assertSame(0, $counter->count(''));
        $this->assertSame(0, $counter->count('not a gif at all'));
        $this->assertSame(0, $counter->count("GIF89a\x01"));
        $this->assertLessThanOrEqual(4, $counter->count(substr($gif, 0, intdiv(strlen($gif), 2)), 100));
        // Garbage after the header ends the walk.
        $this->assertSame(0, $counter->count(substr($gif, 0, 13).str_repeat("\xFF", 64)));
        // An unterminated sub-block run does not loop.
        $this->assertSame(0, $counter->count(substr($gif, 0, 13)."\x21\xF9\xFF".str_repeat("\xFF", 300)));
    }
}
