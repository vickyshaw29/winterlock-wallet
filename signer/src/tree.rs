use crate::consts::{EMPTY_SLOT_LABEL, SLOTS};
use crate::error::Error;
use crate::hash::{Hash, keccak};
use crate::wots::Chains;
use crate::{keys, merkle};

pub fn empty_subtree() -> Hash {
    keccak(&[EMPTY_SLOT_LABEL])
}

pub fn slot_of(chains: &[u64], chain_id: u64) -> Result<u8, Error> {
    check_chains(chains)?;
    let slot = chains.iter().position(|&c| c == chain_id);
    slot.map(|s| s as u8).ok_or(Error::BadChain)
}

fn check_chains(chains: &[u64]) -> Result<(), Error> {
    let unique = chains
        .iter()
        .enumerate()
        .all(|(i, c)| !chains[..i].contains(c));
    if chains.len() <= SLOTS && unique {
        Ok(())
    } else {
        Err(Error::BadChain)
    }
}

pub struct Tree {
    master: Hash,
    generation: u32,
    height: u8,
    chains: Vec<u64>,
    subtrees: Vec<Vec<Vec<Hash>>>,
    slots: Vec<Vec<Hash>>,
}

impl Tree {
    pub fn build(
        master: &Hash,
        generation: u32,
        height: u8,
        chains: &[u64],
    ) -> Result<Tree, Error> {
        keys::check(height, 0)?;
        check_chains(chains)?;
        let subtrees: Vec<_> = (0..)
            .zip(chains)
            .map(|(slot, &chain_id)| {
                let leaves = (0..1 << height).map(|leaf| {
                    keys::leaf(
                        master,
                        generation,
                        keys::index(slot, leaf, height),
                        chain_id,
                    )
                    .node
                });
                merkle::levels(leaves.collect())
            })
            .collect();
        let slot_roots = (0..SLOTS)
            .map(|s| {
                subtrees
                    .get(s)
                    .map_or_else(empty_subtree, |t| t[usize::from(height)][0])
            })
            .collect();
        Ok(Tree {
            master: *master,
            generation,
            height,
            chains: chains.to_vec(),
            subtrees,
            slots: merkle::levels(slot_roots),
        })
    }

    pub fn root(&self) -> Hash {
        self.slots[self.slots.len() - 1][0]
    }

    pub fn tree_seed(&self) -> Hash {
        keys::tree_seed(&self.master, self.generation)
    }

    pub fn height(&self) -> u8 {
        self.height
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn slot_of(&self, chain_id: u64) -> Result<u8, Error> {
        slot_of(&self.chains, chain_id)
    }

    pub fn secrets(&self, slot: u8, leaf: u32) -> Chains {
        keys::secrets(
            &self.master,
            self.generation,
            keys::index(slot, leaf, self.height),
        )
    }

    pub fn auth_path(&self, slot: u8, leaf: u32) -> Vec<Hash> {
        let mut path = merkle::path(&self.subtrees[usize::from(slot)], leaf as usize);
        path.extend(merkle::path(&self.slots, usize::from(slot)));
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::parse_hash;

    const MASTER: Hash = [7; 32];
    const CHAINS: [u64; 2] = [1337, 11155111];

    fn build(generation: u32, chains: &[u64]) -> Result<Tree, Error> {
        Tree::build(&MASTER, generation, 3, chains)
    }

    #[test]
    fn every_path_reaches_the_root() {
        let tree = build(0, &CHAINS).unwrap();
        for (slot, chain_id) in (0..).zip(CHAINS) {
            for leaf in 0..8 {
                let index = keys::index(slot, leaf, 3);
                let node = keys::leaf(&MASTER, 0, index, chain_id).node;
                let path = tree.auth_path(slot, leaf);
                assert_eq!(path.len(), 3 + 4);
                assert_eq!(merkle::root_from_path(&node, index, &path), tree.root());
            }
        }
    }

    #[test]
    fn unlisted_slots_are_empty() {
        let want = "0x9cf1d2bd08543bcb1064738c05b0aa055d171b1594a30210f2ede7454b1bea12";
        assert_eq!(Some(empty_subtree()), parse_hash(want));
        let tree = build(0, &CHAINS).unwrap();
        assert!(tree.slots[0][2..].iter().all(|r| *r == empty_subtree()));
    }

    #[test]
    fn chain_list_and_inputs() {
        let tree = build(0, &CHAINS).unwrap();
        assert_eq!(tree.slot_of(11155111), Ok(1));
        assert_eq!(tree.slot_of(1), Err(Error::BadChain));
        assert_eq!(tree.root(), build(0, &CHAINS).unwrap().root());
        assert_ne!(tree.root(), build(0, &[11155111, 1337]).unwrap().root());
        assert_ne!(tree.root(), build(1, &CHAINS).unwrap().root());
        assert_eq!(build(0, &[1, 1]).err(), Some(Error::BadChain));
        assert_eq!(
            build(0, &(0..17).collect::<Vec<_>>()).err(),
            Some(Error::BadChain)
        );
        assert_eq!(
            Tree::build(&MASTER, 0, 21, &[1]).err(),
            Some(Error::BadHeight)
        );
    }
}
