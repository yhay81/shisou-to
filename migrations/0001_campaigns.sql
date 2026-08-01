PRAGMA foreign_keys = ON;

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  manager_token_hash TEXT NOT NULL CHECK(length(manager_token_hash) = 64),
  creator_session_id TEXT NOT NULL CHECK(length(creator_session_id) = 36),
  app_name TEXT NOT NULL CHECK(length(app_name) BETWEEN 1 AND 60),
  genre TEXT NOT NULL CHECK(genre IN ('game', 'learning', 'lifestyle', 'productivity', 'tools', 'other')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 300),
  test_focus TEXT NOT NULL DEFAULT '' CHECK(length(test_focus) <= 200),
  group_url TEXT NOT NULL CHECK(length(group_url) BETWEEN 20 AND 300),
  play_url TEXT NOT NULL CHECK(length(play_url) BETWEEN 20 AND 300),
  target_count INTEGER NOT NULL DEFAULT 12 CHECK(target_count BETWEEN 12 AND 30),
  public_listing INTEGER NOT NULL DEFAULT 1 CHECK(public_listing IN (0, 1)),
  notice TEXT NOT NULL DEFAULT '' CHECK(length(notice) <= 240),
  status TEXT NOT NULL DEFAULT 'recruiting'
    CHECK(status IN ('recruiting', 'running', 'completed', 'closed', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX campaigns_public_idx ON campaigns(public_listing, status, created_at);
CREATE INDEX campaigns_expiry_idx ON campaigns(expires_at);
CREATE INDEX campaigns_creator_idx ON campaigns(creator_session_id, created_at);

CREATE TABLE testers (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  token_hash TEXT NOT NULL CHECK(length(token_hash) = 64),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 24),
  display_name_key TEXT NOT NULL CHECK(length(display_name_key) BETWEEN 1 AND 48),
  android_version TEXT NOT NULL CHECK(android_version IN ('12', '13', '14', '15', '16', 'other')),
  device_kind TEXT NOT NULL CHECK(device_kind IN ('phone', 'tablet', 'chromebook', 'other')),
  status TEXT NOT NULL DEFAULT 'joined' CHECK(status IN ('joined', 'testing', 'completed', 'withdrawn')),
  opted_in_on TEXT NOT NULL DEFAULT '' CHECK(length(opted_in_on) IN (0, 10)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(campaign_id, session_id),
  UNIQUE(campaign_id, display_name_key)
);

CREATE INDEX testers_campaign_idx ON testers(campaign_id, status, created_at);

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tester_id TEXT NOT NULL REFERENCES testers(id) ON DELETE CASCADE,
  day_index INTEGER NOT NULL CHECK(day_index BETWEEN 1 AND 14),
  result TEXT NOT NULL CHECK(result IN ('used', 'blocked')),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 160),
  created_at INTEGER NOT NULL,
  UNIQUE(tester_id, day_index)
);

CREATE INDEX checkins_campaign_idx ON checkins(campaign_id, tester_id, day_index);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tester_id TEXT NOT NULL REFERENCES testers(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('bug', 'usability', 'idea', 'other')),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 300),
  created_at INTEGER NOT NULL
);

CREATE INDEX feedback_campaign_idx ON feedback(campaign_id, created_at);

CREATE TABLE content_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  reason TEXT NOT NULL CHECK(reason IN ('spam', 'unsafe', 'other')),
  created_at INTEGER NOT NULL,
  UNIQUE(campaign_id, session_id)
);

CREATE TABLE product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(name IN ('visited', 'campaign_created', 'tester_joined', 'optin_confirmed', 'day_checked', 'feedback_sent', 'roster_exported', 'public_campaign_viewed', 'official_link_opened', 'returned')),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  campaign_id TEXT NOT NULL DEFAULT '' CHECK(length(campaign_id) IN (0, 32)),
  day TEXT NOT NULL CHECK(length(day) = 10),
  created_at INTEGER NOT NULL,
  is_qa INTEGER NOT NULL DEFAULT 0 CHECK(is_qa IN (0, 1))
);

CREATE INDEX product_events_day_idx ON product_events(day, name, is_qa);
