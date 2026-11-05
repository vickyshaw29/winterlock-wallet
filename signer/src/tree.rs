//! The key tree: a 2^h subtree per listed chain under a 4-level layer of 16 chain
//! slots. Bit k of the full leaf index picks the side at level k: 0 means our node
//! is the left child.

use crate::derive;
use crate::hash::{Hash, keccak};

pub const SLOT_BITS: u8 = 4;
pub const SLOTS: usize = 1 << SLOT_BITS;
/// The full leaf index is a uint32 that also carries the 4 slot bits.
pub const MAX_HEIGHT: u8 = 32 - SLOT_BITS;

/// Stands at height h for every slot with no chain listed. Nobody knows a leaf under it.
pub fn empty_subtree() -> Hash {
    keccak(&[b"nonce-bound-pq-wallet/empty-slot"])
}

pub fn parent(left: &Hash, right: &Hash) -> Hash {
    keccak(&[left, right])
}

/// Every level from `base` up to the single root, pairing (0,1), (2,3), …
fn levels_above(base: Vec<Hash>) -> Vec<Vec<Hash>> {
    let mut levels = vec![base];
    while levels.last().unwrap().len() > 1 {
        let next = levels
            .last()
            .unwrap()
            .chunks(2)
            .map(|p| parent(&p[0], &p[1]))
            .collect();
        levels.push(next);
    }
    levels
}

pub struct Tree {
    height: u8,
    chains: Vec<u64>,
    /// One per listed chain, in slot order: level 0 holds the leaf nodes, level h the subtree root.
    subtrees: Vec<Vec<Vec<Hash>>>,
    /// The slot layer: level 0 holds the 16 subtree roots, level 4 the root.
    slots: Vec<Vec<Hash>>,
}

impl Tree {
    /// A chain id's position in `chains` is its slot.
    pub fn build(master: &Hash, generation: u32, height: u8, chains: &[u64]) -> Tree {
        assert!(
            height <= MAX_HEIGHT,
            "height {height} leaves no room for the slot bits"
        );
        assert!(chains.len() <= SLOTS, "at most {SLOTS} chains per tree");

        let subtrees: Vec<_> = (0..)
            .zip(chains)
            .map(|(slot, &chain_id)| {
                let leaves = (0..1u32 << height)
                    .map(|leaf| {
                        let index = derive::leaf_index(slot, leaf, height);
                        derive::leaf(master, generation, index, chain_id).node
                    })
                    .collect();
                levels_above(leaves)
            })
            .collect();

        let slot_roots = (0..SLOTS)
            .map(|s| {
                subtrees
                    .get(s)
                    .map_or_else(empty_subtree, |t| t[height as usize][0])
            })
            .collect();

        Tree {
            height,
            chains: chains.to_vec(),
            subtrees,
            slots: levels_above(slot_roots),
        }
    }

    pub fn root(&self) -> Hash {
        self.slots[SLOT_BITS as usize][0]
    }

    pub fn height(&self) -> u8 {
        self.height
    }

    pub fn chains(&self) -> &[u64] {
        &self.chains
    }

    pub fn slot_of(&self, chain_id: u64) -> Option<u8> {
        self.chains
            .iter()
            .position(|&c| c == chain_id)
            .map(|s| s as u8)
    }

    /// The slot must be a listed one (see `slot_of`) and the leaf below 2^h.
    pub fn leaf_node(&self, slot: u8, leaf: u32) -> Hash {
        self.subtrees[slot as usize][0][leaf as usize]
    }

    /// The h + 4 siblings from the leaf up to the root, leaf level first.
    pub fn auth_path(&self, slot: u8, leaf: u32) -> Vec<Hash> {
        let subtree = &self.subtrees[slot as usize];
        let inside = (0..self.height as usize).map(|k| subtree[k][(leaf as usize >> k) ^ 1]);
        let above = (0..SLOT_BITS as usize).map(|k| self.slots[k][(slot as usize >> k) ^ 1]);
        inside.chain(above).collect()
    }
}

