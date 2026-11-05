use serde_json::{Value, json};
use signer::codec::{hex0x, parse_hash, parse_hex, words_json};
use signer::error::Error;
use signer::tree::{self, Tree};
use signer::{keys, scheme, ticket};

use crate::args::{ExportArgs, PubkeyArgs, SignArgs, TreeArgs, VectorArgs, VerifyArgs};
use crate::io::{msg, read_ticket, seed, write_json};
use crate::{Fail, fail};

fn build(a: &TreeArgs) -> Result<Tree, Fail> {
    Ok(Tree::build(
        &seed(a.seed_file.as_deref())?,
        a.generation,
        a.height,
        &a.chains,
    )?)
}

pub fn keygen(a: &TreeArgs) -> Result<Value, Fail> {
    let tree = build(a)?;
    Ok(json!({
        "treeSeed": hex0x(&tree.tree_seed()),
        "root": hex0x(&tree.root()),
        "height": a.height,
        "generation": a.generation,
        "chains": a.chains,
        "leafCountPerChain": 1u64 << a.height,
    }))
}

pub fn pubkey(a: &PubkeyArgs) -> Result<Value, Fail> {
    let slot = tree::slot_of(&a.tree.chains, a.chain_id)?;
    keys::check(a.tree.height, a.leaf)?;
    let index = keys::index(slot, a.leaf, a.tree.height);
    let key = keys::leaf(
        &seed(a.tree.seed_file.as_deref())?,
        a.tree.generation,
        index,
        a.chain_id,
    );
    Ok(json!({
        "chainId": a.chain_id,
        "slot": slot,
        "leaf": a.leaf,
        "index": index,
        "publicSeed": hex0x(&key.public_seed),
        "publicKeyHash": hex0x(&key.public_key_hash),
        "leafNode": hex0x(&key.node),
    }))
}

pub fn sign(a: &SignArgs) -> Result<Value, Fail> {
    let msg = msg(&a.msg)?;
    let entry = match &a.ticket_file {
        Some(path) => {
            let ticket = read_ticket(path)?;
            if a.chain_id.is_some_and(|id| id != ticket.chain_id) {
                return Err(Error::BadChain.into());
            }
            ticket.sign(a.leaf, &msg)?
        }
        None => {
            let master = seed(a.seed_file.as_deref())?;
            let tree = Tree::build(
                &master,
                a.generation,
                a.height.unwrap_or_default(),
                &a.chains,
            )?;
            scheme::sign(&tree, a.chain_id.unwrap_or_default(), a.leaf, &msg)?
        }
    };
    Ok(json!({
        "slot": entry.slot,
        "leaf": a.leaf,
        "signature": hex0x(entry.signature.as_flattened()),
        "authPath": words_json(&entry.auth_path),
        "entry": hex0x(&entry.encode()),
    }))
}

pub fn verify(a: &VerifyArgs) -> Result<Value, Fail> {
    let hash = |s: &str, flag: &str| {
        parse_hash(s).ok_or_else(|| fail("bad_args", format!("--{flag} must be 32 bytes of hex")))
    };
    let entry = parse_hex(&a.entry).ok_or(Error::BadEntryLength)?;
    let (tree_seed, root) = (hash(&a.tree_seed, "tree-seed")?, hash(&a.root, "root")?);
    scheme::verify(
        &tree_seed,
        &root,
        a.height,
        a.chain_id,
        a.leaf,
        &msg(&a.msg)?,
        &entry,
    )?;
    Ok(json!({ "ok": true }))
}

pub fn export_leaves(a: &ExportArgs) -> Result<Value, Fail> {
    if a.from < a.hot_start {
        let detail = format!(
            "leaf {} is below --hot-start {}: cold leaves have no caps",
            a.from, a.hot_start
        );
        return Err(fail("leaf_out_of_range", detail));
    }
    let ticket = ticket::export(&build(&a.tree)?, a.chain_id, a.from, a.to)?;
    write_json(&a.out, &ticket.to_json(), true)?;
    Ok(json!({
        "out": a.out,
        "chainId": a.chain_id,
        "slot": ticket.slot,
        "from": a.from,
        "to": a.to,
        "count": ticket.leaves.len(),
    }))
}

pub fn vectors(a: &VectorArgs) -> Result<Value, Fail> {
    let file = signer::vectors::generate(a.height, &a.chains)?;
    write_json(&a.out, &file, false)?;
    Ok(json!({
        "out": a.out,
        "cases": file["cases"].as_array().map_or(0, Vec::len),
        "root": file["root"],
    }))
}
