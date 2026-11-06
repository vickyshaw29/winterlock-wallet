#![allow(dead_code)]

use serde_json::Value;
use signer::codec::{json_hash, parse_hex};
use signer::hash::{Hash, keccak};

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    keccak(&[data])
}

pub fn hash(v: &Value) -> Hash {
    json_hash(v).unwrap()
}

pub fn bytes(v: &Value) -> Vec<u8> {
    parse_hex(v.as_str().unwrap()).unwrap()
}

pub fn read_json(path: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
