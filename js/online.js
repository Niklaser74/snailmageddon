// Snigelpost: asynchronous matches on top of the deterministic simulation.
// A match on the server is a seed plus one row of recorded inputs per turn.
// Opening a match replays every turn (instantly, or visibly for the opponent's
// last turn), then this device plays its own turn live and uploads the inputs.
import { online } from './supa.js';
import { Game, RULES_VERSION, rulesSupported, normalizeRules } from './game.js';
import { TEAM_COLORS } from './snails.js';

export const snigelpost = {
  available() { return online.available(); },

  // config: { snailsPerTeam, turnTime, suddenDeath, wind }
  async create(config, name, bestOf = 3) {
    return online.rpc('snails_create_match', {
      p_seed: (Math.random() * 2147483647) | 0,
      p_config: { snailsPerTeam: config.snailsPerTeam, ...normalizeRules(config) },
      p_name: name,
      p_rules_version: RULES_VERSION,
      p_best_of: bestOf,
    });
  },
  async profile() { return online.rpc('snails_profile'); },
  async profileSet(name, look) { return online.rpc('snails_profile_set', { p_name: name, p_look: look }); },
  async extend(id, bestOf) { return online.rpc('snails_extend_series', { p_match: id, p_best_of: bestOf }); },
  // the series continues in another match than this one
  nextMatchId(match) {
    const s = match?.series;
    return s && s.status !== 'finished' && s.current_match && s.current_match !== match.id ? s.current_match : null;
  },
  async join(id, name) { return online.rpc('snails_join_match', { p_match: id, p_name: name }); },
  async get(id) { return online.rpc('snails_get_match', { p_match: id }); },
  async list() { return online.rpc('snails_my_matches'); },
  async remove(id) { return online.rpc('snails_delete_match', { p_match: id }); },
  async resign(id) { return online.rpc('snails_resign', { p_match: id }); },
  async claimTimeout(id) { return online.rpc('snails_claim_timeout', { p_match: id }); },
  async rematch(id) { return online.rpc('snails_rematch', { p_match: id, p_rules_version: RULES_VERSION }); },
  // days the opponent has been silent (0 when it is our turn)
  silentDays(match) {
    if (!match || match.status !== 'playing' || match.turn_team === match.my_team) return 0;
    return Math.floor((Date.now() - new Date(match.updated_at).getTime()) / 86400000);
  },

  async submit(match, game, startTick, finished, winnerTeam) {
    return online.rpc('snails_submit_turn', {
      p_match: match.id,
      p_turn_no: match.turn_count + 1,
      p_start_tick: startTick,
      p_end_tick: game.tickCount,
      p_inputs: game.inputsSince(startTick),
      p_state_hash: game.stateHash(),
      p_finished: !!finished,
      p_winner: finished && winnerTeam != null ? winnerTeam : null,
    });
  },

  inviteLink(id) {
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('match', id);
    return u.toString();
  },

  // Team setup shared by every device in the match. Style is a local choice.
  config(match, style, theme = 'auto') {
    return {
      seed: match.seed,
      theme,
      rulesVersion: match.rules_version,
      snailsPerTeam: match.config.snailsPerTeam || 3,
      ...normalizeRules(match.config),
      style,
      teams: [
        { name: match.names?.['0'] || 'Värd', color: TEAM_COLORS[0].hex, ai: false, look: match.looks?.['0'] || null },
        { name: match.names?.['1'] || '…', color: TEAM_COLORS[1].hex, ai: false, look: match.looks?.['1'] || null },
      ],
    };
  },

  // Build the Game for a match as seen from this device. Returns the game plus
  // the tick where the opponent's latest turn starts (for a visible replay).
  buildGame(canvas, match, hooks, style, theme = 'auto') {
    if (!rulesSupported(match.rules_version)) throw new Error('rules');
    const cfg = this.config(match, style, theme);
    const myTeam = match.my_team;
    const turns = match.turns || [];
    const inputs = turns.flatMap((t) => t.inputs);
    const opts = { localTeams: myTeam == null ? [] : [myTeam] };
    if (turns.length) {
      opts.replay = { rulesVersion: match.rules_version, seed: match.seed, teams: cfg.teams, snailsPerTeam: cfg.snailsPerTeam, turnTime: cfg.turnTime, suddenDeath: cfg.suddenDeath, wind: cfg.wind, inputs };
      opts.liveAfter = match.tick_count;
    }
    const game = new Game(canvas, cfg, hooks, opts);
    const last = turns[turns.length - 1];
    const replayFrom = last && last.team !== myTeam ? last.start_tick : match.tick_count;
    return { game, myTeam, replayFrom, expectedHash: match.last_hash };
  },
};
