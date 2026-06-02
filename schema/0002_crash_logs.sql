-- Client-side crash / error logs shipped from the Pholia PWA.
-- Goal: capture the audio event ring buffer right before / during / after
-- failures so silent-park and iOS-PWA-kill bugs are diagnosable after the
-- fact, without needing the user's laptop to be running wrangler tail.

CREATE TABLE IF NOT EXISTS crash_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  app_version TEXT,
  user_agent TEXT,
  audio_state TEXT,
  events_count INTEGER NOT NULL DEFAULT 0,
  events_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crash_logs_ts ON crash_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_crash_logs_session ON crash_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_crash_logs_reason ON crash_logs(reason);
