import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { exportLeaves, keygen, pubkey, sign, verify } from './load.mjs';

const repo = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const SEED = '0x' + '07'.repeat(32);
const MSG = '0x' + '11'.repeat(32);
const TREE = { seed: SEED, height: 3, generation: 2, chains: [1337, 11155111] };
const TREE_FLAGS = ['--height', '3', '--generation', '2', '--chains', '1337,11155111'];

const cli = (...args) =>
  JSON.parse(execFileSync(repo('signer/target/release/signer'), args, { env: { ...process.env, PQ_SEED: SEED } }));

test('every vector gets its expected outcome', () => {
  const file = JSON.parse(readFileSync(repo('vectors/h10.json')));
  for (const c of file.cases) {
    const req = { treeSeed: file.treeSeed, root: file.root, height: 10, chainId: c.chainId, leaf: c.leaf, msg: c.message, entry: c.entry };
    if (c.expected) {
      assert.deepEqual(verify(req), { ok: true }, c.name);
    } else if (['bad_version', 'bad_slot', 'root_mismatch'].includes(c.reason)) {
      assert.throws(() => verify(req), { code: 'verify_failed', message: c.reason }, c.name);
    } else {
      assert.throws(() => verify(req), { code: c.reason }, c.name);
    }
  }
});

test('same output as the native CLI', () => {
  assert.deepEqual(keygen(TREE), cli('keygen', ...TREE_FLAGS));
  assert.deepEqual(pubkey({ ...TREE, chainId: 11155111, leaf: 5 }), cli('pubkey', ...TREE_FLAGS, '--chain-id', '11155111', '--leaf', '5'));
  assert.deepEqual(
    sign({ ...TREE, chainId: 11155111, leaf: 5, msg: MSG }),
    cli('sign', ...TREE_FLAGS, '--chain-id', '11155111', '--leaf', '5', '--msg', MSG),
  );

  const out = join(mkdtempSync(join(tmpdir(), 'signer-wasm-')), 'ticket.json');
  cli('export-leaves', ...TREE_FLAGS, '--chain-id', '1337', '--from', '4', '--to', '7', '--hot-start', '4', '--out', out);
  const ticket = exportLeaves({ ...TREE, chainId: 1337, from: 4, to: 7, hotStart: 4 });
  assert.deepEqual(ticket, JSON.parse(readFileSync(out)));
  assert.deepEqual(sign({ ticket, leaf: 6, msg: MSG }), cli('sign', '--ticket-file', out, '--leaf', '6', '--msg', MSG));
});

test('errors carry the CLI codes', () => {
  const tree = keygen(TREE);
  const entry = sign({ ...TREE, chainId: 1337, leaf: 2, msg: MSG }).entry;
  const ticket = exportLeaves({ ...TREE, chainId: 1337, from: 4, to: 7, hotStart: 4 });
  const verifyReq = { treeSeed: tree.treeSeed, root: tree.root, height: 3, chainId: 1337, leaf: 2, msg: MSG, entry };
  const cases = [
    [() => keygen({ ...TREE, seed: '0x1234' }), 'bad_seed'],
    [() => keygen({ ...TREE, seed: undefined }), 'bad_seed'],
    [() => keygen({ ...TREE, height: 21 }), 'bad_height'],
    [() => keygen({ ...TREE, chains: [1, 1] }), 'bad_chain'],
    [() => keygen({ ...TREE, height: undefined }), 'bad_args'],
    [() => keygen(5), 'bad_args'],
    [() => sign({ ...TREE, chainId: 1, leaf: 0, msg: MSG }), 'bad_chain'],
    [() => sign({ ...TREE, chainId: 1337, leaf: 8, msg: MSG }), 'leaf_out_of_range'],
    [() => sign({ ...TREE, chainId: 1337, leaf: 0, msg: '0x1234' }), 'bad_msg_length'],
    [() => sign({ ticket, leaf: 3, msg: MSG }), 'leaf_not_in_ticket'],
    [() => sign({ ticket, leaf: 5, msg: MSG, chainId: 11155111 }), 'bad_chain'],
    [() => sign({ ticket: {}, leaf: 5, msg: MSG }), 'bad_ticket'],
    [() => exportLeaves({ ...TREE, chainId: 1337, from: 2, to: 7, hotStart: 4 }), 'leaf_out_of_range'],
    [() => verify({ ...verifyReq, entry: entry.slice(0, -2) }), 'bad_entry_length'],
    [() => verify({ ...verifyReq, leaf: 3 }), 'verify_failed'],
  ];
  for (const [call, code] of cases) assert.throws(call, { code });
});
