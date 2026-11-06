// The agent screen's mock market: a seeded random walk (labelled mock on screen, never a real feed) and the agent's
// rule, "if price falls more than 2 % in 30 s, buy". No DOM.
// Written with Claude Code (AI) for Vicky.

/** @typedef {{ t: number, price: number }} Tick t: ms */

/**
 * A small seeded generator (mulberry32), so the walk is the same on every load.
 * @param {number} seed
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{ start?: number, seed?: number, now?: number, keepMs?: number }} [opts]
 */
export function createMockMarket(opts = {}) {
  const next = rng(opts.seed ?? 8141);
  const keepMs = opts.keepMs ?? 60_000;
  /** @type {Tick[]} */
  const history = [{ t: opts.now ?? 0, price: opts.start ?? 3000 }];
  const last = () => /** @type {Tick} */ (history[history.length - 1]);
  const trim = (/** @type {number} */ now) => { while (history.length > 2 && (history[0]?.t ?? now) < now - keepMs) history.shift(); };
  return {
    history,
    price: () => last().price,
    /** a step of at most ±0.15 % */
    tick(/** @type {number} */ now) {
      const p = last().price * (1 + (next() - 0.5) * 0.003);
      history.push({ t: now, price: Math.round(p * 100) / 100 });
      trim(now);
    },
    /** a sudden move, e.g. drop(3) for a 3 % fall */
    drop(/** @type {number} */ pct, /** @type {number} */ now) {
      history.push({ t: now, price: Math.round(last().price * (1 - pct / 100) * 100) / 100 });
      trim(now);
    },
  };
}

/**
 * The fall from the highest price in the window to the latest one, in percent (0 when the price rose).
 * @param {Tick[]} history oldest first
 * @param {number} now
 * @param {number} windowMs
 */
export function fallPct(history, now, windowMs) {
  const recent = history.filter((x) => x.t >= now - windowMs && x.t <= now);
  const latest = recent[recent.length - 1];
  if (!latest) return 0;
  const high = Math.max(...recent.map((x) => x.price));
  return high > 0 ? Math.max(0, ((high - latest.price) / high) * 100) : 0;
}

/**
 * Whether the rule fires: a fall of more than dropPct within windowMs.
 * @param {Tick[]} history
 * @param {number} now
 * @param {{ dropPct: number, windowMs: number }} rule
 */
export function ruleFires(history, now, rule) {
  return fallPct(history, now, rule.windowMs) > rule.dropPct;
}

/**
 * The change over the window, signed, in percent: from the first price in the window to the latest.
 * @param {Tick[]} history
 * @param {number} now
 * @param {number} windowMs
 */
export function changePct(history, now, windowMs) {
  const recent = history.filter((x) => x.t >= now - windowMs && x.t <= now);
  const first = recent[0], latest = recent[recent.length - 1];
  return first && latest && first.price > 0 ? ((latest.price - first.price) / first.price) * 100 : 0;
}
