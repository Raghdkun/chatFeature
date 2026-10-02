/**
 * The local Redis, for the scenarios whose presence store is Redis (`redisDb` in scenarios.ts): database index 13 and one key prefix per
 * instance (`e2e-p5-<port>-`). The suite only ever lists and deletes keys under ITS prefix: never FLUSHALL, never FLUSHDB, never another
 * index. It talks to Redis through the `redis-cli` binary (override with E2E_REDIS_CLI), which keeps the suite free of a Redis client
 * dependency; a machine without Redis (or without the binary) skips the specs that need it (`redisAvailable()`).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Instance } from './scenarios';

const run = promisify(execFile);
const CLI = process.env.E2E_REDIS_CLI ?? 'redis-cli';
const HOST = process.env.E2E_REDIS_HOST ?? '127.0.0.1';
const PORT = process.env.E2E_REDIS_PORT ?? '6379';

async function cli(db: number, args: string[]): Promise<string> {
    const { stdout } = await run(
        CLI,
        ['-h', HOST, '-p', PORT, '-n', String(db), ...args],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );

    return stdout;
}

/** Whether a Redis answers PING on the machine (and `redis-cli` exists). */
export async function redisAvailable(): Promise<boolean> {
    try {
        return (await cli(0, ['PING'])).trim() === 'PONG';
    } catch {
        return false;
    }
}

function owned(instance: Instance): { db: number; prefix: string } {
    if (instance.redis === null) {
        throw new Error(`Scenario ${instance.key} does not use Redis.`);
    }

    if (!instance.redis.prefix.startsWith('e2e-p5-')) {
        throw new Error(
            `Refusing to touch Redis keys outside the suite's prefix: ${instance.redis.prefix}`,
        );
    }

    return instance.redis;
}

/** Every key of this instance (its prefix only), sorted. Prefixes are literal text: no glob characters in them. */
export async function redisKeys(instance: Instance): Promise<string[]> {
    const { db, prefix } = owned(instance);
    const out = await cli(db, ['--scan', '--pattern', `${prefix}*`]);

    return out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .sort();
}

/** The hash `presence:<userId>` of this instance, as a plain object (empty when there is none). */
export async function redisPresenceHash(
    instance: Instance,
    userId: number,
    presencePrefix = 'presence:',
): Promise<Record<string, string>> {
    const { db, prefix } = owned(instance);
    const out = await cli(db, [
        'HGETALL',
        `${prefix}${presencePrefix}${userId}`,
    ]);
    const lines = out.split('\n').filter((line) => line !== '');
    const hash: Record<string, string> = {};

    for (let index = 0; index + 1 < lines.length; index += 2) {
        hash[lines[index]] = lines[index + 1];
    }

    return hash;
}

/** The remaining life of `presence:<userId>` in seconds (-2: no such key, -1: no expiry). */
export async function redisPresenceTtl(
    instance: Instance,
    userId: number,
): Promise<number> {
    const { db, prefix } = owned(instance);

    return Number(
        (await cli(db, ['TTL', `${prefix}presence:${userId}`])).trim(),
    );
}

/** Whether the user is in the `presence:alive` set (and its score, the last heartbeat, when they are). */
export async function redisAliveScore(
    instance: Instance,
    userId: number,
): Promise<number | null> {
    const { db, prefix } = owned(instance);
    const out = (
        await cli(db, ['ZSCORE', `${prefix}presence:alive`, String(userId)])
    ).trim();

    return out === '' ? null : Number(out);
}

/** Deletes this instance's keys (its prefix only). Never throws: a missing Redis means there is nothing to clean. */
export async function cleanRedis(instance: Instance): Promise<number> {
    if (instance.redis === null) {
        return 0;
    }

    try {
        const { db } = owned(instance);
        const keys = await redisKeys(instance);

        for (let index = 0; index < keys.length; index += 100) {
            await cli(db, ['DEL', ...keys.slice(index, index + 100)]);
        }

        return keys.length;
    } catch {
        return 0;
    }
}
