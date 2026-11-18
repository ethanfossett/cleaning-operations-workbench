export const CLOSEOUT_CHECKS = Object.freeze({
  scopeDone: 'Completed the agreed cleaning scope',
  walkthrough: 'Checked the finished rooms',
  secured: 'Left the site secure',
});

export function migrateCloseouts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_closeouts (
      id INTEGER PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id),
      submitted_by TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      notes TEXT NOT NULL,
      decision TEXT CHECK(decision IN ('approved', 'returned')),
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_notes TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE INDEX IF NOT EXISTS closeouts_by_booking ON job_closeouts(booking_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_closeout
      ON job_closeouts(booking_id) WHERE decision IS NULL;
  `);
}
