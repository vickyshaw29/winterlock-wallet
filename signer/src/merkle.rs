use crate::hash::{Hash, keccak};

pub fn parent(left: &Hash, right: &Hash) -> Hash {
    keccak(&[left, right])
}

pub fn levels(leaves: Vec<Hash>) -> Vec<Vec<Hash>> {
    let mut levels = vec![leaves];
    while let Some(top) = levels.last().filter(|top| top.len() > 1) {
        let next = top
            .chunks(2)
            .map(|pair| parent(&pair[0], &pair[1]))
            .collect();
        levels.push(next);
    }
    levels
}

pub fn path(levels: &[Vec<Hash>], index: usize) -> Vec<Hash> {
    let below_root = &levels[..levels.len() - 1];
    below_root
        .iter()
        .enumerate()
        .map(|(k, level)| level[(index >> k) ^ 1])
        .collect()
}

pub fn root_from_path(leaf: &Hash, index: u32, path: &[Hash]) -> Hash {
    path.iter().enumerate().fold(*leaf, |node, (k, sibling)| {
        if index >> k & 1 == 0 {
            parent(&node, sibling)
        } else {
            parent(sibling, &node)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::parse_hash;

    #[test]
    fn every_path_reaches_the_root() {
        let levels = levels((0..8u8).map(|i| keccak(&[&[i]])).collect());
        let root = levels[3][0];
        for i in 0..8 {
            assert_eq!(
                root_from_path(&levels[0][i], i as u32, &path(&levels, i)),
                root
            );
        }
    }

    // Expected roots from the same walk written with viem.
    #[test]
    fn matches_viem() {
        let word = |b: u8| [b; 32];
        let three = [word(0x22), word(0x33), word(0x44)];
        let fourteen: Vec<_> = (1..=14).map(word).collect();
        let want = |s| parse_hash(s).unwrap();
        assert_eq!(
            root_from_path(&word(0x11), 5, &three),
            want("0x4b223fcf644ca775a0492480beb7038df266e7141693be45888d922a9b1e7b77")
        );
        assert_eq!(
            root_from_path(&word(0xaa), 1029, &fourteen),
            want("0x0184b35c3fb66deaf6ce1645a3433cb0afd36e4935d217a797e5b3ae6c87b2bc")
        );
    }
}
