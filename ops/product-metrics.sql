WITH all_events AS (
  SELECT COUNT(CASE WHEN is_qa = 1 THEN 1 END) AS qa_rows
  FROM product_events
),
real_funnel AS (
  SELECT
    COUNT(DISTINCT CASE WHEN name = 'visited' THEN session_id END) AS users,
    COUNT(DISTINCT CASE WHEN name = 'campaign_created' THEN session_id END) AS creators,
    COUNT(DISTINCT CASE WHEN name = 'tester_joined' THEN session_id END) AS testers,
    COUNT(DISTINCT CASE WHEN name = 'tester_joined' THEN campaign_id END) AS campaigns_with_testers,
    COUNT(DISTINCT CASE WHEN name = 'optin_confirmed' THEN session_id END) AS opted_in,
    COUNT(DISTINCT CASE WHEN name = 'day_checked' THEN session_id END) AS checked,
    COUNT(DISTINCT CASE WHEN name = 'feedback_sent' THEN session_id END) AS feedback_users,
    COUNT(DISTINCT CASE WHEN name = 'roster_exported' THEN session_id END) AS exporters,
    COUNT(CASE WHEN name = 'roster_exported' THEN 1 END) AS exports,
    COUNT(DISTINCT CASE WHEN name = 'public_campaign_viewed' THEN session_id END) AS public_viewers,
    COUNT(DISTINCT CASE WHEN name = 'official_link_opened' THEN session_id END) AS official_link_openers,
    COUNT(DISTINCT CASE WHEN name = 'returned' THEN session_id END) AS returned,
    COUNT(DISTINCT CASE WHEN name = 'campaign_created' AND created_at >= unixepoch() - 604800 THEN campaign_id END) AS created_7d,
    COUNT(DISTINCT CASE WHEN name = 'tester_joined' AND created_at >= unixepoch() - 604800 THEN session_id END) AS testers_7d
  FROM product_events
  WHERE is_qa = 0
),
live_campaigns AS (
  SELECT
    COUNT(CASE WHEN status = 'recruiting' THEN 1 END) AS recruiting_campaigns,
    COUNT(CASE WHEN status = 'running' THEN 1 END) AS running_campaigns,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_campaigns,
    COUNT(CASE WHEN status = 'closed' THEN 1 END) AS closed_campaigns,
    COUNT(CASE WHEN status = 'hidden' THEN 1 END) AS hidden_campaigns
  FROM campaigns
  WHERE expires_at > unixepoch()
),
live_testers AS (
  SELECT
    COUNT(CASE WHEN status != 'withdrawn' THEN 1 END) AS active_testers,
    COUNT(CASE WHEN status = 'testing' THEN 1 END) AS testing_testers,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_testers,
    COUNT(CASE WHEN status = 'withdrawn' THEN 1 END) AS withdrawn_testers
  FROM testers
),
activity AS (
  SELECT
    (SELECT COUNT(*) FROM checkins) AS checkins,
    (SELECT COUNT(*) FROM feedback) AS feedback_items
)
SELECT real_funnel.*, all_events.qa_rows, live_campaigns.*, live_testers.*, activity.*
FROM real_funnel CROSS JOIN all_events CROSS JOIN live_campaigns CROSS JOIN live_testers CROSS JOIN activity;
