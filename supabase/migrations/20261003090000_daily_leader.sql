-- Today's leader of Dagens skott on the hub's card. The hub never creates an
-- account, so this one function is open to anon (like snailrake_ and
-- snailman_daily_leader): it gives out only what the daily board already
-- shows everyone — the leader's display name and score, and how many played
-- today. No user ids, no recordings. The day is UTC, as in js/daily.js.
create or replace function public.snails_daily_leader()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'day', (now() at time zone 'utc')::date,
    'players', (select count(*) from public.snails_daily where day = (now() at time zone 'utc')::date),
    'leader', (select jsonb_build_object('name', name, 'score', score)
                 from public.snails_daily
                where day = (now() at time zone 'utc')::date and score > 0
                order by score desc, updated_at limit 1));
$$;
revoke execute on function public.snails_daily_leader() from public;
grant execute on function public.snails_daily_leader() to anon, authenticated;
