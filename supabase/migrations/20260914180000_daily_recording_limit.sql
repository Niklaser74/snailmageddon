-- Shot of the day: a long, careful shot on a phone (many aim/walk input changes,
-- each stored as a full input frame) produced a recording over 20 kB and was
-- refused with "violates check constraint snails_daily_recording_small".
-- Same ceiling as snails_turns. Applied to the snails project 2026-09-14.
alter table public.snails_daily drop constraint if exists snails_daily_recording_small;
alter table public.snails_daily add constraint snails_daily_recording_small check (pg_column_size(recording) < 200000);
