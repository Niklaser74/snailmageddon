-- Rules version 4: selectable wind strength (normal / hard / storm).
-- Window becomes 3 + 4; version 2 gets its sunset 30 days out.
insert into public.snails_rules (version, supported, sunset_at, note) values
  (2, false, '2026-10-09', 'lådor, slemklot, saltregn, ammunition'),
  (4, true, null, 'vindstyrka: normal, hård, storm')
on conflict (version) do update set supported = excluded.supported, sunset_at = excluded.sunset_at, note = excluded.note;