/// The verifier's walk: from the leaf node, at level k hash in path[k] on the side
/// that bit k of the full index gives.
pub fn root_from_path(leaf_node: &Hash, index: u32, path: &[Hash]) -> Hash {
    path.iter()
        .enumerate()
        .fold(*leaf_node, |node, (k, sibling)| {
            if index >> k & 1 == 0 {
                parent(&node, sibling)
            } else {
                parent(sibling, &node)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Hash {
        hex::decode(s.trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap()
    }

    const MASTER: Hash = [7; 32];
    const CHAINS: [u64; 2] = [1337, 11155111];

    #[test]
    fn every_path_rebuilds_the_root() {
        let tree = Tree::build(&MASTER, 0, 3, &CHAINS);
        for slot in 0..2 {
            for leaf in 0..8 {
                let path = tree.auth_path(slot, leaf);
                assert_eq!(path.len(), 3 + 4);
                let index = derive::leaf_index(slot, leaf, 3);
                let node = tree.leaf_node(slot, leaf);
                assert_eq!(
                    root_from_path(&node, index, &path),
                    tree.root(),
                    "slot {slot} leaf {leaf}"
                );
            }
        }
    }

    #[test]
    fn leaf_nodes_come_from_derive() {
        let tree = Tree::build(&MASTER, 0, 3, &CHAINS);
        let index = derive::leaf_index(1, 5, 3);
        assert_eq!(
            tree.leaf_node(1, 5),
            derive::leaf(&MASTER, 0, index, 11155111).node
        );
    }

    // Expected values from viem: keccak256 of the string, and the same walk written
    // in TypeScript over fixed 32-byte words (0x1111…, 0x2222…, and so on).
    #[test]
    fn matches_viem() {
        assert_eq!(
            empty_subtree(),
            h("0x9cf1d2bd08543bcb1064738c05b0aa055d171b1594a30210f2ede7454b1bea12")
        );

        let word = |b: u8| [b; 32];
        let path3 = [word(0x22), word(0x33), word(0x44)];
        assert_eq!(
            root_from_path(&word(0x11), 5, &path3),
            h("0x4b223fcf644ca775a0492480beb7038df266e7141693be45888d922a9b1e7b77")
        );
        let path14: Vec<Hash> = (1..=14).map(word).collect();
        assert_eq!(
            root_from_path(&word(0xaa), 1029, &path14),
            h("0x0184b35c3fb66deaf6ce1645a3433cb0afd36e4935d217a797e5b3ae6c87b2bc")
        );
    }

    #[test]
    fn unlisted_slots_hold_the_empty_subtree() {
        let tree = Tree::build(&MASTER, 0, 3, &CHAINS);
        for slot in 2..SLOTS {
            assert_eq!(tree.slots[0][slot], empty_subtree(), "slot {slot}");
        }
        // Slot 0's sibling one level above the slot roots is the pair (slot 2, slot 3).
        let path = tree.auth_path(0, 0);
        assert_eq!(path[3 + 1], parent(&empty_subtree(), &empty_subtree()));
    }

    #[test]
    fn tampering_misses_the_root() {
        let tree = Tree::build(&MASTER, 0, 3, &CHAINS);
        let (slot, leaf) = (0, 5);
        let index = derive::leaf_index(slot, leaf, 3);
        let node = tree.leaf_node(slot, leaf);
        let path = tree.auth_path(slot, leaf);
        let root = tree.root();

        assert_ne!(root_from_path(&node, index ^ 1, &path), root, "wrong leaf");
        let other_slot = derive::leaf_index(1, leaf, 3);
        assert_ne!(root_from_path(&node, other_slot, &path), root, "wrong slot");

        let mut bad = path.clone();
        bad[2][0] ^= 1;
        assert_ne!(root_from_path(&node, index, &bad), root, "wrong sibling");

        // The same WOTS+ key bound to another chain id is a different leaf node.
        let key = derive::leaf(&MASTER, 0, index, 1337);
        let elsewhere = derive::leaf_node(&key.public_seed, 1, &key.public_key_hash);
        assert_ne!(
            root_from_path(&elsewhere, index, &path),
            root,
            "wrong chain"
        );
    }

    #[test]
    fn chain_list_order_is_the_slot_order() {
        let a = Tree::build(&MASTER, 0, 3, &[1337, 11155111]);
        let b = Tree::build(&MASTER, 0, 3, &[11155111, 1337]);
        assert_ne!(a.root(), b.root(), "order changes the root");
        assert_eq!(a.slot_of(11155111), Some(1));
        assert_eq!(b.slot_of(11155111), Some(0));
        assert_eq!(a.slot_of(1), None);

        let again = Tree::build(&MASTER, 0, 3, &[1337, 11155111]);
        assert_eq!(a.root(), again.root(), "deterministic");
        let rotated = Tree::build(&MASTER, 1, 3, &[1337, 11155111]);
        assert_ne!(a.root(), rotated.root(), "generation changes the root");
    }

    #[test]
    #[ignore = "timing: cargo test --release -- --ignored --nocapture"]
    fn build_h10_one_chain() {
        let start = std::time::Instant::now();
        let tree = Tree::build(&MASTER, 0, 10, &[1337]);
        eprintln!("h = 10, one chain: {:?}", start.elapsed());

        let path = tree.auth_path(0, 777);
        let node = tree.leaf_node(0, 777);
        assert_eq!(root_from_path(&node, 777, &path), tree.root());
    }
}
