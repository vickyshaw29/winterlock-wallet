use tiny_keccak::{Hasher, Keccak};

pub type Hash = [u8; 32];

/// keccak256 of the parts concatenated, the same bytes as Solidity's abi.encodePacked.
pub fn keccak(parts: &[&[u8]]) -> Hash {
    let mut hasher = Keccak::v256();
    for part in parts {
        hasher.update(part);
    }
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}
