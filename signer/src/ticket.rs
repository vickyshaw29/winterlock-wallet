use serde_json::{Value, json};

use crate::codec::{hex0x, json_hash, json_words, words_json};
use crate::consts::{MAX_HEIGHT, SLOT_BITS, SLOTS, TICKET_VERSION};
use crate::entry::Entry;
use crate::error::Error;
use crate::hash::Hash;
use crate::tree::Tree;
use crate::wots::{self, Chains};
use crate::{keys, merkle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketLeaf {
    pub leaf: u32,
    pub secrets: Chains,
    pub auth_path: Vec<Hash>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub tree_seed: Hash,
    pub root: Hash,
    pub height: u8,
    pub generation: u32,
    pub chain_id: u64,
    pub slot: u8,
    pub leaves: Vec<TicketLeaf>,
}

pub fn export(tree: &Tree, chain_id: u64, from: u32, to: u32) -> Result<Ticket, Error> {
    let slot = tree.slot_of(chain_id)?;
    keys::check(tree.height(), to)?;
    if from > to {
        return Err(Error::LeafOutOfRange);
    }
    let leaves = (from..=to).map(|leaf| TicketLeaf {
        leaf,
        secrets: tree.secrets(slot, leaf),
        auth_path: tree.auth_path(slot, leaf),
    });
    Ok(Ticket {
        tree_seed: tree.tree_seed(),
        root: tree.root(),
        height: tree.height(),
        generation: tree.generation(),
        chain_id,
        slot,
        leaves: leaves.collect(),
    })
}

impl Ticket {
    pub fn sign(&self, leaf: u32, msg: &Hash) -> Result<Entry, Error> {
        let l = self
            .leaves
            .iter()
            .find(|l| l.leaf == leaf)
            .ok_or(Error::LeafNotInTicket)?;
        let index = keys::index(self.slot, leaf, self.height);
        let public_seed = keys::public_seed(&self.tree_seed, index);
        let pk = wots::public_key_hash(&l.secrets, &public_seed);
        let node = keys::leaf_node(&public_seed, self.chain_id, &pk);
        if merkle::root_from_path(&node, index, &l.auth_path) != self.root {
            return Err(Error::BadTicket);
        }
        Ok(Entry {
            slot: self.slot,
            signature: wots::sign(&l.secrets, &public_seed, msg),
            auth_path: l.auth_path.clone(),
        })
    }

    pub fn to_json(&self) -> Value {
        let leaves: Vec<_> = self
            .leaves
            .iter()
            .map(|l| {
                json!({
                    "leaf": l.leaf,
                    "secrets": words_json(&l.secrets),
                    "authPath": words_json(&l.auth_path),
                })
            })
            .collect();
        json!({
            "version": TICKET_VERSION,
            "treeSeed": hex0x(&self.tree_seed),
            "root": hex0x(&self.root),
            "height": self.height,
            "generation": self.generation,
            "chainId": self.chain_id,
            "slot": self.slot,
            "leaves": leaves,
        })
    }

    pub fn from_json(v: &Value) -> Option<Ticket> {
        if v["version"] != TICKET_VERSION {
            return None;
        }
        let height = u8::try_from(v["height"].as_u64()?)
            .ok()
            .filter(|&h| h <= MAX_HEIGHT)?;
        let slot = u8::try_from(v["slot"].as_u64()?)
            .ok()
            .filter(|&s| usize::from(s) < SLOTS)?;
        let leaf = |l: &Value| -> Option<TicketLeaf> {
            let path_len = usize::from(height + SLOT_BITS);
            Some(TicketLeaf {
                leaf: u32::try_from(l["leaf"].as_u64()?)
                    .ok()
                    .filter(|&x| x < 1 << height)?,
                secrets: json_words(&l["secrets"])?.try_into().ok()?,
                auth_path: json_words(&l["authPath"]).filter(|p| p.len() == path_len)?,
            })
        };
        Some(Ticket {
            tree_seed: json_hash(&v["treeSeed"])?,
            root: json_hash(&v["root"])?,
            height,
            generation: u32::try_from(v["generation"].as_u64()?).ok()?,
            chain_id: v["chainId"].as_u64()?,
            slot,
            leaves: v["leaves"]
                .as_array()?
                .iter()
                .map(leaf)
                .collect::<Option<_>>()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::keccak;
    use crate::scheme;

    fn setup() -> (Tree, Ticket) {
        let tree = Tree::build(&[3; 32], 2, 3, &[1337, 11155111]).unwrap();
        let ticket = export(&tree, 11155111, 4, 7).unwrap();
        (tree, ticket)
    }

    #[test]
    fn signs_like_the_seed() {
        let (tree, ticket) = setup();
        let msg = keccak(&[b"coffee"]);
        for leaf in 4..=7 {
            assert_eq!(
                ticket.sign(leaf, &msg),
                scheme::sign(&tree, 11155111, leaf, &msg)
            );
        }
        assert_eq!(ticket.sign(3, &msg), Err(Error::LeafNotInTicket));
        assert_eq!(ticket.sign(8, &msg), Err(Error::LeafNotInTicket));
    }

    #[test]
    fn refusals() {
        let (tree, mut ticket) = setup();
        assert_eq!(export(&tree, 1, 4, 7), Err(Error::BadChain));
        assert_eq!(export(&tree, 1337, 5, 4), Err(Error::LeafOutOfRange));
        assert_eq!(export(&tree, 1337, 4, 8), Err(Error::LeafOutOfRange));
        ticket.leaves[0].secrets[10][0] ^= 1;
        assert_eq!(ticket.sign(4, &keccak(&[b"x"])), Err(Error::BadTicket));
    }

    #[test]
    fn json_round_trip() {
        let (_, ticket) = setup();
        let json = ticket.to_json();
        assert_eq!(Ticket::from_json(&json).as_ref(), Some(&ticket));
        let mut bad = json.clone();
        bad["version"] = 2.into();
        assert_eq!(Ticket::from_json(&bad), None);
        let mut bad = json;
        bad["leaves"][0]["authPath"].as_array_mut().unwrap().pop();
        assert_eq!(Ticket::from_json(&bad), None);
    }
}
