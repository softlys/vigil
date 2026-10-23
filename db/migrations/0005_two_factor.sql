-- Two-factor sign-in (TOTP) with one-time recovery codes.
-- A session created after the password but before the second factor is "pending": it grants nothing
-- until the code is verified, expires after 5 minutes and allows 5 wrong codes.

alter table users
  add column totp_secret text,
  add column totp_enabled boolean not null default false,
  add column totp_last_step bigint,
  add column recovery_codes text[] not null default '{}';

alter table sessions
  add column mfa_pending boolean not null default false,
  add column mfa_attempts integer not null default 0;
