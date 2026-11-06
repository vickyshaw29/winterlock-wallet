// Formatting for the screens: wei as ETH, gas, hashes and addresses, nonce keys (lanes), times. No DOM.
// Written with Claude Code (AI) for Vicky.

const WEI_PER_ETH = 10n ** 18n;
const GWEI = 1_000_000_000n;

/** @param {bigint} n */
function group(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A decimal or 0x string, a number or a bigint as a bigint; null when it is none of them.
 * @param {unknown} v
 * @returns {bigint | null}
 */
export function toBigInt(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  return null;
}

/** @param {bigint} a wei, not negative @returns {string} ETH, exact, trailing zeros trimmed */
function eth(a) {
  const frac = a % WEI_PER_ETH;
  return `${group(a / WEI_PER_ETH)}${frac === 0n ? "" : `.${frac.toString().padStart(18, "0").replace(/0+$/, "")}`}`;
}

/**
 * An amount to read at a glance: whole wei below 1 gwei, else ETH with at most six significant decimals (six digits
 * after the zeros that follow the point below 1 ETH, six decimals from 1 ETH up), rounded half up, trailing zeros
 * trimmed. A tranche never shows 18 decimals; formatWeiExact gives the exact value for a title.
 * @param {unknown} wei decimal string of wei (the API's form), bigint or number
 */
export function formatWei(wei) {
  const v = toBigInt(wei);
  if (v === null) return "—";
  const sign = v < 0n ? "-" : "";
  let a = v < 0n ? -v : v;
  if (a === 0n) return "0 ETH";
  if (a < GWEI) return `${sign}${group(a)} wei`;
  const zeros = a >= WEI_PER_ETH ? 0 : 18 - a.toString().length; // the zeros right after the point
  const drop = 18 - Math.min(18, zeros + 6); // wei digits below the sixth significant decimal
  if (drop > 0) {
    const unit = 10n ** BigInt(drop);
    a = ((a + unit / 2n) / unit) * unit;
  }
  return `${sign}${eth(a)} ETH`;
}

/**
 * The exact amount, never rounded: whole wei below 1 gwei, else ETH with its trailing zeros trimmed (titles).
 * @param {unknown} wei
 */
export function formatWeiExact(wei) {
  const v = toBigInt(wei);
  if (v === null) return "—";
  const a = v < 0n ? -v : v;
  if (a === 0n) return "0 ETH";
  return `${v < 0n ? "-" : ""}${a < GWEI ? `${group(a)} wei` : `${eth(a)} ETH`}`;
}

/**
 * ETH typed by a person ("0.01", ".5", "2") as wei; null when it is not a plain non-negative amount of at most 18 decimals.
 * @param {string} text
 * @returns {bigint | null}
 */
export function parseEth(text) {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!m) return null;
  const whole = m[1] ?? "", frac = m[2] ?? "";
  if (whole === "" && frac === "") return null;
  if (frac.length > 18) return null;
  return BigInt(whole || "0") * WEI_PER_ETH + BigInt(frac.padEnd(18, "0") || "0");
}

/**
 * wei as an ETH string for an input field ("0.01"), exact.
 * @param {unknown} wei
 */
export function weiToEthInput(wei) {
  const v = toBigInt(wei) ?? 0n;
  const frac = v % WEI_PER_ETH;
  return `${v / WEI_PER_ETH}${frac === 0n ? "" : `.${frac.toString().padStart(18, "0").replace(/0+$/, "")}`}`;
}

/**
 * Gas with thousands separators; "—" when unknown.
 * @param {unknown} gas
 */
export function formatGas(gas) {
  const v = toBigInt(gas);
  return v === null ? "—" : group(v);
}

/**
 * "0x1234…cdef" for a hash or an address; short values come back whole.
 * @param {string | null | undefined} hex
 * @param {number} [head] characters kept after 0x
 * @param {number} [tail]
 */
export function shortHex(hex, head = 4, tail = 4) {
  if (!hex) return "—";
  return hex.length <= 2 + head + tail + 1 ? hex : `${hex.slice(0, 2 + head)}…${hex.slice(-tail)}`;
}

/**
 * A lane is a nonce key, (epoch << 32) | leaf (spec, Shared interfaces 3).
 * @param {string | null | undefined} nonceKey 0x hex
 * @returns {{ epoch: number, leaf: number } | null}
 */
export function nonceKeyParts(nonceKey) {
  const k = toBigInt(nonceKey);
  if (k === null) return null;
  return { epoch: Number(k >> 32n), leaf: Number(k & 0xffffffffn) };
}

/**
 * Seconds since something happened: "4 s ago", "2 min ago", "3 h ago".
 * @param {number} seconds
 */
export function formatAgo(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/**
 * Time after a lane's first step: "+0.4 s", "+12 s", "+2 min 5 s".
 * @param {number} ms
 */
export function formatOffset(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `+${s.toFixed(1)} s`;
  if (s < 60) return `+${Math.round(s)} s`;
  const whole = Math.round(s);
  return `+${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/**
 * A wall-clock time, HH:MM:SS in the viewer's zone.
 * @param {string | number | null | undefined} at ISO string or unix seconds
 */
export function formatClock(at) {
  if (at === null || at === undefined) return "—";
  const d = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Whether a string is an address as the backend accepts it (lower case or any case; the backend checks checksums).
 * @param {string} v
 */
export function isAddress(v) {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}
