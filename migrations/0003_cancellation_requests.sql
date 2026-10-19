-- Requests preserve history; deleting a referenced reservation is prohibited.
-- Audit timestamps are UTC Unix seconds.
CREATE TABLE cancellation_requests (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  -- SQLite counts Unicode characters; the API enforces 10–1000 UTF-16 units.
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at >= 0),
  reviewed_at INTEGER,
  CHECK (
    (status = 'pending' AND reviewed_at IS NULL) OR
    (status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL AND reviewed_at >= created_at)
  )
) STRICT;

CREATE UNIQUE INDEX cancellation_requests_one_pending
  ON cancellation_requests (reservation_id) WHERE status = 'pending';
CREATE INDEX cancellation_requests_reservation ON cancellation_requests (reservation_id);
