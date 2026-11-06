use tiny_keccak::{Hasher, Keccak};

pub type Hash = [u8; 32];

pub fn keccak(parts: &[&[u8]]) -> Hash {
    let mut hasher = Keccak::v256();
    parts.iter().for_each(|part| hasher.update(part));
    let mut out = [0; 32];
    hasher.finalize(&mut out);
    out
}
