-- A player deletes their own account from snails.se/account/. Every game
-- table with a player id cascades from auth.users since
-- 20261002150000_account_cascade.sql (and its siblings in the other games'
-- repos), so deleting the user row is the whole job: matches, series,
-- tournaments, leaderboards, profile, ratings, purchases, push subscriptions
-- and reminders go with it, and so do Supabase's own sessions and identities.
--
-- p_confirm is the word the player typed (RADERA or DELETE). It does not stop
-- a script running on the page — nothing on the client can — but it keeps a
-- stray or mistyped call from deleting anything.
create or replace function public.snails_delete_account(p_confirm text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in'; end if;
  if p_confirm is null or upper(trim(p_confirm)) not in ('RADERA', 'DELETE') then raise exception 'not confirmed'; end if;
  delete from auth.users where id = uid;
end $$;
revoke all on function public.snails_delete_account(text) from anon, public;
grant execute on function public.snails_delete_account(text) to authenticated;
