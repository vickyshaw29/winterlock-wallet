//! Every secret and seed of the tree comes from one 32-byte master seed S.
//! Byte layouts follow Solidity's abi.encodePacked, because the Yul verifier
//! rebuilds the public ones (P_i and the leaf node).

use crate::hash::{Hash, keccak};
use crate::wots::{self, Chains};

/// T = keccak(0x02 ‖ S ‖ uint32 g). Public: the account stores it.
pub fn tree_seed(master: &Hash, generation: u32) -> Hash {
    keccak(&[&[0x02], master, &generation.to_be_bytes()])
}

/// i = (slot << h) | leaf. The slot picks the chain's subtree, the leaf comes from the nonce key.
pub fn leaf_index(slot: u8, leaf: u32, height: u8) -> u32 {
    debug_assert!(slot < 16 && height <= 28 && leaf < 1 << height);
    (u32::from(slot) << height) | leaf
}

/// P_i = keccak(T ‖ uint32 i). Public: the verifier recomputes it from T and i.
pub fn public_seed(tree_seed: &Hash, index: u32) -> Hash {
    keccak(&[tree_seed, &index.to_be_bytes()])
}

/// sk_i,j = keccak(0x01 ‖ S ‖ uint32 g ‖ uint32 i ‖ uint8 j), one per hash chain j in 0..67.
pub fn secrets(master: &Hash, generation: u32, index: u32) -> Chains {
    let (g, i) = (generation.to_be_bytes(), index.to_be_bytes());
    std::array::from_fn(|j| keccak(&[&[0x01], master, &g, &i, &[j as u8]]))
}

/// L_i = keccak(P_i ‖ uint256 chainId ‖ pk_i). The verifier reads chainId from CHAINID.
pub fn leaf_node(public_seed: &Hash, chain_id: u64, public_key_hash: &Hash) -> Hash {
    let mut chain_id_word = [0u8; 32];
    chain_id_word[24..].copy_from_slice(&chain_id.to_be_bytes());
    keccak(&[public_seed, &chain_id_word, public_key_hash])
}

/// The public side of one leaf, which the tree (B3) and `pubkey` (B5) need.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Leaf {
    pub public_seed: Hash,
    pub public_key_hash: Hash,
    pub node: Hash,
}

pub fn leaf(master: &Hash, generation: u32, index: u32, chain_id: u64) -> Leaf {
    let public_seed = public_seed(&tree_seed(master, generation), index);
    let public_key_hash = wots::public_key_hash(&secrets(master, generation, index), &public_seed);
    Leaf {
        public_seed,
        public_key_hash,
        node: leaf_node(&public_seed, chain_id, &public_key_hash),
    }
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

    const MASTER: Hash = {
        let mut s = [0u8; 32];
        let mut k = 0;
        while k < 32 {
            s[k] = k as u8;
            k += 1;
        }
        s
    };

    // Expected values from viem's encodePacked + keccak256, an independent
    // implementation of abi.encodePacked: g = 3, i = (2 << 10) | 517 = 2565,
    // j = 42, chainId = 11155111 (Sepolia), pk = 0xabab…ab.
    #[test]
    fn matches_viem_encode_packed() {
        let (g, i) = (3, leaf_index(2, 517, 10));
        assert_eq!(i, 2565);

        let t = tree_seed(&MASTER, g);
        assert_eq!(
            t,
            h("0x5f9b2f2c6a6397a7e2e6bf5f523fa212c45770c133d25ab8cd70ec4896203117")
        );
        let p = public_seed(&t, i);
        assert_eq!(
            p,
            h("0x9356cbfb6f35c6c3258e8d8417e7a4a339c3c894fe41e0eac75e6deb1809d5ed")
        );
        assert_eq!(
            secrets(&MASTER, g, i)[42],
            h("0x22e7ef43aaf0b6b7a401094795a71aa8b6df5f1789da9597cee482f98d5bdff4")
        );
        assert_eq!(
            leaf_node(&p, 11155111, &[0xab; 32]),
            h("0x5bb9a81e858dae379e971fd2c045aaf62d14d28902b9c5c897f23bd7c1c36175")
        );
    }

    #[test]
    fn leaf_index_puts_the_slot_above_the_leaf() {
        assert_eq!(leaf_index(0, 5, 10), 5);
        assert_eq!(leaf_index(1, 5, 10), 1029);
        assert_eq!(leaf_index(15, 1023, 10), 16383);
    }

    #[test]
    fn every_input_separates_the_secrets() {
        let base = secrets(&MASTER, 0, 5);
        assert_ne!(base, secrets(&MASTER, 1, 5), "generation");
        assert_ne!(base, secrets(&MASTER, 0, leaf_index(1, 5, 10)), "slot");
        assert_ne!(base, secrets(&[0xff; 32], 0, 5), "master seed");

        let mut chains = base.to_vec();
        chains.sort();
        chains.dedup();
        assert_eq!(chains.len(), wots::LEN, "hash chains within one key");
    }

    #[test]
    fn public_seeds_and_nodes_separate() {
        let t0 = tree_seed(&MASTER, 0);
        assert_ne!(t0, tree_seed(&MASTER, 1), "generation changes T");
        assert_ne!(public_seed(&t0, 5), public_seed(&t0, 6), "index changes P");

        let leaf = leaf(&MASTER, 0, 5, 1337);
        let other_chain = leaf_node(&leaf.public_seed, 11155111, &leaf.public_key_hash);
        assert_ne!(leaf.node, other_chain, "chain id changes the node");
    }

    #[test]
    fn derived_key_signs_and_verifies() {
        let (g, i) = (2, leaf_index(1, 700, 10));
        let sk = secrets(&MASTER, g, i);
        let leaf = leaf(&MASTER, g, i, 1337);
        let msg = keccak(&[b"tx sig hash"]);

        let sig = wots::sign(&sk, &leaf.public_seed, &msg);
        assert!(wots::verify(
            &leaf.public_seed,
            &leaf.public_key_hash,
            &msg,
            &sig
        ));
        assert_eq!(leaf, super::leaf(&MASTER, g, i, 1337), "deterministic");
    }
}
