// The tracker's states, declared once. Every place that shows or acts on a state reads it from
// here, so a new state is added in one table instead of in three files, and tests/states.test.mjs
// fails when the tracker can produce a state that is missing from a table. Pure, no chrome.*.
// The map of how these move, and where: docs/state-machines.md.

/**
 * Why minutes stopped while a stream that can earn is open (verdict.cause, set by diagnose() in
 * tracker.js). autoReload: Auto-reload may reload the tab. reloadButton: the panel offers Reload.
 * They differ for no_video on purpose: a player the extension cannot see may only have been moved
 * by Twitch, so it never reloads by itself, but the user may choose to.
 */
export const STALL_CAUSES = {
  uncounted: { autoReload: true, reloadButton: true },
  frozen: { autoReload: true, reloadButton: true },
  ended: { autoReload: true, reloadButton: true },
  asleep: { autoReload: true, reloadButton: true },
  no_video: { autoReload: false, reloadButton: true },
  paused: { autoReload: false, reloadButton: false }, // The user's own pause.
  claim_first: { autoReload: false, reloadButton: false }, // A reload cannot claim a drop.
  too_many: { autoReload: false, reloadButton: false }, // The cause is the other streams.
  second_stream: { autoReload: false, reloadButton: false },
};

/**
 * A tab's video player (stream.playerState, from classifyPlayer() in tracker.js). label: the
 * Open streams row. stall: the stalled verdict's message when this is why, given the tab's name.
 * playing never explains a stall.
 */
export const PLAYER_STATES = {
  playing: { label: null, stall: null },
  asleep: { label: 'Tab asleep', stall: (name) => `The browser put the ${name} tab to sleep.` },
  paused: { label: 'Paused', stall: (name) => `${name} is paused.` },
  frozen: { label: 'Player frozen', stall: (name) => `The ${name} player is frozen.` },
  ended: { label: 'Player ended', stall: (name) => `The ${name} player has ended.` },
  no_video: { label: 'No player', stall: (name) => `Cannot see a player in the ${name} tab, and Twitch is not adding minutes.` },
};

/**
 * What a tab's channel can do for Drops (stream.channelState, from classifyChannel() in
 * tracker.js). Only eligible can earn. label: the Open streams row when it is not earning.
 */
export const CHANNEL_STATES = {
  eligible: { label: 'Can earn, not credited' },
  no_drops: { label: 'No Drops on this channel' },
  sub_only: { label: 'Sub drops only' },
  badge_unseen: { label: 'Badge timer, no minutes reported' },
  // Every timed badge here left Twitch's in-progress list within a minute or two of its
  // requirement, which is how an earned badge looked on 2026-11-20 (tracker.js leftBadges).
  badge_left: { label: 'Badge likely earned' },
  blocked: { label: 'Next drop cannot count yet' },
  finished: { label: 'Campaign finished' },
  offline: { label: 'Offline' },
  unknown: { label: 'Cannot check this channel' },
  // Twitch not counting it, which is not the same as the campaign not having started: shown for a
  // campaign running since the day before (2026-11-19).
  unstarted: { label: 'Not counting yet' },
  // A reward campaign with no progress in sight, not owned and not called claimed by Twitch's
  // channel page: finished and not started look the same (2026-11-23, drops-tracker#17).
  reward_unproven: { label: 'Cannot tell if finished' },
  // A badge or reward campaign whose progress comes from Twitch's reward inventory or a session
  // running total: shown as Twitch reports it, never judged. On 2026-11-18 the tracker saw about
  // 15 of 250 minutes Twitch counted there, and called a hang while it counted.
  reward: { label: 'Reward campaign' },
  not_channel: { label: 'Uses a stream slot' },
};

/** The one channel state that can earn. */
export const canEarn = (stream) => stream?.channelState === 'eligible';

/**
 * Every verdict.code the tracker writes. The extra fields each one may carry are listed so a reader
 * knows what is meaningful where: anything else on a verdict is left over and must not be read.
 */
export const VERDICT_CODES = {
  starting: [], // Before the first poll.
  waiting: ['since'], // Something can earn; the first minute has not landed yet.
  earning: ['channel', 'slow', 'wasted', 'rate'], // rate: with slow, the credited channel's own count.
  stalled: ['since', 'cause', 'message', 'tabId', 'otherTabId'],
  // dropLeft: a game drop left every list near its requirement (tracker.js leftDrops).
  // rewardDone: a reward campaign was seen going from in progress to finished (tracker.js rewardsDone).
  idle: ['hasStreams', 'lost', 'limited', 'badge', 'blocked', 'unstarted', 'unproven', 'reward', 'badgeLeft', 'dropLeft', 'rewardDone', 'since', 'message'],
  signed_out: ['message'],
  api_changed: ['message'],
  error: ['message'],
};

/**
 * One meaning per colour (agreed 2026-11-20, see docs/state-machines.md "Colour"):
 * ok earning; warn you should do something, and the panel says what; bad Twitch stopped counting a
 * stream that should be earning; unknown the tracker cannot see (a grey dashed ring with "?");
 * idle nothing to do; wait checking; info a reward to claim (the claim overlay only, never a verdict).
 * Amber used to cover all of earning-but-not-ideal, cannot-see and act-now, which read alike.
 * The panel dot, the chip and the toolbar all take their colour from this one function.
 */
export const SLOW_TONE = 'ok'; // Still earning; the headline says "Earning slowly". One line to give it a colour of its own.

export function verdictTone(v) {
  switch (v?.code) {
    case 'stalled': return 'bad';
    case 'earning':
      // Already earned with nothing else open that can earn: done, nothing to act on.
      if (v.wasted) return v.wasted.reason === 'too_late' || v.wasted.actionable ? 'warn' : 'idle';
      return v.slow ? SLOW_TONE : 'ok';
    case 'waiting':
    case 'starting': return 'wait';
    case 'signed_out': return 'warn'; // Log in.
    case 'api_changed':
    case 'error': return 'unknown';
    case 'idle':
      if (v.lost) return 'warn'; // Find another stream.
      // Twitch not counting a campaign yet: usually nothing to do but wait.
      // A reward campaign that may be finished: nothing to do, and nothing is being missed.
      if (v.limited) return v.unstarted || v.blocked || v.unproven ? 'idle' : 'unknown';
      return 'idle';
    default: return 'idle';
  }
}

/** Toolbar badge colours by tone. The chip and panel use Twitch's own tokens for the same tones. */
export const TONE_COLORS = {
  ok: '#067647',
  warn: '#b54708',
  bad: '#d92d20',
  unknown: '#667085',
  idle: '#667085',
  wait: '#175cd3',
  info: '#6941c6',
};

/** Reward inventory groups read at most (twitch.js): an answer this long may have been cut short. */
export const MAX_REWARD_GROUPS = 200; // Two campaigns, eight groups, seen on 2026-11-19.

/** Watched minutes before a credit rate means anything: below this, "slow" is not judged. */
export const RATE_MIN_MINUTES = 10;
