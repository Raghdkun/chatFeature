<?php

namespace Tests\Unit\Nats;

use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\InvalidCloudEvent;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Tests\Support\Nats\NatsFixtures;

class CloudEventTest extends TestCase
{
    /**
     * The affected user of the first recorded event of every subject (null = the event does not name one).
     *
     * @return array<string, array{string, string|null}>
     */
    public static function userIdByType(): array
    {
        return [
            'user.created (data.user.id)' => ['user.created', '11'],
            'user.updated (data.user_id)' => ['user.updated', '10'],
            'user.deleted' => ['user.deleted', '10'],
            'user.role.assigned' => ['user.role.assigned', '10'],
            'user.role.removed' => ['user.role.removed', '10'],
            'user.role.synced' => ['user.role.synced', '10'],
            'user.permission.granted' => ['user.permission.granted', '10'],
            'user.permission.revoked' => ['user.permission.revoked', '10'],
            'user.permission.synced' => ['user.permission.synced', '10'],
            'permission.created' => ['permission.created', null],
            'permission.updated' => ['permission.updated', null],
            'permission.deleted' => ['permission.deleted', null],
            'role.created' => ['role.created', null],
            'role.updated' => ['role.updated', null],
            'role.deleted' => ['role.deleted', null],
            'store.created' => ['store.created', null],
            'store.updated' => ['store.updated', null],
            'store.deleted' => ['store.deleted', null],
            'assignment.role_permission.assigned' => ['assignment.role_permission.assigned', null],
            'assignment.role_permission.revoked' => ['assignment.role_permission.revoked', null],
            'assignment.role_permission.synced' => ['assignment.role_permission.synced', null],
            'assignment.user_role_store.assigned (data.assignment.user_id)' => ['assignment.user_role_store.assigned', '10'],
            'assignment.user_role_store.toggled' => ['assignment.user_role_store.toggled', '10'],
            'assignment.user_role_store.removed' => ['assignment.user_role_store.removed', '10'],
            'assignment.user_role_store.bulk_assigned' => ['assignment.user_role_store.bulk_assigned', '10'],
            'assignment.role_hierarchy.created' => ['assignment.role_hierarchy.created', null],
            'assignment.role_hierarchy.removed' => ['assignment.role_hierarchy.removed', null],
        ];
    }

    public function test_every_recorded_pizzasys_envelope_parses(): void
    {
        $this->assertCount(34, NatsFixtures::all());

        foreach (NatsFixtures::all() as $envelope) {
            $event = CloudEvent::fromJson(json_encode($envelope, JSON_THROW_ON_ERROR));

            $this->assertSame($envelope['id'], $event->id());
            $this->assertSame($envelope['type'], $event->type());
            $this->assertSame($envelope['subject'], $event->subject());
            $this->assertStringStartsWith('auth.v1.', $event->type());
            $this->assertSame(substr($envelope['type'], strlen('auth.v1.')), $event->name());
        }
    }

    public function test_the_fixture_covers_all_27_subjects(): void
    {
        $this->assertCount(27, NatsFixtures::types());
        $this->assertEqualsCanonicalizing(
            array_map(static fn (array $row): string => 'auth.v1.'.$row[0], array_values(self::userIdByType())),
            NatsFixtures::types(),
        );
    }

    #[DataProvider('userIdByType')]
    public function test_it_extracts_the_affected_user_from_every_real_shape(string $type, ?string $expected): void
    {
        $event = CloudEvent::fromJson(NatsFixtures::json($type));

        $this->assertSame($expected, $event->externalUserId());
    }

    public function test_the_actor_in_meta_is_never_mistaken_for_the_affected_user(): void
    {
        $event = CloudEvent::fromJson(NatsFixtures::json('role.updated'));

        $this->assertNull($event->externalUserId());
        $this->assertSame(2, NatsFixtures::envelope('role.updated')['meta']['actor_user_id']);
    }

    public function test_user_ids_in_changed_fields_are_not_trusted(): void
    {
        $event = CloudEvent::fromJson($this->envelope(['data' => ['changed_fields' => ['user_id' => ['from' => 99, 'to' => 99]]]]));

        $this->assertNull($event->externalUserId());
    }

