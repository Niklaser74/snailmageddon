-- pg_cron must exist before 20260904190000_snigelpost_robust.sql schedules
-- snails_cleanup. The shared project the game started in already had it; a
-- fresh project (the snails project since 2026-09-10) needs it enabled explicitly.
create extension if not exists pg_cron;
