-- Bookings and technical blocks share the atomic occupied-time insert.
-- Block descriptions are internal reasons and must never be returned publicly.
ALTER TABLE reservations ADD COLUMN kind TEXT NOT NULL DEFAULT 'booking'
  CHECK (kind IN ('booking', 'block'));
