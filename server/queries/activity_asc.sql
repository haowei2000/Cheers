SELECT event_type AS "event_type!", channel_seq AS "channel_seq!", created_at AS "created_at!", payload AS "payload!"
        FROM (
            SELECT
                'message'::text AS event_type,
                m.channel_seq,
                m.created_at,
                jsonb_build_object(
                    'v', 1,
                    'msg_id', m.msg_id,
                    'channel_id', m.channel_id,
                    'channel_seq', m.channel_seq,
                    'sender_type', m.sender_type,
                    'sender_id', m.sender_id,
                    'content', m.content,
                    'msg_type', m.msg_type,
                    'is_partial', m.is_partial,
                    'reply_to_msg_id', m.in_reply_to_msg_id,
                    'file_ids', COALESCE(m.file_ids, '[]'::jsonb),
                    'mentions', COALESCE(mm.mentions, '[]'::jsonb),
                    'created_at', m.created_at
                ) AS payload
            FROM messages m
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'member_id', member_id,
                        'member_type', member_type
                    )
                    ORDER BY member_type, member_id
                ) AS mentions
                FROM message_mentions
                WHERE msg_id = m.msg_id
            ) mm ON TRUE
            WHERE m.channel_id = $1
              AND m.channel_seq IS NOT NULL
              AND m.channel_seq > $2
              AND m.is_partial = FALSE

            UNION ALL

            SELECT
                'operation'::text AS event_type,
                o.channel_seq,
                o.created_at,
                jsonb_build_object(
                    'op_id', o.id,
                    'channel_id', o.channel_id,
                    'channel_seq', o.channel_seq,
                    'op_type', o.op_type,
                    'actor_type', o.actor_type,
                    'actor_id', o.actor_id,
                    'target_ref', o.target_ref,
                    'payload', COALESCE(o.payload, '{}'::jsonb),
                    'created_at', o.created_at
                ) AS payload
            FROM channel_operations o
            WHERE o.channel_id = $1
              AND o.channel_seq > $2

            UNION ALL

            SELECT
                'voice_transcript_final'::text AS event_type,
                t.channel_seq,
                t.created_at,
                jsonb_build_object(
                    'segment_id', t.segment_id,
                    'voice_session_id', t.voice_session_id,
                    'channel_id', t.channel_id,
                    'channel_seq', t.channel_seq,
                    'user_id', t.user_id,
                    'provider_segment_id', t.provider_segment_id,
                    'track_id', t.track_id,
                    'text', t.text,
                    'started_at_ms', t.started_at_ms,
                    'ended_at_ms', t.ended_at_ms,
                    'language', t.language,
                    'confidence', t.confidence,
                    'supersedes_segment_id', t.supersedes_segment_id,
                    'finalized_at', t.finalized_at,
                    'created_at', t.created_at
                ) AS payload
            FROM voice_transcript_segments t
            WHERE t.channel_id = $1
              AND t.channel_seq > $2

            UNION ALL

            SELECT
                'task_claim_evaluation'::text AS event_type,
                e.source_seq_to AS channel_seq,
                e.reserved_at AS created_at,
                jsonb_build_object(
                    'evaluation_id', e.evaluation_id,
                    'channel_id', e.channel_id,
                    'bot_id', e.bot_id,
                    'source_seq_from', e.source_seq_from,
                    'source_seq_to', e.source_seq_to,
                    'status', e.status,
                    'error', e.error,
                    'created_at', e.reserved_at
                ) AS payload
            FROM task_claim_evaluations e
            WHERE e.channel_id = $1
              AND e.source_seq_to > $2
        ) events
        ORDER BY channel_seq ASC
        LIMIT $3
