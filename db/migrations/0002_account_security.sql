-- Account security after QA: forced password change, lockout after repeated failures.

alter table users
  add column must_change_password boolean not null default false,
  add column failed_logins integer not null default 0,
  add column locked_until timestamptz;
