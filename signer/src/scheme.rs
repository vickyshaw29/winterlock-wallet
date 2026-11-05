use crate::entry::Entry;
use crate::error::Error;
use crate::hash::Hash;
use crate::tree::Tree;
use crate::{keys, merkle, wots};

pub fn sign(tree: &Tree, chain_id: u64, leaf: u32, msg: &Hash) -> Result<Entry, Error> {
    let slot = tree.slot_of(chain_id)?;
    keys::check(tree.height(), leaf)?;
    let public_seed = keys::public_seed(&tree.tree_seed(), keys::index(slot, leaf, tree.height()));
    Ok(Entry {
        slot,
        signature: wots::sign(&tree.secrets(slot, leaf), &public_seed, msg),
        auth_path: tree.auth_path(slot, leaf),
    })
}

pub fn verify(
    tree_seed: &Hash,
    root: &Hash,
    height: u8,
    chain_id: u64,
    leaf: u32,
    msg: &Hash,
    entry: &[u8],
) -> Result<(), Error> {
    keys::check(height, leaf)?;
    let entry = Entry::decode(entry, height)?;
    let index = keys::index(entry.slot, leaf, height);
    let public_seed = keys::public_seed(tree_seed, index);
    let pk = wots::recover_public_key_hash(&entry.signature, &public_seed, msg);
    let node = keys::leaf_node(&public_seed, chain_id, &pk);
    if merkle::root_from_path(&node, index, &entry.auth_path) == *root {
        Ok(())
    } else {
        Err(Error::RootMismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry;
    use crate::hash::keccak;

    fn tree() -> Tree {
        Tree::build(&[9; 32], 1, 3, &[1337, 11155111]).unwrap()
    }

    fn check(tree: &Tree, chain_id: u64, leaf: u32, msg: &Hash, entry: &[u8]) -> Result<(), Error> {
        verify(
            &tree.tree_seed(),
            &tree.root(),
            3,
            chain_id,
            leaf,
            msg,
            entry,
        )
    }

    #[test]
    fn round_trip() {
        let (tree, msg) = (tree(), keccak(&[b"tx"]));
        for chain_id in [1337, 11155111] {
            for leaf in [0, 3, 7] {
                let entry = sign(&tree, chain_id, leaf, &msg).unwrap();
                let bytes = entry.encode();
                assert_eq!(bytes.len(), entry::len(3));
                assert_eq!(Entry::decode(&bytes, 3), Ok(entry));
                assert_eq!(check(&tree, chain_id, leaf, &msg, &bytes), Ok(()));
            }
        }
        assert_eq!(entry::len(10), 2594);
    }

    #[test]
    fn refusals() {
        use Error::*;
        let (tree, msg) = (tree(), keccak(&[b"tx"]));
        let good = sign(&tree, 11155111, 5, &msg).unwrap().encode();
        let edit = |at: usize, value: u8| {
            let mut bytes = good.clone();
            bytes[at] = value;
            bytes
        };
        let last = good.len() - 1;
        let cases = [
            (11155111, 5, msg, edit(102, good[102] ^ 1), RootMismatch),
            (11155111, 5, msg, edit(last, good[last] ^ 1), RootMismatch),
            (11155111, 4, msg, good.clone(), RootMismatch),
            (1, 5, msg, good.clone(), RootMismatch),
            (11155111, 5, keccak(&[b"other"]), good.clone(), RootMismatch),
            (11155111, 5, msg, edit(1, 0), RootMismatch),
            (11155111, 5, msg, edit(0, 2), BadVersion),
            (11155111, 5, msg, edit(1, 16), BadSlot),
            (11155111, 5, msg, good[1..].to_vec(), BadEntryLength),
            (11155111, 8, msg, good.clone(), LeafOutOfRange),
        ];
        for (i, (chain_id, leaf, msg, bytes, want)) in cases.into_iter().enumerate() {
            assert_eq!(
                check(&tree, chain_id, leaf, &msg, &bytes),
                Err(want),
                "case {i}"
            );
        }
        assert_eq!(sign(&tree, 1, 0, &msg), Err(BadChain));
        assert_eq!(sign(&tree, 1337, 8, &msg), Err(LeafOutOfRange));
    }
}
