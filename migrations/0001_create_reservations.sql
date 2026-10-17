-- date/start_time/end_time are civil values in Europe/Kyiv, not UTC.
-- Reservations stay within one day; both endpoints use 30-minute boundaries.
-- Audit timestamps are UTC Unix seconds. Future writes must set updated_at.
CREATE TABLE reservations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  date TEXT NOT NULL CHECK (
    date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(date, '+0 days') IS date
  ),
  start_time TEXT NOT NULL CHECK (
    start_time GLOB '[0-2][0-9]:[03]0' AND start_time <= '23:30'
  ),
  end_time TEXT NOT NULL CHECK (
    end_time GLOB '[0-2][0-9]:[03]0' AND end_time <= '23:30'
  ),
  name_or_apartment TEXT NOT NULL CHECK (length(trim(name_or_apartment)) > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at >= created_at),
  CHECK (end_time > start_time)
) STRICT;

-- Future daily availability/list queries can filter by date and status.
CREATE INDEX reservations_date_status_start_time
  ON reservations (date, status, start_time);
