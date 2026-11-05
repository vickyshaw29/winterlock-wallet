mod common;

use common::{bytes, hash, keccak256, read_json};
use hashsigs_rs::{PublicKey, WOTSPlus};
use signer::scheme;
use signer::wots::Chains;

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/h10.json");

#[test]
fn every_case_gets_its_expected_outcome() {
    let (file, quip) = (read_json(FILE), WOTSPlus::new(keccak256));
    let (tree_seed, root) = (hash(&file["treeSeed"]), hash(&file["root"]));
    let cases = file["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 22);

    for case in cases {
        let (name, msg) = (case["name"].as_str().unwrap(), hash(&case["message"]));
        let got = scheme::verify(
            &tree_seed,
            &root,
            10,
            case["chainId"].as_u64().unwrap(),
            case["leaf"].as_u64().unwrap() as u32,
            &msg,
            &bytes(&case["entry"]),
        );
        if case["expected"] == true {
            assert_eq!(got, Ok(()), "{name}");
            let pk = PublicKey {
                public_seed: hash(&case["publicSeed"]),
                public_key_hash: hash(&case["publicKeyHash"]),
            };
            let sig: Chains = bytes(&case["signature"]).as_chunks().0.try_into().unwrap();
            assert!(quip.verify(&pk, &msg, &sig), "{name} under Quip");
        } else {
            assert_eq!(
                got.map_err(|e| e.as_str()),
                Err(case["reason"].as_str().unwrap()),
                "{name}"
            );
        }
    }
}

#[test]
fn committed_file_matches_the_code() {
    assert_eq!(
        Ok(read_json(FILE)),
        signer::vectors::generate(10, &[1337, 11155111]),
        "stale: run `signer vectors --height 10 --chains 1337,11155111 --out vectors/h10.json`"
    );
}
