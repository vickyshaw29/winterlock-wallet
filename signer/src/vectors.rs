//! The shared test vectors (format v2) that the Yul verifier and the TypeScript
//! pipeline check against. The master seed is a public throwaway, so the file is
//! reproducible byte for byte. Never fund an account built from it.

use serde_json::{Value, json};

use crate::derive;
use crate::entry::Entry;
use crate::hash::{Hash, keccak};
use crate::scheme::{self, Reject};
use crate::tree::{SLOT_BITS, Tree};
use crate::wots;

pub const VERSION: u32 = 2;
pub const GENERATION: u32 = 0;

pub fn master_seed() -> Hash {
    keccak(&[b"nonce-bound-pq-wallet/test-vectors"])
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Leaves 0, alternating bits and 2^h - 1 take both sides at every subtree level,
/// and the second chain's slot 1 takes the right side in the slot layer.
pub fn generate(height: u8, chains: &[u64]) -> Value {
    assert!(
        height >= 2,
        "height {height} cannot give distinct first, middle and last leaves"
    );
    assert!(
        chains.len() >= 2,
        "list at least two chains so slot 1 is covered"
    );

    let master = master_seed();
    let tree = Tree::build(&master, GENERATION, height, chains);
    let tree_seed = derive::tree_seed(&master, GENERATION);
    let root = tree.root();
    let (c0, c1) = (chains[0], chains[1]);
    let last = (1u32 << height) - 1;
    let middle = 0xaaaa_aaaa & last;
    let other_chain = (1..).find(|c| !chains.contains(c)).unwrap();

    let sign = |chain_id: u64, leaf: u32, msg: &Hash| {
        scheme::sign_with(&tree, &master, GENERATION, chain_id, leaf, msg)
            .expect("listed chain and leaf in range")
            .encode()
    };
    let message = |chain_id: u64, leaf: u32| {
        let tag = b"nonce-bound-pq-wallet/vector-message";
        keccak(&[tag, &chain_id.to_be_bytes(), &leaf.to_be_bytes()])
    };
    let flip = |bytes: &[u8], at: usize| {
        let mut out = bytes.to_vec();
        out[at] ^= 1;
        out
    };
    let set = |bytes: &[u8], at: usize, value: u8| {
        let mut out = bytes.to_vec();
        out[at] = value;
        out
    };
    let path_word = |level: usize| 2 + wots::SIG_BYTES + 32 * level;

    // Every case is checked against our own verify before it is written, so the
    // file can never claim an outcome the Rust verifier disagrees with.
    let mut cases = Vec::new();
    let mut push = |name: String,
                    chain_id: u64,
                    slot: u8,
                    leaf: u32,
                    msg: &Hash,
                    bytes: &[u8],
                    want: Result<(), Reject>| {
        let got = scheme::verify(&tree_seed, &root, height, chain_id, leaf, msg, bytes);
        assert_eq!(got, want, "{name}");

        let mut case = json!({
            "name": name,
            "chainId": chain_id,
            "slot": slot,
            "leaf": leaf,
            "message": hex0x(msg),
            "entry": hex0x(bytes),
            "expected": want.is_ok(),
        });
        match want {
            Ok(()) => {
                let index = derive::leaf_index(slot, leaf, height);
                let key = derive::leaf(&master, GENERATION, index, chain_id);
                let entry = Entry::decode(bytes, height).unwrap();
                case["publicSeed"] = hex0x(&key.public_seed).into();
                case["publicKeyHash"] = hex0x(&key.public_key_hash).into();
                case["signature"] = hex0x(entry.signature.as_flattened()).into();
                case["authPath"] = entry.auth_path.iter().map(|w| hex0x(w)).collect();
            }
            Err(reject) => case["reason"] = reject.reason().into(),
        }
        cases.push(case);
    };

    use Reject::*;
    let path_levels = [0, height as usize / 2, (height + SLOT_BITS) as usize - 1];
    for (leaf, level) in [0, middle, last].into_iter().zip(path_levels) {
        let msg = message(c0, leaf);
        let good = sign(c0, leaf, &msg);
        let name = |what: &str| format!("leaf{leaf}-{what}");
        push(name("valid"), c0, 0, leaf, &msg, &good, Ok(()));
        push(
            name("flipped-byte"),
            c0,
            0,
            leaf,
            &msg,
            &flip(&good, 2 + 100),
            Err(RootMismatch),
        );
        push(
            name("wrong-leaf-index"),
            c0,
            0,
            leaf ^ 1,
            &msg,
            &good,
            Err(RootMismatch),
        );
        push(
            name("bad-version"),
            c0,
            0,
            leaf,
            &msg,
            &set(&good, 0, 0x02),
            Err(BadVersion),
        );
        let bad_path = flip(&good, path_word(level));
        push(
            name("wrong-path-element"),
            c0,
            0,
            leaf,
            &msg,
            &bad_path,
            Err(RootMismatch),
        );
    }

    let leaf = 5 & last;
    let msg = message(c1, leaf);
    let good = sign(c1, leaf, &msg);
    push(
        format!("slot1-leaf{leaf}-valid"),
        c1,
        1,
        leaf,
        &msg,
        &good,
        Ok(()),
    );
    let slot_zero = set(&good, 1, 0);
    push(
        format!("slot1-leaf{leaf}-slot-byte-0"),
        c1,
        1,
        leaf,
        &msg,
        &slot_zero,
        Err(RootMismatch),
    );

    let msg = message(c0, 0);
    let good = sign(c0, 0, &msg);
    let another = keccak(&[b"nonce-bound-pq-wallet/another-message"]);
    let truncated = &good[..good.len() - 1];
    push(
        "leaf0-wrong-chain".into(),
        other_chain,
        0,
        0,
        &msg,
        &good,
        Err(RootMismatch),
    );
    push(
        "leaf0-wrong-message".into(),
        c0,
        0,
        0,
        &another,
        &good,
        Err(RootMismatch),
    );
    push(
        "leaf0-bad-slot".into(),
        c0,
        0,
        0,
        &msg,
        &set(&good, 1, 16),
        Err(BadSlot),
    );
    push(
        "leaf0-truncated".into(),
        c0,
        0,
        0,
        &msg,
        truncated,
        Err(BadEntryLength),
    );
    push(
        "leaf0-leaf-out-of-range".into(),
        c0,
        0,
        1 << height,
        &msg,
        &good,
        Err(LeafOutOfRange),
    );

    json!({
        "version": VERSION,
        "note": "masterSeed is a public throwaway for tests: never fund an account built from it",
        "params": {
            "hash": "keccak256",
            "n": 32,
            "w": wots::W,
            "hashChains": wots::LEN,
            "height": height,
            "slotBits": SLOT_BITS,
            "generation": GENERATION,
            "chainIds": chains,
        },
        "masterSeed": hex0x(&master),
        "treeSeed": hex0x(&tree_seed),
        "root": hex0x(&root),
        "cases": cases,
    })
}