    /**
     * @return array<string, array{mixed, string|null}>
     */
    public static function userIdValues(): array
    {
        return [
            'int' => [12, '12'],
            'numeric string' => ['12', '12'],
            'opaque string id' => ['usr_9f2', 'usr_9f2'],
            'padded string' => ['  12 ', '12'],
            'zero' => [0, null],
            'negative' => [-3, null],
            'empty string' => ['', null],
            'blank string' => ['   ', null],
            'too long' => [str_repeat('a', 65), null],
            'float' => [12.5, null],
            'bool' => [true, null],
            'array' => [[1], null],
            'null' => [null, null],
        ];
    }

    #[DataProvider('userIdValues')]
    public function test_user_id_values_are_normalised_to_a_string_or_rejected(mixed $value, ?string $expected): void
    {
        $event = CloudEvent::fromJson($this->envelope(['data' => ['user_id' => $value]]));

        $this->assertSame($expected, $event->externalUserId());
    }

    public function test_it_falls_through_the_candidate_paths_in_priority_order(): void
    {
        $nested = CloudEvent::fromJson($this->envelope(['data' => ['user_id' => ['bad'], 'user' => ['id' => 7], 'assignment' => ['user_id' => 8]]]));
        $assignment = CloudEvent::fromJson($this->envelope(['data' => ['assignment' => ['user_id' => 8]]]));
        $first = CloudEvent::fromJson($this->envelope(['data' => ['user_id' => 5, 'user' => ['id' => 7]]]));

        $this->assertSame('7', $nested->externalUserId());
        $this->assertSame('8', $assignment->externalUserId());
        $this->assertSame('5', $first->externalUserId());
    }

    #[DataProvider('invalidBodies')]
    public function test_it_rejects_envelopes_that_are_not_acceptable(string $body, string $reason): void
    {
        try {
            CloudEvent::fromJson($body);
            $this->fail('Expected an InvalidCloudEvent.');
        } catch (InvalidCloudEvent $exception) {
            $this->assertSame($reason, $exception->reason);
            $this->assertSame('Invalid CloudEvent: '.$reason, $exception->getMessage());
            $this->assertStringNotContainsString('SECRET', $exception->getMessage());
        }
    }

    /**
     * @return array<string, array{string, string}>
     */
    public static function invalidBodies(): array
    {
        $valid = ['specversion' => '1.0', 'id' => '01M3TNCWV4NRSSY7H4131KBAZC', 'type' => 'auth.v1.user.deleted', 'data' => ['password' => 'SECRET']];

        return [
            'not json' => ['SECRET {not json', InvalidCloudEvent::NOT_JSON],
            'empty body' => ['', InvalidCloudEvent::NOT_JSON],
            'json null' => ['null', InvalidCloudEvent::NOT_AN_OBJECT],
            'json scalar' => ['"SECRET"', InvalidCloudEvent::NOT_AN_OBJECT],
            'json number' => ['123', InvalidCloudEvent::NOT_AN_OBJECT],
            'json list' => ['[1,2,3]', InvalidCloudEvent::NOT_AN_OBJECT],
            'empty object' => ['{}', InvalidCloudEvent::NOT_AN_OBJECT],
            'unknown specversion' => [json_encode([...$valid, 'specversion' => '0.3']), InvalidCloudEvent::UNSUPPORTED_SPECVERSION],
            'future specversion' => [json_encode([...$valid, 'specversion' => '2.0']), InvalidCloudEvent::UNSUPPORTED_SPECVERSION],
            'numeric specversion' => [json_encode([...$valid, 'specversion' => 1.0]), InvalidCloudEvent::UNSUPPORTED_SPECVERSION],
            'missing specversion' => [json_encode(array_diff_key($valid, ['specversion' => 1])), InvalidCloudEvent::UNSUPPORTED_SPECVERSION],
            'missing id' => [json_encode(array_diff_key($valid, ['id' => 1])), InvalidCloudEvent::MISSING_ID],
            'empty id' => [json_encode([...$valid, 'id' => '  ']), InvalidCloudEvent::MISSING_ID],
            'numeric id' => [json_encode([...$valid, 'id' => 42]), InvalidCloudEvent::MISSING_ID],
            'oversized id' => [json_encode([...$valid, 'id' => str_repeat('A', 129)]), InvalidCloudEvent::MISSING_ID],
            'missing type' => [json_encode(array_diff_key($valid, ['type' => 1])), InvalidCloudEvent::MISSING_TYPE],
            'empty type' => [json_encode([...$valid, 'type' => '']), InvalidCloudEvent::MISSING_TYPE],
            'array type' => [json_encode([...$valid, 'type' => ['auth.v1.user.deleted']]), InvalidCloudEvent::MISSING_TYPE],
            'too large' => [json_encode([...$valid, 'data' => ['blob' => str_repeat('x', CloudEvent::MAX_BYTES)]]), InvalidCloudEvent::TOO_LARGE],
        ];
    }

