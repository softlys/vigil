-- Failed alert notifications are retried with backoff (audit VG-005) instead of being dropped.

alter table notifications
  add column attempts integer not null default 1,
  add column next_attempt_at timestamptz;

create index notifications_retry_idx on notifications (next_attempt_at) where status = 'failed' and next_attempt_at is not null;
