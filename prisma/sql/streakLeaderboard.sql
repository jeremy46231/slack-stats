-- Gaps-and-islands: consecutive active days ending at the most recent loaded date.
-- If a user wasn't active on the latest date their current streak is 0 (excluded).
WITH most_recent AS (
  SELECT MAX(date)::date AS latest_date
  FROM "Day"
  WHERE user_day_loaded = true
),
users_active_on_latest AS (
  SELECT ud.user_id
  FROM "UserDay" ud
  CROSS JOIN most_recent mr
  WHERE ud.date = mr.latest_date
    AND ud.is_active = true
),
active_days_desc AS (
  SELECT
    ud.user_id,
    ud.date::date                                                          AS day,
    ROW_NUMBER() OVER (PARTITION BY ud.user_id ORDER BY ud.date DESC)      AS rn
  FROM "UserDay" ud
  JOIN users_active_on_latest ual ON ual.user_id = ud.user_id
  CROSS JOIN most_recent mr
  WHERE ud.is_active = true
    AND ud.date <= mr.latest_date
),
current_streak AS (
  SELECT
    a.user_id,
    COUNT(*)::int AS streak_length
  FROM active_days_desc a
  CROSS JOIN most_recent mr
  -- Consecutive days from most recent: day + (rn-1) = latest_date
  WHERE a.day + CAST(a.rn - 1 AS INTEGER) = mr.latest_date
  GROUP BY a.user_id
)
SELECT
  cs.user_id,
  u.display_name,
  u.real_name,
  cs.streak_length
FROM current_streak cs
JOIN "User" u ON u.user_id = cs.user_id
ORDER BY cs.streak_length DESC;
