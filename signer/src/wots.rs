use crate::consts::{LEN, LEN1, TAG_MASK, W};
use crate::hash::{Hash, keccak};

pub type Chains = [Hash; LEN];

// Quip derives 67 masks, but chains only ever read r[1..=15].
pub fn masks(public_seed: &Hash) -> [Hash; W] {
    std::array::from_fn(|k| keccak(&[&[TAG_MASK], public_seed, &(k as u16).to_be_bytes()]))
}

fn chain(x: &Hash, masks: &[Hash; W], from: usize, steps: usize) -> Hash {
    masks[from + 1..=from + steps]
        .iter()
        .fold(*x, |out, mask| keccak(&[&xor(&out, mask)]))
}

pub fn digits(msg: &Hash) -> [u8; LEN] {
    let mut d = [0; LEN];
    for (i, byte) in msg.iter().enumerate() {
        d[2 * i] = byte >> 4;
        d[2 * i + 1] = byte & 0xf;
    }
    let csum: u16 = d[..LEN1].iter().map(|&x| W as u16 - 1 - u16::from(x)).sum();
    d[LEN1..].copy_from_slice(&[(csum >> 8) as u8, (csum >> 4) as u8 & 0xf, csum as u8 & 0xf]);
    d
}

pub fn public_key_hash(sk: &Chains, public_seed: &Hash) -> Hash {
    let r = masks(public_seed);
    hash_ends(std::array::from_fn(|j| chain(&sk[j], &r, 0, W - 1)))
}

pub fn sign(sk: &Chains, public_seed: &Hash, msg: &Hash) -> Chains {
    let (r, d) = (masks(public_seed), digits(msg));
    std::array::from_fn(|j| chain(&sk[j], &r, 0, d[j] as usize))
}

pub fn recover_public_key_hash(sig: &Chains, public_seed: &Hash, msg: &Hash) -> Hash {
    let (r, d) = (masks(public_seed), digits(msg));
    hash_ends(std::array::from_fn(|j| {
        chain(&sig[j], &r, d[j] as usize, W - 1 - d[j] as usize)
    }))
}

pub fn verify(public_seed: &Hash, public_key_hash: &Hash, msg: &Hash, sig: &Chains) -> bool {
    recover_public_key_hash(sig, public_seed, msg) == *public_key_hash
}

fn hash_ends(ends: Chains) -> Hash {
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
    fn digits_and_checksum() {
        let mut msg = [0; 32];
        msg[0] = 0xa3;
        assert_eq!(digits(&msg)[..2], [10, 3]);
        assert_eq!(digits(&[0; 32])[LEN1..], [3, 12, 0]);
        assert_eq!(digits(&[0xff; 32])[LEN1..], [0, 0, 0]);
    }

    #[test]
    fn round_trip() {
        for k in 0..1000 {
            let (sk, seed) = key(k);
            let msg = keccak(&[&k.to_be_bytes()]);
            let pk = public_key_hash(&sk, &seed);
            assert!(verify(&seed, &pk, &msg, &sign(&sk, &seed, &msg)));
        }
    }

    #[test]
    fn tampering_fails() {
        let (sk, seed) = key(7);
        let msg = keccak(&[b"msg"]);
        let (pk, sig) = (public_key_hash(&sk, &seed), sign(&sk, &seed, &msg));
        for j in [0, 33, LEN1, LEN - 1] {
            let mut bad = sig;
            bad[j][31] ^= 1;
            assert!(!verify(&seed, &pk, &msg, &bad));
        }
        assert!(!verify(&seed, &pk, &keccak(&[b"other"]), &sig));
        assert!(!verify(&keccak(&[b"other"]), &pk, &msg, &sig));
    }
}
