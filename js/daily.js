// Shot of the day: the same map, weapon and targets for everyone during one
// UTC day. One snail, one shot, score = damage done. Best score per player
// per day goes to the leaderboard (Supabase, see supabase/README.md).
import { online } from './supa.js';
import { RULES_VERSION } from './game.js';
import { TEAM_COLORS } from './snails.js';

// weapons that make sense from a distance, one per day in turn
export const DAILY_WEAPONS = ['bazooka', 'granat', 'slem', 'saltregn'];

export function dayKey(d = new Date()) { return d.toISOString().slice(0, 10); }
export function dayNumber(key) { return Math.floor(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / 86400000); }
// a well-mixed 31-bit seed from the day, so neighbouring days look nothing alike
export function seedFor(key) {
  let h = 0x9e3779b1 ^ dayNumber(key);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) & 0x7fffffff;
}
export function weaponFor(key) { return DAILY_WEAPONS[dayNumber(key) % DAILY_WEAPONS.length]; }

export function dailyConfig(key, style, names) {
  return {
    mode: 'daily',
    seed: seedFor(key),
    dailyWeapon: weaponFor(key),
    snailsPerTeam: 3,
    teamSizes: [1, 3],
    turnTime: 45,
    suddenDeath: 0,
    wind: 'normal',
    style,
    teams: [
      { name: names.me, color: TEAM_COLORS[0].hex, ai: false },
      { name: names.targets, color: TEAM_COLORS[1].hex, ai: false },
    ],
  };
}

export const daily = {
  available() { return online.available(); },
  async submit(key, game, name) {
    return online.rpc('snails_daily_submit', {
      p_day: key, p_score: game.daily.score, p_name: name, p_rules_version: RULES_VERSION,
      p_weapon: game.daily.weapon, p_recording: game.recording,
    });
  },
  async board(key) { return online.rpc('snails_daily_board', { p_day: key }); },
};
