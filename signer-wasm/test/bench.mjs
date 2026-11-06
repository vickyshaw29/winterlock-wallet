import { exportLeaves, keygen, pubkey, sign, verify } from './load.mjs';

const SEED = '0x' + '07'.repeat(32);
const MSG = '0x' + '11'.repeat(32);
const TREE = { seed: SEED, height: 10, chains: [1337] };

const time = (runs, f) => {
  const samples = Array.from({ length: runs }, () => {
    const start = performance.now();
    f();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return samples[runs >> 1];
};
const fmt = (ms) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`);

console.log('| Height | 1 chain | 2 chains |\n| --- | --- | --- |');
for (const height of [4, 6, 8, 10, 12, 14]) {
  const runs = height <= 10 ? 5 : 1;
  const one = time(runs, () => keygen({ ...TREE, height }));
  const two = time(runs, () => keygen({ ...TREE, height, chains: [1337, 11155111] }));
  console.log(`| ${height} | ${fmt(one)} | ${fmt(two)} |`);
}

const tree = keygen(TREE);
const entry = sign({ ...TREE, chainId: 1337, leaf: 42, msg: MSG }).entry;
const ticket = exportLeaves({ ...TREE, chainId: 1337, from: 1008, to: 1023, hotStart: 1008 });
const one = exportLeaves({ ...TREE, chainId: 1337, from: 1010, to: 1010, hotStart: 1008 });

console.log('\n| Operation at h = 10 | Time |\n| --- | --- |');
for (const [name, runs, f] of [
  ['keygen (tree build)', 5, () => keygen(TREE)],
  ['sign from the seed (tree build + sign)', 5, () => sign({ ...TREE, chainId: 1337, leaf: 42, msg: MSG })],
  ['exportLeaves, 16 leaves (tree build)', 5, () => exportLeaves({ ...TREE, chainId: 1337, from: 1008, to: 1023, hotStart: 1008 })],
  ['sign from a 16-leaf ticket', 300, () => sign({ ticket, leaf: 1010, msg: MSG })],
  ['sign from a 1-leaf ticket', 300, () => sign({ ticket: one, leaf: 1010, msg: MSG })],
  ['verify', 300, () => verify({ treeSeed: tree.treeSeed, root: tree.root, height: 10, chainId: 1337, leaf: 42, msg: MSG, entry })],
  ['pubkey (one leaf, no tree)', 300, () => pubkey({ ...TREE, chainId: 1337, leaf: 42 })],
]) {
  console.log(`| ${name} | ${fmt(time(runs, f))} |`);
}
