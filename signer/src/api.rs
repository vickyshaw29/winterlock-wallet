use serde_json::{Value, json};

use crate::codec::{hex0x, parse_hash, parse_hex, words_json};
use crate::entry::Entry;
use crate::error::Error;
use crate::hash::Hash;
use crate::ticket::{self, Ticket};
use crate::tree::{self, Tree};
use crate::{keys, scheme};

#[derive(Debug, PartialEq, Eq)]
pub struct Fail {
    pub code: &'static str,
    pub detail: String,
}

pub fn fail(code: &'static str, detail: impl Into<String>) -> Fail {
    Fail {
        code,
        detail: detail.into(),
    }
}

impl From<Error> for Fail {
    fn from(e: Error) -> Fail {
        match e {
            Error::BadVersion | Error::BadSlot | Error::RootMismatch => {
                fail("verify_failed", e.as_str())
            }
            _ => fail(e.as_str(), e.to_string()),
        }
    }
}

pub struct Keys {
    pub master: Hash,
    pub generation: u32,
    pub height: u8,
    pub chains: Vec<u64>,
}

impl Keys {
    fn tree(&self) -> Result<Tree, Error> {
        Tree::build(&self.master, self.generation, self.height, &self.chains)
    }
}

pub fn seed(hex: &str) -> Result<Hash, Fail> {
    parse_hash(hex.trim()).ok_or_else(|| fail("bad_seed", "seed must be 32 bytes of hex"))
}

fn msg(hex: &str) -> Result<Hash, Fail> {
    parse_hash(hex).ok_or_else(|| fail("bad_msg_length", "msg must be 32 bytes of hex"))
}

fn entry_json(leaf: u32, entry: &Entry) -> Value {
    json!({
        "slot": entry.slot,
        "leaf": leaf,
        "signature": hex0x(entry.signature.as_flattened()),
        "authPath": words_json(&entry.auth_path),
        "entry": hex0x(&entry.encode()),
    })
}

pub fn keygen(k: &Keys) -> Result<Value, Fail> {
    let tree = k.tree()?;
    Ok(json!({
        "treeSeed": hex0x(&tree.tree_seed()),
        "root": hex0x(&tree.root()),
        "height": k.height,
        "generation": k.generation,
        "chains": k.chains,
        "leafCountPerChain": 1u64 << k.height,
    }))
}

pub fn pubkey(k: &Keys, chain_id: u64, leaf: u32) -> Result<Value, Fail> {
    let slot = tree::slot_of(&k.chains, chain_id)?;
    keys::check(k.height, leaf)?;
    let index = keys::index(slot, leaf, k.height);
    let key = keys::leaf(&k.master, k.generation, index, chain_id);
    Ok(json!({
        "chainId": chain_id,
        "slot": slot,
        "leaf": leaf,
        "index": index,
        "publicSeed": hex0x(&key.public_seed),
        "publicKeyHash": hex0x(&key.public_key_hash),
        "leafNode": hex0x(&key.node),
    }))
}

pub fn sign(k: &Keys, chain_id: u64, leaf: u32, message: &str) -> Result<Value, Fail> {
    let message = msg(message)?;
    Ok(entry_json(
        leaf,
        &scheme::sign(&k.tree()?, chain_id, leaf, &message)?,
    ))
}

pub fn sign_ticket(
    ticket: &Value,
    chain_id: Option<u64>,
    leaf: u32,
    message: &str,
) -> Result<Value, Fail> {
    let message = msg(message)?;
    let ticket = Ticket::from_json(ticket).ok_or(Error::BadTicket)?;
    if chain_id.is_some_and(|id| id != ticket.chain_id) {
        return Err(Error::BadChain.into());
    }
    Ok(entry_json(leaf, &ticket.sign(leaf, &message)?))
}

pub fn verify(
    tree_seed: &str,
    root: &str,
    height: u8,
    chain_id: u64,
    leaf: u32,
    message: &str,
    entry: &str,
) -> Result<Value, Fail> {
    let hash = |s: &str, name: &str| {
        parse_hash(s).ok_or_else(|| fail("bad_args", format!("{name} must be 32 bytes of hex")))
    };
    let (tree_seed, root) = (hash(tree_seed, "tree seed")?, hash(root, "root")?);
    let entry = parse_hex(entry).ok_or(Error::BadEntryLength)?;
    scheme::verify(
        &tree_seed,
        &root,
        height,
        chain_id,
        leaf,
        &msg(message)?,
        &entry,
    )?;
    Ok(json!({ "ok": true }))
}

pub fn export(k: &Keys, chain_id: u64, from: u32, to: u32, hot_start: u32) -> Result<Value, Fail> {
    if from < hot_start {
        let detail =
            format!("leaf {from} is below hot start {hot_start}: cold leaves have no caps");
        return Err(fail("leaf_out_of_range", detail));
    }
    Ok(ticket::export(&k.tree()?, chain_id, from, to)?.to_json())
}
