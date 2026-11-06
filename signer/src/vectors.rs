use serde_json::{Value, json};

use crate::codec::{hex0x, words_json};
use crate::consts::{
    ENTRY_HEADER, LEN, SIG_BYTES, SLOT_BITS, VECTOR_MESSAGE_LABEL, VECTOR_OTHER_MESSAGE_LABEL,
    VECTOR_SEED_LABEL, VECTORS_VERSION, W,
};
use crate::entry::Entry;
use crate::error::Error;
use crate::hash::{Hash, keccak};
use crate::tree::Tree;
use crate::{keys, scheme};

pub fn generate(height: u8, chains: &[u64]) -> Result<Value, Error> {
    if height < 2 {
        return Err(Error::BadHeight);
    }
    if chains.len() < 2 {
        return Err(Error::BadChain);
    }
    let master = keccak(&[VECTOR_SEED_LABEL]);
    let tree = Tree::build(&master, 0, height, chains)?;
    let (tree_seed, root) = (tree.tree_seed(), tree.root());
    let (c0, c1, last) = (chains[0], chains[1], (1 << height) - 1);
    let other_chain = (1..).find(|c| !chains.contains(c)).unwrap();

    let message = |chain_id: u64, leaf: u32| {
        keccak(&[
            VECTOR_MESSAGE_LABEL,
            &chain_id.to_be_bytes(),
            &leaf.to_be_bytes(),
        ])
    };
    let sign = |chain_id: u64, leaf: u32, msg: &Hash| {
        scheme::sign(&tree, chain_id, leaf, msg).map(|e| e.encode())
    };
    let edit = |bytes: &[u8], at: usize, value: u8| {
        let mut out = bytes.to_vec();
        out[at] = value;
        out
    };
    let flip = |bytes: &[u8], at: usize| edit(bytes, at, bytes[at] ^ 1);

    let mut cases = Vec::new();
    let mut push = |name: String,
                    chain_id: u64,
                    slot: u8,
                    leaf: u32,
                    msg: &Hash,
                    entry: &[u8],
                    want: Result<(), Error>| {
        let got = scheme::verify(&tree_seed, &root, height, chain_id, leaf, msg, entry);
        assert_eq!(got, want, "{name}");
        let mut case = json!({
            "name": name,
            "chainId": chain_id,
            "slot": slot,
            "leaf": leaf,
            "message": hex0x(msg),
            "entry": hex0x(entry),
            "expected": want.is_ok(),
        });
        match want {
            Ok(()) => {
                let key = keys::leaf(&master, 0, keys::index(slot, leaf, height), chain_id);
                let decoded = Entry::decode(entry, height).unwrap();
                case["publicSeed"] = hex0x(&key.public_seed).into();
                case["publicKeyHash"] = hex0x(&key.public_key_hash).into();
                case["signature"] = hex0x(decoded.signature.as_flattened()).into();
                case["authPath"] = words_json(&decoded.auth_path);
            }
            Err(e) => case["reason"] = e.as_str().into(),
        }
        cases.push(case);
    };

    use Error::*;
    let path_levels = [0, height / 2, height + SLOT_BITS - 1];
    for (leaf, level) in [0, 0xaaaa_aaaa & last, last].into_iter().zip(path_levels) {
        let msg = message(c0, leaf);
        let good = sign(c0, leaf, &msg)?;
        let name = |what: &str| format!("leaf{leaf}-{what}");
        let path_byte = ENTRY_HEADER + SIG_BYTES + 32 * usize::from(level);
        push(name("valid"), c0, 0, leaf, &msg, &good, Ok(()));
        push(
            name("flipped-byte"),
            c0,
            0,
            leaf,
            &msg,
            &flip(&good, ENTRY_HEADER + 100),
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
            &edit(&good, 0, 2),
            Err(BadVersion),
        );
        push(
            name("wrong-path-element"),
            c0,
            0,
            leaf,
            &msg,
            &flip(&good, path_byte),
            Err(RootMismatch),
        );
    }

    let leaf = 5 & last;
    let msg = message(c1, leaf);
    let good = sign(c1, leaf, &msg)?;
    push(
        format!("slot1-leaf{leaf}-valid"),
        c1,
        1,
        leaf,
        &msg,
        &good,
        Ok(()),
    );
    push(
        format!("slot1-leaf{leaf}-slot-byte-0"),
        c1,
        1,
        leaf,
        &msg,
        &edit(&good, 1, 0),
        Err(RootMismatch),
    );

    let msg = message(c0, 0);
    let good = sign(c0, 0, &msg)?;
    let other_msg = keccak(&[VECTOR_OTHER_MESSAGE_LABEL]);
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
        &other_msg,
        &good,
        Err(RootMismatch),
    );
    push(
        "leaf0-bad-slot".into(),
        c0,
        0,
        0,
        &msg,
        &edit(&good, 1, 16),
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

    Ok(json!({
        "version": VECTORS_VERSION,
        "note": "masterSeed is a public throwaway for tests: never fund an account built from it",
        "params": {
            "hash": "keccak256",
            "n": 32,
            "w": W,
            "hashChains": LEN,
            "height": height,
            "slotBits": SLOT_BITS,
            "generation": 0,
            "chainIds": chains,
        },
        "masterSeed": hex0x(&master),
        "treeSeed": hex0x(&tree_seed),
        "root": hex0x(&root),
        "cases": cases,
    }))
}
