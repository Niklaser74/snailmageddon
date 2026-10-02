-- Abandoned anonymous accounts are deleted after a year without use.
-- An anonymous account lives in one browser; clear the site data and it can
-- never be reached again, yet its record, profile and rating would stay "as
-- long as the account exists" — for ever. Deleting the user row takes every
-- game's data with it (the *_account_cascade migrations).
--
-- "Use" is the latest of: created, signed in, user row updated, a session
-- refreshed, a refresh token issued. Anonymous players never sign in again,
-- they only refresh — so the session and token times are what move.
--
-- Never deleted, however quiet:
--   * linked accounts (Google or e-mail): the player can come back, and can
--     delete the account themselves at snails.se/account/
--   * accounts with a purchase: they paid for what the account holds
--   * Snail Story keepers with a copy of the box on the account or a reminder
--     still to come: a snail lives three years and is allowed to be left alone
create or replace function public.snails_last_seen(p_user uuid)
returns timestamptz language sql stable set search_path = '' as $$
  select greatest(u.created_at, u.last_sign_in_at, u.updated_at,
    (select max(greatest(s.updated_at, s.refreshed_at::timestamptz)) from auth.sessions s where s.user_id = u.id),
    (select max(r.updated_at) from auth.refresh_tokens r where r.user_id = u.id::text))
  from auth.users u where u.id = p_user;
$$;
revoke all on function public.snails_last_seen(uuid) from anon, authenticated, public;

create or replace function public.snails_cleanup_anonymous(p_limit int default 500)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from auth.users where id in (
    select u.id from auth.users u
     where u.is_anonymous
       and u.created_at < now() - interval '365 days'
       and public.snails_last_seen(u.id) < now() - interval '365 days'
       and not exists (select 1 from public.snails_purchases p where p.user_id = u.id)
       and not exists (select 1 from public.snailstory_saves x where x.user_id = u.id)
       and not exists (select 1 from public.snailstory_reminders r where r.user_id = u.id and r.due_at > now())
     order by u.created_at
     limit greatest(1, least(coalesce(p_limit, 500), 5000)));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.snails_cleanup_anonymous(int) from anon, authenticated, public;
select cron.schedule('snails_cleanup_anonymous', '53 3 * * *', $$select public.snails_cleanup_anonymous()$$);
