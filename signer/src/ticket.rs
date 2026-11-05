//! Hot tickets: one-time keys cut from the tree for a device that never holds the
//! seed. A ticket carries each leaf's 67 secrets and its path, so signing needs no
//! tree. The account's hot policy, not the ticket, caps what the leaves can spend.

use serde_json::{Value, json};

use crate::derive;
use crate::entry::Entry;
use crate::hash::{Hash, hex0x, parse_hash};
use crate::scheme::SignError;
use crate::tree::{self, MAX_HEIGHT, SLOT_BITS, SLOTS, Tree};
use crate::wots::{self, Chains};

pub const VERSION: u64 = 1;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketError {
    LeafNotInTicket,
    /// The leaf's secrets and path do not hash up to the ticket's root.
    Corrupt,
}

/// Cuts leaves `from..=to` of one chain, from a tree built from the same seed and generation.
pub fn export(
    tree: &Tree,
    master: &Hash,
    generation: u32,
    chain_id: u64,
    from: u32,
    to: u32,
) -> Result<Ticket, SignError> {
    let slot = tree.slot_of(chain_id).ok_or(SignError::BadChain)?;
    let height = tree.height();
    if from > to || to >= 1 << height {
        return Err(SignError::LeafOutOfRange);
    }

    let leaves = (from..=to)
        .map(|leaf| TicketLeaf {
            leaf,
            secrets: derive::secrets(master, generation, derive::leaf_index(slot, leaf, height)),
            auth_path: tree.auth_path(slot, leaf),
        })
        .collect();
    let ticket = Ticket {
        tree_seed: derive::tree_seed(master, generation),
        root: tree.root(),
        height,
        generation,
        chain_id,
        slot,
        leaves,
    };
    assert!(
        ticket
            .leaves
            .iter()
            .all(|l| ticket.public_seed_if_valid(l).is_some()),
        "tree was built from a different master seed or generation"
    );
    Ok(ticket)
}

impl Ticket {
    /// Signs with one ticket leaf after checking it still hashes up to the root.
    pub fn sign(&self, leaf: u32, msg: &Hash) -> Result<Entry, TicketError> {
        let l = self
            .leaves
            .iter()
            .find(|l| l.leaf == leaf)
            .ok_or(TicketError::LeafNotInTicket)?;
        let public_seed = self.public_seed_if_valid(l).ok_or(TicketError::Corrupt)?;
        Ok(Entry {
            slot: self.slot,
            signature: wots::sign(&l.secrets, &public_seed, msg),
            auth_path: l.auth_path.clone(),
        })
    }

    /// The leaf's public seed, if its key and path lead to the root.
    fn public_seed_if_valid(&self, l: &TicketLeaf) -> Option<Hash> {
        let index = derive::leaf_index(self.slot, l.leaf, self.height);
        let public_seed = derive::public_seed(&self.tree_seed, index);
        let pk = wots::public_key_hash(&l.secrets, &public_seed);
        let node = derive::leaf_node(&public_seed, self.chain_id, &pk);
        (tree::root_from_path(&node, index, &l.auth_path) == self.root).then_some(public_seed)
    }

    pub fn to_json(&self) -> Value {
        let words = |ws: &[Hash]| ws.iter().map(|w| hex0x(w)).collect::<Vec<_>>();
        json!({
            "version": VERSION,
            "treeSeed": hex0x(&self.tree_seed),
            "root": hex0x(&self.root),
            "height": self.height,
            "generation": self.generation,
            "chainId": self.chain_id,
            "slot": self.slot,
            "leaves": self.leaves.iter().map(|l| json!({
                "leaf": l.leaf,
                "secrets": words(&l.secrets),
                "authPath": words(&l.auth_path),
            })).collect::<Vec<_>>(),
        })
    }

