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

/// Always 0x-prefixed lowercase.
pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Accepts either case, with or without 0x.
pub fn parse_hex(s: &str) -> Option<Vec<u8>> {
    let digits = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    hex::decode(digits).ok()
}

pub fn parse_hash(s: &str) -> Option<Hash> {
    parse_hex(s)?.try_into().ok()
}