    public function test_a_missing_or_non_object_data_member_is_tolerated(): void
    {
        foreach ([null, 'text', [1, 2], 5] as $data) {
            $event = CloudEvent::fromJson($this->envelope(['data' => $data]));
            $this->assertNull($event->externalUserId());
        }

        $withoutData = CloudEvent::fromJson(json_encode(['specversion' => '1.0', 'id' => 'A', 'type' => 'auth.v1.role.updated']));
        $this->assertNull($withoutData->externalUserId());
    }

    public function test_type_subject_and_name(): void
    {
        $event = CloudEvent::fromJson($this->envelope(['type' => 'auth.v1.user.role.assigned', 'subject' => 'auth.v1.user.role.assigned']));
        $this->assertSame('auth.v1.user.role.assigned', $event->type());
        $this->assertSame('user.role.assigned', $event->name());

        $noSubject = CloudEvent::fromJson($this->envelope(['type' => 'auth.v1.user.deleted']));
        $this->assertSame('auth.v1.user.deleted', $noSubject->subject());

        $other = CloudEvent::fromJson($this->envelope(['type' => 'auth.v2.user.deleted']));
        $this->assertSame('auth.v2.user.deleted', $other->name());
    }

    public function test_the_dedupe_key_is_the_uppercased_ulid_or_a_stable_26_character_fold(): void
    {
        $ulid = CloudEvent::fromJson($this->envelope(['id' => '01m3tncwv4nrssy7h4131kbazc']));
        $this->assertSame('01M3TNCWV4NRSSY7H4131KBAZC', $ulid->dedupeKey());

        $uuid = CloudEvent::fromJson($this->envelope(['id' => '3f2b8c1e-7d4a-4c55-9a0e-1b2c3d4e5f60']));
        $again = CloudEvent::fromJson($this->envelope(['id' => '3f2b8c1e-7d4a-4c55-9a0e-1b2c3d4e5f60']));
        $other = CloudEvent::fromJson($this->envelope(['id' => '3f2b8c1e-7d4a-4c55-9a0e-1b2c3d4e5f61']));

        $this->assertSame(26, strlen($uuid->dedupeKey()));
        $this->assertSame($uuid->dedupeKey(), $again->dedupeKey());
        $this->assertNotSame($uuid->dedupeKey(), $other->dedupeKey());
        $this->assertMatchesRegularExpression('/^X[0-9A-F]{25}$/', $uuid->dedupeKey());
    }

    public function test_dumping_or_logging_the_event_never_reveals_the_payload(): void
    {
        $event = CloudEvent::fromJson($this->envelope(['data' => ['user_id' => 3, 'changed_fields' => ['password' => ['from' => 'SECRET-HASH']]]]));

        $this->assertStringNotContainsString('SECRET-HASH', print_r($event, true));
        $this->assertStringNotContainsString('SECRET-HASH', json_encode($event->logContext(), JSON_THROW_ON_ERROR));
        $this->assertSame(['event_id', 'type'], array_keys($event->logContext()));
    }

    /**
     * @param  array<string, mixed>  $overrides
     */
    private function envelope(array $overrides = []): string
    {
        return json_encode(array_replace(['specversion' => '1.0', 'id' => '01M3TNCWV4NRSSY7H4131KBAZC', 'type' => 'auth.v1.user.updated', 'data' => []], $overrides), JSON_THROW_ON_ERROR);
    }
}
