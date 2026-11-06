use serde_json::{Value, json};
use signer::api::{self, Fail, Keys};

use crate::args::{ExportArgs, PubkeyArgs, SignArgs, TreeArgs, VectorArgs, VerifyArgs};
use crate::io::{read_ticket, seed, write_json};

fn keys(a: &TreeArgs) -> Result<Keys, Fail> {
    Ok(Keys {
        master: seed(a.seed_file.as_deref())?,
        generation: a.generation,
        height: a.height,
        chains: a.chains.clone(),
    })
}

pub fn keygen(a: &TreeArgs) -> Result<Value, Fail> {
    api::keygen(&keys(a)?)
}

pub fn pubkey(a: &PubkeyArgs) -> Result<Value, Fail> {
    api::pubkey(&keys(&a.tree)?, a.chain_id, a.leaf)
}

pub fn sign(a: &SignArgs) -> Result<Value, Fail> {
    match &a.ticket_file {
        Some(path) => api::sign_ticket(&read_ticket(path)?, a.chain_id, a.leaf, &a.msg),
        None => {
            let k = Keys {
                master: seed(a.seed_file.as_deref())?,
                generation: a.generation,
                height: a.height.unwrap_or_default(),
                chains: a.chains.clone(),
            };
            api::sign(&k, a.chain_id.unwrap_or_default(), a.leaf, &a.msg)
        }
    }
}

pub fn verify(a: &VerifyArgs) -> Result<Value, Fail> {
    api::verify(
        &a.tree_seed,
        &a.root,
        a.height,
        a.chain_id,
        a.leaf,
        &a.msg,
        &a.entry,
    )
}

pub fn export_leaves(a: &ExportArgs) -> Result<Value, Fail> {
    let ticket = api::export(&keys(&a.tree)?, a.chain_id, a.from, a.to, a.hot_start)?;
    write_json(&a.out, &ticket, true)?;
    Ok(json!({
        "out": a.out,
        "chainId": a.chain_id,
        "slot": ticket["slot"],
        "from": a.from,
        "to": a.to,
        "count": ticket["leaves"].as_array().map_or(0, Vec::len),
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
