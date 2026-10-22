-- Failed sign-ins for emails that have no account, tracked exactly like users.failed_logins and
-- users.locked_until, so lockout timing and delays do not reveal which accounts exist.

create table login_failures (
  email text primary key,
  failures integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
