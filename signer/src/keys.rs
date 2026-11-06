use crate::consts::{MAX_HEIGHT, TAG_SECRET, TAG_TREE_SEED};
use crate::error::Error;
use crate::hash::{Hash, keccak};
use crate::wots::{self, Chains};

pub fn tree_seed(master: &Hash, generation: u32) -> Hash {
    keccak(&[&[TAG_TREE_SEED], master, &generation.to_be_bytes()])
}

pub fn index(slot: u8, leaf: u32, height: u8) -> u32 {
    (u32::from(slot) << height) | leaf
}

pub fn check(height: u8, leaf: u32) -> Result<(), Error> {
    if height > MAX_HEIGHT {
        Err(Error::BadHeight)
    } else if leaf >= 1 << height {
        Err(Error::LeafOutOfRange)
    } else {
        Ok(())
    }
}

pub fn public_seed(tree_seed: &Hash, index: u32) -> Hash {
    keccak(&[tree_seed, &index.to_be_bytes()])
}

pub fn secrets(master: &Hash, generation: u32, index: u32) -> Chains {
    let (g, i) = (generation.to_be_bytes(), index.to_be_bytes());
    std::array::from_fn(|j| keccak(&[&[TAG_SECRET], master, &g, &i, &[j as u8]]))
}

pub fn leaf_node(public_seed: &Hash, chain_id: u64, public_key_hash: &Hash) -> Hash {
    let mut chain_word = [0; 32];
    chain_word[24..].copy_from_slice(&chain_id.to_be_bytes());
    keccak(&[public_seed, &chain_word, public_key_hash])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Leaf {
    pub public_seed: Hash,
    pub public_key_hash: Hash,
    pub node: Hash,
}

pub fn leaf(master: &Hash, generation: u32, index: u32, chain_id: u64) -> Leaf {
    let public_seed = public_seed(&tree_seed(master, generation), index);
    let public_key_hash = wots::public_key_hash(&secrets(master, generation, index), &public_seed);
    let node = leaf_node(&public_seed, chain_id, &public_key_hash);
    Leaf {
        public_seed,
        public_key_hash,
        node,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::parse_hash;

    fn master() -> Hash {
        std::array::from_fn(|k| k as u8)
    }

    // Expected values from viem's encodePacked + keccak256.
    #[test]
    fn matches_viem() {
        let want = |s| parse_hash(s).unwrap();
        let (g, i) = (3, index(2, 517, 10));
        let t = tree_seed(&master(), g);
        let p = public_seed(&t, i);
        assert_eq!(i, 2565);
        assert_eq!(
            t,
            want("0x5f9b2f2c6a6397a7e2e6bf5f523fa212c45770c133d25ab8cd70ec4896203117")
        );
        assert_eq!(
            p,
            want("0x9356cbfb6f35c6c3258e8d8417e7a4a339c3c894fe41e0eac75e6deb1809d5ed")
        );
        assert_eq!(
            secrets(&master(), g, i)[42],
            want("0x22e7ef43aaf0b6b7a401094795a71aa8b6df5f1789da9597cee482f98d5bdff4")
        );
        assert_eq!(
            leaf_node(&p, 11155111, &[0xab; 32]),
            want("0x5bb9a81e858dae379e971fd2c045aaf62d14d28902b9c5c897f23bd7c1c36175")
        );
    }

    #[test]
    fn index_and_check() {
        assert_eq!(
            [index(0, 5, 10), index(1, 5, 10), index(15, 1023, 10)],
            [5, 1029, 16383]
        );
        assert_eq!(check(21, 0), Err(Error::BadHeight));
        assert_eq!(check(3, 8), Err(Error::LeafOutOfRange));
        assert_eq!(check(3, 7), Ok(()));
    }

    #[test]
    fn every_input_separates() {
        let base = secrets(&master(), 0, 5);
        assert_ne!(base, secrets(&master(), 1, 5));
        assert_ne!(base, secrets(&master(), 0, index(1, 5, 10)));
        assert_ne!(base, secrets(&[0xff; 32], 0, 5));
        let mut chains = base.to_vec();
        chains.sort();
        chains.dedup();
        assert_eq!(chains.len(), base.len());

        let key = leaf(&master(), 0, 5, 1337);
        assert_ne!(
            key.node,
            leaf_node(&key.public_seed, 1, &key.public_key_hash)
        );
    }

    #[test]
    fn derived_key_signs() {
        let i = index(1, 700, 10);
        let key = leaf(&master(), 2, i, 1337);
        let msg = keccak(&[b"tx"]);
        let sig = wots::sign(&secrets(&master(), 2, i), &key.public_seed, &msg);
        assert!(wots::verify(
            &key.public_seed,
            &key.public_key_hash,
            &msg,
            &sig
        ));
    }
}
