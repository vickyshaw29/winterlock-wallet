//! The many-time scheme: one WOTS+ key per leaf plus its path to the root.
//! `verify` runs steps 3 to 8 of the account's verify frame in the same order. The
//! account also checks the nonce mode, the epoch, the signature count and the hot
//! policy, which this crate never sees.

use crate::derive;
use crate::entry::Entry;
use crate::hash::Hash;
use crate::tree::{self, Tree};
use crate::wots;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignError {
    BadChain,
    LeafOutOfRange,
}

/// Why `verify` refused an entry. Everything after the format checks is a root
/// mismatch: the hashes cannot say which part was wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    LeafOutOfRange,
    BadEntryLength,
    BadVersion,
    BadSlot,
    RootMismatch,
}

impl Reject {
    pub fn reason(self) -> &'static str {
        match self {
            Reject::LeafOutOfRange => "leaf_out_of_range",
            Reject::BadEntryLength => "bad_entry_length",
            Reject::BadVersion => "bad_version",
            Reject::BadSlot => "bad_slot",
            Reject::RootMismatch => "root_mismatch",
        }
    }
}

/// Builds the tree (about 0.36 s per listed chain at h = 10) and signs one leaf.
pub fn sign(
    master: &Hash,
    generation: u32,
    height: u8,
    chains: &[u64],
    chain_id: u64,
    leaf: u32,
    msg: &Hash,
) -> Result<Entry, SignError> {
    if !chains.contains(&chain_id) {
        return Err(SignError::BadChain);
    }
    if leaf >= 1 << height {
        return Err(SignError::LeafOutOfRange);
    }
    let tree = Tree::build(master, generation, height, chains);
    sign_with(&tree, master, generation, chain_id, leaf, msg)
}

/// Signs with a tree already built from the same master seed and generation.
pub fn sign_with(
    tree: &Tree,
    master: &Hash,
    generation: u32,
    chain_id: u64,
    leaf: u32,
    msg: &Hash,
) -> Result<Entry, SignError> {
    let slot = tree.slot_of(chain_id).ok_or(SignError::BadChain)?;
    let height = tree.height();
    if leaf >= 1 << height {
        return Err(SignError::LeafOutOfRange);
    }

    let index = derive::leaf_index(slot, leaf, height);
    let public_seed = derive::public_seed(&derive::tree_seed(master, generation), index);
    let sk = derive::secrets(master, generation, index);

    // A tree from another seed or generation would yield an entry that never verifies.
    let pk = wots::public_key_hash(&sk, &public_seed);
    assert_eq!(
        derive::leaf_node(&public_seed, chain_id, &pk),
        tree.leaf_node(slot, leaf),
        "tree was built from a different master seed or generation"
    );

    Ok(Entry {
        slot,
        signature: wots::sign(&sk, &public_seed, msg),
        auth_path: tree.auth_path(slot, leaf),
    })
}

