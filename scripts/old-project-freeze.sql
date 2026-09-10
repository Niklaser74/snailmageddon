-- Write freeze for Snäckmageddon in the OLD Supabase project (nissebus,
-- zhkgsbbrxcrbwriztoxx) while the data is copied to the snails project.
-- Reads keep working; writes fail with "permission denied for function" until
-- old-project-unfreeze.sql is run (rollback) or the snails_* objects are
-- dropped (a week after the move). Run in the SQL editor or through the MCP.
revoke execute on function public.snails_submit_turn(uuid, int, int, int, jsonb, text, boolean, int) from authenticated;
revoke execute on function public.snails_create_match(int, jsonb, text, int, int) from authenticated;
revoke execute on function public.snails_join_match(uuid, text) from authenticated;
revoke execute on function public.snails_resign(uuid) from authenticated;
revoke execute on function public.snails_claim_timeout(uuid) from authenticated;
revoke execute on function public.snails_rematch(uuid, int) from authenticated;
revoke execute on function public.snails_extend_series(uuid, int) from authenticated;
revoke execute on function public.snails_delete_match(uuid) from authenticated;
revoke execute on function public.snails_daily_submit(date, int, text, int, text, jsonb) from authenticated;
revoke execute on function public.snails_profile_set(text, jsonb) from authenticated;
revoke execute on function public.snails_save_push(text, text, text, text) from authenticated;
revoke execute on function public.snails_remove_push(text) from authenticated;