    /// None unless the JSON is a version-1 ticket of the right shape.
    pub fn from_json(v: &Value) -> Option<Ticket> {
        if v["version"].as_u64()? != VERSION {
            return None;
        }
        let height = u8::try_from(v["height"].as_u64()?)
            .ok()
            .filter(|&h| h <= MAX_HEIGHT)?;
        let slot = u8::try_from(v["slot"].as_u64()?)
            .ok()
            .filter(|&s| (s as usize) < SLOTS)?;
        let leaves = v["leaves"]
            .as_array()?
            .iter()
            .map(|l| {
                let leaf = u32::try_from(l["leaf"].as_u64()?)
                    .ok()
                    .filter(|&x| x < 1 << height)?;
                let auth_path = words(&l["authPath"])?;
                if auth_path.len() != (height + SLOT_BITS) as usize {
                    return None;
                }
                Some(TicketLeaf {
                    leaf,
                    secrets: words(&l["secrets"])?.try_into().ok()?,
                    auth_path,
                })
            })
            .collect::<Option<Vec<_>>>()?;

        Some(Ticket {
            tree_seed: parse_hash(v["treeSeed"].as_str()?)?,
            root: parse_hash(v["root"].as_str()?)?,
            height,
            generation: u32::try_from(v["generation"].as_u64()?).ok()?,
            chain_id: v["chainId"].as_u64()?,
            slot,
            leaves,
        })
    }
}

fn words(v: &Value) -> Option<Vec<Hash>> {
    v.as_array()?
        .iter()
        .map(|w| parse_hash(w.as_str()?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::keccak;
    use crate::scheme;

    const MASTER: Hash = [3; 32];
    const G: u32 = 2;
    const CHAINS: [u64; 2] = [1337, 11155111];

    fn setup() -> (Tree, Ticket) {
        let tree = Tree::build(&MASTER, G, 3, &CHAINS);
        let ticket = export(&tree, &MASTER, G, 11155111, 4, 7).unwrap();
        (tree, ticket)
    }

    #[test]
    fn ticket_entries_equal_seed_entries() {
        let (tree, ticket) = setup();
        let msg = keccak(&[b"pay the coffee shop"]);
        for leaf in 4..=7 {
            let from_ticket = ticket.sign(leaf, &msg).unwrap();
            let from_seed = scheme::sign_with(&tree, &MASTER, G, 11155111, leaf, &msg).unwrap();
            assert_eq!(from_ticket, from_seed, "leaf {leaf}");

            let tree_seed = derive::tree_seed(&MASTER, G);
            let bytes = from_ticket.encode();
            let verified =
                scheme::verify(&tree_seed, &tree.root(), 3, 11155111, leaf, &msg, &bytes);
            assert_eq!(verified, Ok(()));
        }
    }

    #[test]
    fn only_exported_leaves_sign() {
        let (_, ticket) = setup();
        let msg = keccak(&[b"msg"]);
        assert_eq!(ticket.sign(3, &msg), Err(TicketError::LeafNotInTicket));
        assert_eq!(ticket.sign(8, &msg), Err(TicketError::LeafNotInTicket));
    }

    #[test]
    fn a_changed_secret_is_caught() {
        let (_, mut ticket) = setup();
        ticket.leaves[0].secrets[10][0] ^= 1;
        assert_eq!(
            ticket.sign(4, &keccak(&[b"msg"])),
            Err(TicketError::Corrupt)
        );
    }

    #[test]
    fn json_round_trips_and_rejects_bad_shapes() {
        let (_, ticket) = setup();
        let json = ticket.to_json();
        assert_eq!(Ticket::from_json(&json), Some(ticket));

        let mut wrong_version = json.clone();
        wrong_version["version"] = 2.into();
        assert_eq!(Ticket::from_json(&wrong_version), None);

        let mut short_path = json.clone();
        short_path["leaves"][0]["authPath"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert_eq!(Ticket::from_json(&short_path), None);
    }

    #[test]
    fn export_refuses_bad_ranges() {
        let tree = Tree::build(&MASTER, G, 3, &CHAINS);
        assert_eq!(export(&tree, &MASTER, G, 1, 4, 7), Err(SignError::BadChain));
        assert_eq!(
            export(&tree, &MASTER, G, 1337, 5, 4),
            Err(SignError::LeafOutOfRange)
        );
        assert_eq!(
            export(&tree, &MASTER, G, 1337, 4, 8),
            Err(SignError::LeafOutOfRange)
        );
    }
}