pub fn verify(
    tree_seed: &Hash,
    root: &Hash,
    height: u8,
    chain_id: u64,
    leaf: u32,
    msg: &Hash,
    entry: &[u8],
) -> Result<(), Reject> {
    if leaf >= 1 << height {
        return Err(Reject::LeafOutOfRange);
    }
    let entry = Entry::decode(entry, height)?;

    let index = derive::leaf_index(entry.slot, leaf, height);
    let public_seed = derive::public_seed(tree_seed, index);
    let pk = wots::recover_public_key_hash(&entry.signature, &public_seed, msg);
    let node = derive::leaf_node(&public_seed, chain_id, &pk);

    if tree::root_from_path(&node, index, &entry.auth_path) == *root {
        Ok(())
    } else {
        Err(Reject::RootMismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry;
    use crate::hash::keccak;

    const MASTER: Hash = [9; 32];
    const G: u32 = 1;
    const H: u8 = 3;
    const CHAINS: [u64; 2] = [1337, 11155111];

    struct Fixture {
        tree: Tree,
        tree_seed: Hash,
        msg: Hash,
    }

    impl Fixture {
        fn new() -> Fixture {
            Fixture {
                tree: Tree::build(&MASTER, G, H, &CHAINS),
                tree_seed: derive::tree_seed(&MASTER, G),
                msg: keccak(&[b"frame tx sig hash"]),
            }
        }

        fn sign(&self, chain_id: u64, leaf: u32) -> Vec<u8> {
            sign_with(&self.tree, &MASTER, G, chain_id, leaf, &self.msg)
                .unwrap()
                .encode()
        }

        fn verify(&self, chain_id: u64, leaf: u32, msg: &Hash, entry: &[u8]) -> Result<(), Reject> {
            verify(
                &self.tree_seed,
                &self.tree.root(),
                H,
                chain_id,
                leaf,
                msg,
                entry,
            )
        }
    }

    #[test]
    fn signs_and_verifies_first_middle_and_last_leaf_in_every_slot() {
        let f = Fixture::new();
        for chain_id in CHAINS {
            for leaf in [0, 3, 7] {
                let entry = f.sign(chain_id, leaf);
                assert_eq!(entry.len(), entry::len(H));
                assert_eq!(
                    f.verify(chain_id, leaf, &f.msg, &entry),
                    Ok(()),
                    "chain {chain_id} leaf {leaf}"
                );
            }
        }
    }

    #[test]
    fn real_size_entry_at_height_10() {
        let tree = Tree::build(&MASTER, G, 10, &[1337]);
        let msg = keccak(&[b"h10"]);
        let entry = sign_with(&tree, &MASTER, G, 1337, 777, &msg)
            .unwrap()
            .encode();
        assert_eq!(entry.len(), 2594);
        let tree_seed = derive::tree_seed(&MASTER, G);
        assert_eq!(
            verify(&tree_seed, &tree.root(), 10, 1337, 777, &msg, &entry),
            Ok(())
        );
    }

    #[test]
    fn each_tampering_is_refused() {
        let f = Fixture::new();
        let (chain_id, leaf) = (11155111, 5);
        let good = f.sign(chain_id, leaf);
        let flip = |at: usize, to: Option<u8>| {
            let mut bytes = good.clone();
            bytes[at] = to.unwrap_or(bytes[at] ^ 1);
            bytes
        };
        let other_msg = keccak(&[b"another tx"]);

        use Reject::*;
        // (name, chain id, leaf, message, entry bytes, expected rejection)
        type Case<'a> = (&'a str, u64, u32, &'a Hash, Vec<u8>, Reject);
        let cases: [Case; 10] = [
            (
                "signature byte",
                chain_id,
                leaf,
                &f.msg,
                flip(2 + 100, None),
                RootMismatch,
            ),
            (
                "path element",
                chain_id,
                leaf,
                &f.msg,
                flip(good.len() - 1, None),
                RootMismatch,
            ),
            (
                "wrong leaf",
                chain_id,
                leaf ^ 1,
                &f.msg,
                good.clone(),
                RootMismatch,
            ),
            ("wrong chain", 1, leaf, &f.msg, good.clone(), RootMismatch),
            (
                "wrong message",
                chain_id,
                leaf,
                &other_msg,
                good.clone(),
                RootMismatch,
            ),
            (
                "other valid slot",
                chain_id,
                leaf,
                &f.msg,
                flip(1, Some(0)),
                RootMismatch,
            ),
            (
                "version 0x02",
                chain_id,
                leaf,
                &f.msg,
                flip(0, Some(0x02)),
                BadVersion,
            ),
            (
                "slot 16",
                chain_id,
                leaf,
                &f.msg,
                flip(1, Some(16)),
                BadSlot,
            ),
            (
                "truncated",
                chain_id,
                leaf,
                &f.msg,
                good[..good.len() - 1].to_vec(),
                BadEntryLength,
            ),
            (
                "leaf 2^h",
                chain_id,
                1 << H,
                &f.msg,
                good.clone(),
                LeafOutOfRange,
            ),
        ];
        for (name, chain_id, leaf, msg, entry, want) in cases {
            assert_eq!(f.verify(chain_id, leaf, msg, &entry), Err(want), "{name}");
        }
    }

    #[test]
    fn sign_refuses_bad_inputs() {
        let f = Fixture::new();
        assert_eq!(
            sign(&MASTER, G, H, &CHAINS, 1, 0, &f.msg),
            Err(SignError::BadChain)
        );
        assert_eq!(
            sign(&MASTER, G, H, &CHAINS, 1337, 8, &f.msg),
            Err(SignError::LeafOutOfRange)
        );
        assert_eq!(
            sign_with(&f.tree, &MASTER, G, 1, 0, &f.msg),
            Err(SignError::BadChain)
        );
    }

    #[test]
    #[should_panic(expected = "different master seed or generation")]
    fn sign_with_a_mismatched_tree_panics() {
        let f = Fixture::new();
        let _ = sign_with(&f.tree, &MASTER, G + 1, 1337, 0, &f.msg);
    }

    #[test]
    fn decode_inverts_encode() {
        let f = Fixture::new();
        let entry = sign_with(&f.tree, &MASTER, G, 1337, 6, &f.msg).unwrap();
        assert_eq!(Entry::decode(&entry.encode(), H), Ok(entry));
    }
}
