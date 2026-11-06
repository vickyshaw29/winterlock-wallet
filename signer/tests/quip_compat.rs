mod common;

use common::{hash, keccak256, read_json};
use hashsigs_rs::{PublicKey, WOTSPlus};
use signer::hash::{Hash, keccak};
use signer::wots::{self, Chains};

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../contracts/lib/hashsigs-solidity/test/test_vectors/wotsplus_keccak256.json"
);

fn prf(seed: &Hash, index: u16) -> Hash {
    keccak(&[&[0x03], seed, &index.to_be_bytes()])
}

#[test]
fn matches_solidity_golden_vectors() {
    let golden = read_json(GOLDEN);
    for n in 0..5 {
        let v = &golden[format!("vector{n}")];
        let (private_key, public_seed) = (hash(&v["privateKey"]), hash(&v["publicSeed"]));
        let msg = hash(&v["message"]);
        let words = |key: &str| {
            v[key]
                .as_array()
                .unwrap()
                .iter()
                .map(hash)
                .collect::<Vec<_>>()
        };

        let r = wots::masks(&public_seed);
        assert_eq!(r.as_slice(), &words("randomizationElements")[..r.len()]);
        assert_eq!(prf(&private_key, 0), public_seed);
        let sk: Chains =
            std::array::from_fn(|j| keccak(&[&r[0], &prf(&private_key, j as u16 + 1)]));
        assert_eq!(
            wots::public_key_hash(&sk, &public_seed),
            hash(&v["publicKey"])
        );
        assert_eq!(
            wots::sign(&sk, &public_seed, &msg).to_vec(),
            words("signature")
        );
    }
}

#[test]
fn quip_and_ours_accept_each_other() {
    let quip = WOTSPlus::new(keccak256);
    for k in 0..200u32 {
        let sk: Chains = std::array::from_fn(|j| keccak(&[b"sk", &k.to_be_bytes(), &[j as u8]]));
        let seed = keccak(&[b"seed", &k.to_be_bytes()]);
        let msg = keccak(&[&k.to_be_bytes()]);
        let pk = PublicKey {
            public_seed: seed,
            public_key_hash: wots::public_key_hash(&sk, &seed),
        };
        assert!(quip.verify(&pk, &msg, &wots::sign(&sk, &seed, &msg)));

        let private_key = keccak(&[b"quip", &k.to_be_bytes()]);
        let pk = quip.get_public_key(&private_key);
        let sig: Chains = quip.sign(&private_key, &msg).unwrap().try_into().unwrap();
        assert!(wots::verify(
            &pk.public_seed,
            &pk.public_key_hash,
            &msg,
            &sig
        ));
    }
}
