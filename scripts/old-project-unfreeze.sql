-- Undo of old-project-freeze.sql: gives the OLD Supabase project (nissebus)
-- its write access back. Only needed for a rollback of the move.
grant execute on function public.snails_submit_turn(uuid, int, int, int, jsonb, text, boolean, int) to authenticated;
grant execute on function public.snails_create_match(int, jsonb, text, int, int) to authenticated;
grant execute on function public.snails_join_match(uuid, text) to authenticated;
grant execute on function public.snails_resign(uuid) to authenticated;
grant execute on function public.snails_claim_timeout(uuid) to authenticated;
grant execute on function public.snails_rematch(uuid, int) to authenticated;
grant execute on function public.snails_extend_series(uuid, int) to authenticated;
grant execute on function public.snails_delete_match(uuid) to authenticated;
grant execute on function public.snails_daily_submit(date, int, text, int, text, jsonb) to authenticated;
grant execute on function public.snails_profile_set(text, jsonb) to authenticated;
grant execute on function public.snails_save_push(text, text, text, text) to authenticated;
grant execute on function public.snails_remove_push(text) to authenticated;
