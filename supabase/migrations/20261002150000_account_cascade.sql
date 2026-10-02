-- Deleting an account deletes its Snäckmageddon data. The series privacy
-- policy (snails.se/privacy.html) promises it; until now matches, series,
-- turns and push subscriptions kept the user id with no link to auth.users.
-- A match belongs to both players, so it goes as a whole when either
-- account goes: what is left would carry the deleted player's moves and name.
-- Sibling migrations do the same for the other games' tables (snailchess,
-- snailrow, snailstory, snailman repos).
alter table public.snails_matches
  add constraint snails_matches_host_fkey foreign key (host) references auth.users (id) on delete cascade,
  add constraint snails_matches_guest_fkey foreign key (guest) references auth.users (id) on delete cascade;
alter table public.snails_series
  add constraint snails_series_host_fkey foreign key (host) references auth.users (id) on delete cascade,
  add constraint snails_series_guest_fkey foreign key (guest) references auth.users (id) on delete cascade,
  add constraint snails_series_winner_user_fkey foreign key (winner_user) references auth.users (id) on delete set null;
alter table public.snails_turns
  add constraint snails_turns_player_fkey foreign key (player) references auth.users (id) on delete cascade;
alter table public.snails_push_subscriptions
  add constraint snails_push_subscriptions_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade;
create index if not exists snails_turns_player on public.snails_turns (player);
