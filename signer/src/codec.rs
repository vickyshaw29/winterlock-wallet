use serde_json::Value;

use crate::hash::Hash;

pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

pub fn parse_hex(s: &str) -> Option<Vec<u8>> {
    let digits = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"));
    hex::decode(digits.unwrap_or(s)).ok()
}

pub fn parse_hash(s: &str) -> Option<Hash> {
    parse_hex(s)?.try_into().ok()
}

pub fn words_json(words: &[Hash]) -> Value {
    words.iter().map(|w| hex0x(w)).collect()
}

pub fn json_hash(v: &Value) -> Option<Hash> {
    parse_hash(v.as_str()?)
}

pub fn json_words(v: &Value) -> Option<Vec<Hash>> {
    v.as_array()?.iter().map(json_hash).collect()
}
