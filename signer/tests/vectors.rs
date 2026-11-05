//! Checks the committed vectors/h10.json: every case gets its expected outcome,
//! the valid ones pass Quip's verifier, and the file still matches the code.

use hashsigs_rs::{PublicKey, WOTSPlus};
use serde_json::Value;
use signer::hash::{Hash, keccak};
use signer::scheme;
use signer::vectors;
use signer::wots::Chains;

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/h10.json");
const CHAINS: [u64; 2] = [1337, 11155111];

fn load() -> Value {
    serde_json::from_str(&std::fs::read_to_string(FILE).unwrap()).unwrap()
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}

fn hash(v: &Value) -> Hash {
    bytes(v).try_into().unwrap()
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    keccak(&[data])
}

#[test]
fn every_case_gets_its_expected_outcome() {
    let file = load();
    let (tree_seed, root) = (hash(&file["treeSeed"]), hash(&file["root"]));
    let height = file["params"]["height"].as_u64().unwrap() as u8;
    let cases = file["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 22);

    for case in cases {
        let name = case["name"].as_str().unwrap();
        let got = scheme::verify(
            &tree_seed,
            &root,
            height,
            case["chainId"].as_u64().unwrap(),
            case["leaf"].as_u64().unwrap() as u32,
            &hash(&case["message"]),
            &bytes(&case["entry"]),
        );
        if case["expected"].as_bool().unwrap() {
            assert_eq!(got, Ok(()), "{name}");
        } else {
            let reason = got.expect_err(name).reason();
            assert_eq!(reason, case["reason"].as_str().unwrap(), "{name}");
        }
    }
}

#[test]
fn valid_cases_pass_quip() {
    let quip = WOTSPlus::new(keccak256);
    let file = load();
    let valid = file["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["expected"] == true);

    let mut count = 0;
    for case in valid {
        let signature: Chains = bytes(&case["signature"])
            .as_chunks::<32>()
            .0
            .try_into()
            .unwrap();
        let pk = PublicKey {
            public_seed: hash(&case["publicSeed"]),
            public_key_hash: hash(&case["publicKeyHash"]),
        };
        let msg = hash(&case["message"]);
        assert!(quip.verify(&pk, &msg, &signature), "{}", case["name"]);
        count += 1;
    }
    assert_eq!(count, 4, "leaf 0, middle, last and slot 1");
}

#[test]
fn committed_file_matches_the_code() {
    assert_eq!(
        load(),
        vectors::generate(10, &CHAINS),
        "stale vectors: run `signer vectors --height 10 --chains 1337,11155111 --out vectors/h10.json`"
    );
}
