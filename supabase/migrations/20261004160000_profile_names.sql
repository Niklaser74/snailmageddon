-- The names in a match, a series and on Shot of the day are the account's
-- names, as in the other games of the series (2026-10-04). The game already
-- saved a typed name to the profile, but sent its own copy with every match
-- and every daily shot — and kept that copy when the profile was renamed, or
-- when the shot was played before the profile had a name. So Shot of the day
-- showed "Snäcka" for players whose account had a name.
--
-- The rule: the series profile name (snails_profiles.name) when the player has
-- chosen one, otherwise the name the game sent. "Snäcka" is the default
-- snails_profile_set writes for an empty name, not a choice. Matches and
-- series keep names in `names`: '0' is the host and '1' the guest (the next
-- match of a series swaps host and guest, and the names with them).
-- Several functions write names, so the rule is a trigger per table.

create or replace function public.snails_profile_name(p_user uuid)
returns text language sql stable set search_path = public as $$
  select nullif(nullif(left(trim(p.name), 24), ''), 'Snäcka') from public.snails_profiles p where p.user_id = p_user;
$$;
revoke all on function public.snails_profile_name(uuid) from anon, authenticated, public;

create or replace function public.snails_seat_profile_names()
returns trigger language plpgsql security definer set search_path = public as $$
declare n0 text := public.snails_profile_name(new.host);
        n1 text := case when new.guest is null then null else public.snails_profile_name(new.guest) end;
begin
  if n0 is not null then new.names := coalesce(new.names, '{}'::jsonb) || jsonb_build_object('0', n0); end if;
  if n1 is not null then new.names := coalesce(new.names, '{}'::jsonb) || jsonb_build_object('1', n1); end if;
  return new;
end $$;
revoke all on function public.snails_seat_profile_names() from anon, authenticated, public;
drop trigger if exists snails_matches_profile_names on public.snails_matches;
create trigger snails_matches_profile_names before insert or update of names, host, guest on public.snails_matches
  for each row execute function public.snails_seat_profile_names();
drop trigger if exists snails_series_profile_names on public.snails_series;
create trigger snails_series_profile_names before insert or update of names, host, guest on public.snails_series
  for each row execute function public.snails_seat_profile_names();

create or replace function public.snails_daily_profile_name()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.name := coalesce(public.snails_profile_name(new.user_id), new.name);
  return new;
end $$;
revoke all on function public.snails_daily_profile_name() from anon, authenticated, public;
drop trigger if exists snails_daily_profile_name on public.snails_daily;
create trigger snails_daily_profile_name before insert or update of name on public.snails_daily
  for each row execute function public.snails_daily_profile_name();

-- a rename on the account page reaches every match, series and daily shot
create or replace function public.snails_profile_renamed()
returns trigger language plpgsql security definer set search_path = public as $$
declare nm text := public.snails_profile_name(new.user_id);
begin
  if nm is null then return new; end if; -- back to the default: keep what the game sent
  update public.snails_matches set names = names || jsonb_build_object('0', nm) where host = new.user_id and names->>'0' is distinct from nm;
  update public.snails_matches set names = names || jsonb_build_object('1', nm) where guest = new.user_id and names->>'1' is distinct from nm;
  update public.snails_series set names = names || jsonb_build_object('0', nm) where host = new.user_id and names->>'0' is distinct from nm;
  update public.snails_series set names = names || jsonb_build_object('1', nm) where guest = new.user_id and names->>'1' is distinct from nm;
  update public.snails_daily set name = nm where user_id = new.user_id and name is distinct from nm;
  return new;
end $$;
revoke all on function public.snails_profile_renamed() from anon, authenticated, public;
drop trigger if exists snails_profile_renamed on public.snails_profiles;
create trigger snails_profile_renamed after insert or update of name on public.snails_profiles
  for each row execute function public.snails_profile_renamed();

-- once: what is already there (the before-triggers apply the rule)
update public.snails_matches m set names = m.names
 where public.snails_profile_name(m.host) is not null or (m.guest is not null and public.snails_profile_name(m.guest) is not null);
update public.snails_series s set names = s.names
 where public.snails_profile_name(s.host) is not null or (s.guest is not null and public.snails_profile_name(s.guest) is not null);
update public.snails_daily d set name = d.name where public.snails_profile_name(d.user_id) is not null;
