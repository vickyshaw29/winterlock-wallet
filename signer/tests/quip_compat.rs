//! Cross-checks our WOTS+ against Quip's: the Solidity golden vectors and the
//! hashsigs-rs crate. Both are AGPL and are only read or linked here, in tests.

use hashsigs_rs::{PublicKey, WOTSPlus};
use serde_json::Value;
use signer::hash::{Hash, keccak};
use signer::wots::{self, Chains};
use signer::{derive, scheme};

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../contracts/lib/hashsigs-solidity/test/test_vectors/wotsplus_keccak256.json"
);

fn keccak256(data: &[u8]) -> [u8; 32] {
    keccak(&[data])
}

fn hash_hex(v: &Value) -> Hash {
    let s = v.as_str().expect("hex string");
    hex::decode(s.trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap()
}

fn prf(seed: &Hash, index: u16) -> Hash {
    keccak(&[&[0x03], seed, &index.to_be_bytes()])
}

#[test]
fn matches_solidity_golden_vectors() {
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();

    for n in 0..5 {
        let v = &golden[format!("vector{n}")];
        let private_key = hash_hex(&v["privateKey"]);
        let public_seed = hash_hex(&v["publicSeed"]);
        let public_key = hash_hex(&v["publicKey"]);
        let msg = hash_hex(&v["message"]);

        let r = wots::masks(&public_seed);
        for (k, want) in v["randomizationElements"].as_array().unwrap()[..wots::W]
            .iter()
            .enumerate()
        {
            assert_eq!(r[k], hash_hex(want), "vector {n} mask {k}");
        }

        // Quip's test signer derives its secrets this way; ours come from the tree (B2).
        assert_eq!(prf(&private_key, 0), public_seed, "vector {n} public seed");
        let sk: Chains =
            std::array::from_fn(|j| keccak(&[&r[0], &prf(&private_key, j as u16 + 1)]));

        assert_eq!(
            wots::public_key_hash(&sk, &public_seed),
            public_key,
            "vector {n} public key"
        );
        let sig = wots::sign(&sk, &public_seed, &msg);
        let want: Vec<Hash> = v["signature"]
            .as_array()
            .unwrap()
            .iter()
            .map(hash_hex)
            .collect();
        assert_eq!(sig.as_slice(), want.as_slice(), "vector {n} signature");
        assert!(
            wots::verify(&public_seed, &public_key, &msg, &sig),
            "vector {n} verify"
        );
    }
}

#[test]
fn quip_rust_accepts_our_signatures() {
    let quip = WOTSPlus::new(keccak256);
    for k in 0..200u32 {
        let sk: Chains = std::array::from_fn(|j| keccak(&[b"sk", &k.to_be_bytes(), &[j as u8]]));
        let public_seed = keccak(&[b"seed", &k.to_be_bytes()]);
        let msg = keccak(&[&k.to_be_bytes()]);

        let public_key_hash = wots::public_key_hash(&sk, &public_seed);
        let sig = wots::sign(&sk, &public_seed, &msg);
        let pk = PublicKey {
            public_seed,
            public_key_hash,
        };
        assert!(quip.verify(&pk, &msg, &sig), "message {k}");
    }
}

#[test]
fn we_accept_quip_rust_signatures() {
    let quip = WOTSPlus::new(keccak256);
    for k in 0..200u32 {
        let private_key = keccak(&[b"quip", &k.to_be_bytes()]);
        let msg = keccak(&[&k.to_be_bytes()]);

        let pk = quip.get_public_key(&private_key);
        let sig: Chains = quip.sign(&private_key, &msg).unwrap().try_into().unwrap();
        assert!(
            wots::verify(&pk.public_seed, &pk.public_key_hash, &msg, &sig),
            "message {k}"
        );
    }
}

#[test]
fn signature_inside_an_entry_passes_quip() {
    let master = [5u8; 32];
    let (generation, height, chain_id, leaf) = (0, 3, 1337, 6);
    let msg = keccak(&[b"frame tx sig hash"]);

    let entry = scheme::sign(
        &master,
        generation,
        height,
        &[chain_id],
        chain_id,
        leaf,
        &msg,
    )
    .unwrap();
    let index = derive::leaf_index(entry.slot, leaf, height);
    let key = derive::leaf(&master, generation, index, chain_id);
    let pk = PublicKey {
        public_seed: key.public_seed,
        public_key_hash: key.public_key_hash,
    };
    assert!(WOTSPlus::new(keccak256).verify(&pk, &msg, &entry.signature));
}
