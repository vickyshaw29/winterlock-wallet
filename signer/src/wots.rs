//! WOTS+ in Quip's wire format. The normative reference is
//! contracts/lib/hashsigs-solidity/contracts/WOTSPlus.sol; match it, not the spec table.

use crate::hash::{Hash, keccak};

/// Winternitz parameter: each chain has positions 0..=15.
pub const W: usize = 16;
/// Message digits: 32 bytes = 64 base-16 digits.
pub const LEN1: usize = 64;
/// Checksum digits: the checksum is at most 64 × 15 = 960 < 16^3.
pub const LEN2: usize = 3;
/// Chains per key, one per digit.
pub const LEN: usize = LEN1 + LEN2;
/// Signature size in bytes: one 32-byte chain value per digit.
pub const SIG_BYTES: usize = LEN * 32;

pub type Masks = [Hash; W];
/// One 32-byte value per chain: secrets, a signature, or chain ends.
pub type Chains = [Hash; LEN];

/// r[k] = keccak(0x03 ‖ publicSeed ‖ uint16(k)). Quip derives 67 of these, but a
/// chain only ever reads r[1..=15], so 16 are enough.
pub fn masks(public_seed: &Hash) -> Masks {
    std::array::from_fn(|k| keccak(&[&[0x03], public_seed, &(k as u16).to_be_bytes()]))
}

/// Walks `steps` positions up the chain from position `from`.
/// The step into position p computes keccak(x ⊕ r[p]).
pub fn chain(x: &Hash, masks: &Masks, from: usize, steps: usize) -> Hash {
    debug_assert!(from + steps < W);
    let mut out = *x;
    for pos in from + 1..=from + steps {
        out = keccak(&[&xor(&out, &masks[pos])]);
    }
    out
}

/// The 64 message digits (high nibble first) followed by the 3 checksum digits.
pub fn digits(msg: &Hash) -> [u8; LEN] {
    let mut d = [0u8; LEN];
    for (i, byte) in msg.iter().enumerate() {
        d[2 * i] = byte >> 4;
        d[2 * i + 1] = byte & 0x0f;
    }
    // Raising any message digit lowers the checksum, and lowering a checksum
    // digit would mean walking its chain backwards.
    let csum: u16 = d[..LEN1].iter().map(|&x| (W as u16 - 1) - x as u16).sum();
    // Quip shifts left by 4 and reads three nibbles from the top; that is the
    // 12-bit checksum's nibbles, most significant first.
    d[LEN1] = (csum >> 8) as u8 & 0x0f;
    d[LEN1 + 1] = (csum >> 4) as u8 & 0x0f;
    d[LEN1 + 2] = csum as u8 & 0x0f;
    d
}

/// keccak of the 67 chain ends (2,144 bytes), the 32-byte public key hash.
pub fn public_key_hash(sk: &Chains, public_seed: &Hash) -> Hash {
    let r = masks(public_seed);
    hash_ends(&std::array::from_fn(|j| chain(&sk[j], &r, 0, W - 1)))
}

/// Reveals position d_j of chain j for every digit.
pub fn sign(sk: &Chains, public_seed: &Hash, msg: &Hash) -> Chains {
    let r = masks(public_seed);
    let d = digits(msg);
    std::array::from_fn(|j| chain(&sk[j], &r, 0, d[j] as usize))
}

/// Walks every revealed value the rest of the way to position 15 and hashes the ends.
pub fn recover_public_key_hash(sig: &Chains, public_seed: &Hash, msg: &Hash) -> Hash {
    let r = masks(public_seed);
    let d = digits(msg);
    hash_ends(&std::array::from_fn(|j| {
        let dj = d[j] as usize;
        chain(&sig[j], &r, dj, W - 1 - dj)
    }))
}

pub fn verify(public_seed: &Hash, public_key_hash: &Hash, msg: &Hash, sig: &Chains) -> bool {
    recover_public_key_hash(sig, public_seed, msg) == *public_key_hash
}

fn hash_ends(ends: &Chains) -> Hash {
    keccak(&[ends.as_flattened()])
}

fn xor(a: &Hash, b: &Hash) -> Hash {
    std::array::from_fn(|i| a[i] ^ b[i])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(k: u32) -> (Chains, Hash) {
        let sk = std::array::from_fn(|j| keccak(&[b"sk", &k.to_be_bytes(), &[j as u8]]));
        (sk, keccak(&[b"seed", &k.to_be_bytes()]))
    }

    #[test]
    fn digits_split_nibbles_high_first() {
        let mut msg = [0u8; 32];
        msg[0] = 0xa3;
        let d = digits(&msg);
        assert_eq!((d[0], d[1]), (10, 3));
    }

    #[test]
    fn checksum_of_extreme_messages() {
        // 64 zero digits: 64 × 15 = 960 = 0x3c0.
        assert_eq!(digits(&[0x00; 32])[LEN1..], [3, 12, 0]);
        // 64 digits of 15: nothing left to add.
        assert_eq!(digits(&[0xff; 32])[LEN1..], [0, 0, 0]);
    }

    #[test]
    fn round_trip_1000_messages() {
        for k in 0..1000u32 {
            let (sk, seed) = key(k);
            let msg = keccak(&[&k.to_be_bytes()]);
            let pk = public_key_hash(&sk, &seed);
            assert!(
                verify(&seed, &pk, &msg, &sign(&sk, &seed, &msg)),
                "message {k}"
            );
        }
    }

    #[test]
    fn tampering_fails() {
        let (sk, seed) = key(7);
        let msg = keccak(&[b"msg"]);
        let pk = public_key_hash(&sk, &seed);
        let sig = sign(&sk, &seed, &msg);

        for chain_index in [0, 33, LEN1, LEN - 1] {
            let mut bad = sig;
            bad[chain_index][31] ^= 1;
            assert!(
                !verify(&seed, &pk, &msg, &bad),
                "flipped bit in chain {chain_index}"
            );
        }
        assert!(
            !verify(&seed, &pk, &keccak(&[b"other"]), &sig),
            "wrong message"
        );
        assert!(
            !verify(&keccak(&[b"other seed"]), &pk, &msg, &sig),
            "wrong seed"
        );
    }
}
