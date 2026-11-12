/** A 64-bit linear congruential generator for property tests: deterministic, so a failing seed replays. */
export function rng(seed: bigint) {
  let state = seed;
  return (below: bigint): bigint => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return (state >> 11n) % below;
  };
}
