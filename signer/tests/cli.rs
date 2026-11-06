use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use serde_json::{Value, json};

const SEED: &str = "0x0707070707070707070707070707070707070707070707070707070707070707";
const OTHER_SEED: &str = "0x0909090909090909090909090909090909090909090909090909090909090909";
const MSG: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const TREE: &str = "--height 3 --generation 2 --chains 1337,11155111";

type Output = Result<Value, (String, String)>;

fn signer(args: &str, seed: Option<&str>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_signer"));
    cmd.args(args.split_whitespace()).env_remove("PQ_SEED");
    if let Some(seed) = seed {
        cmd.env("PQ_SEED", seed);
    }
    let out = cmd.output().unwrap();
    let (stdout, stderr) = (
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    );
    if out.status.success() {
        assert!(
            stderr.is_empty() && stdout.lines().count() == 1,
            "{args}: {stdout}{stderr}"
        );
        Ok(serde_json::from_str(&stdout).unwrap())
    } else {
        assert!(out.status.code() == Some(1) && stdout.is_empty(), "{args}");
        let e: Value = serde_json::from_str(&stderr).unwrap();
        Err((
            e["error"].as_str().unwrap().into(),
            e["detail"].as_str().unwrap().into(),
        ))
    }
}

fn code(out: Output) -> String {
    out.unwrap_err().0
}

fn temp(name: &str) -> String {
    let path = std::env::temp_dir().join(format!("signer-{name}-{}", std::process::id()));
    path.to_str().unwrap().into()
}

fn verify(tree: &Value, chain_id: u64, leaf: u32, entry: &str) -> Output {
    let (tree_seed, root) = (
        tree["treeSeed"].as_str().unwrap(),
        tree["root"].as_str().unwrap(),
    );
    signer(
        &format!(
            "verify --tree-seed {tree_seed} --root {root} --height 3 --chain-id {chain_id} --leaf {leaf} --msg {MSG} --entry {entry}"
        ),
        None,
    )
}

#[test]
fn keygen_pubkey_sign_verify() {
    let tree = signer(&format!("keygen {TREE}"), Some(SEED)).unwrap();
    assert_eq!(tree["leafCountPerChain"], 8);
    let key = signer(
        &format!("pubkey {TREE} --chain-id 11155111 --leaf 5"),
        Some(SEED),
    )
    .unwrap();
    assert_eq!((&key["slot"], &key["index"]), (&json!(1), &json!(13)));

    let signed = signer(
        &format!("sign {TREE} --chain-id 11155111 --leaf 5 --msg {MSG}"),
        Some(SEED),
    )
    .unwrap();
    let entry = signed["entry"].as_str().unwrap();
    assert_eq!(signed["authPath"].as_array().unwrap().len(), 3 + 4);
    assert_eq!(entry.len(), 2 + 2 * (2274 + 32 * 3));
    assert_eq!(verify(&tree, 11155111, 5, entry), Ok(json!({ "ok": true })));
}

#[test]
fn error_codes() {
    let tree = signer(&format!("keygen {TREE}"), Some(SEED)).unwrap();
    let signed = signer(
        &format!("sign {TREE} --chain-id 1337 --leaf 2 --msg {MSG}"),
        Some(SEED),
    )
    .unwrap();
    let entry = signed["entry"].as_str().unwrap();
    let cases = [
        (format!("keygen {TREE}"), None, "bad_seed"),
        (format!("keygen {TREE}"), Some("0x1234"), "bad_seed"),
        (
            "keygen --height 21 --chains 1337".into(),
            Some(SEED),
            "bad_height",
        ),
        (
            "keygen --height 3 --chains 1337,1337".into(),
            Some(SEED),
            "bad_chain",
        ),
        (
            format!("sign {TREE} --chain-id 1 --leaf 0 --msg {MSG}"),
            Some(SEED),
            "bad_chain",
        ),
        (
            format!("sign {TREE} --chain-id 1337 --leaf 8 --msg {MSG}"),
            Some(SEED),
            "leaf_out_of_range",
        ),
        (
            format!("sign {TREE} --chain-id 1337 --leaf 0 --msg 0x1234"),
            Some(SEED),
            "bad_msg_length",
        ),
        ("keygen --chains 1337".into(), Some(SEED), "bad_args"),
        (format!("keygen --seed {SEED} {TREE}"), None, "bad_args"),
        (
            "vectors --height 3 --chains 1337 --out unused".into(),
            None,
            "bad_chain",
        ),
    ];
    for (args, seed, want) in cases {
        assert_eq!(code(signer(&args, seed)), want, "{args}");
    }
    let missing = signer("keygen --chains 1337", Some(SEED)).unwrap_err();
    assert!(
        missing.0 == "bad_args" && missing.1.contains("--height"),
        "the detail names the missing flag: {missing:?}"
    );
    assert_eq!(
        code(verify(&tree, 1337, 2, &entry[..entry.len() - 2])),
        "bad_entry_length"
    );
    assert_eq!(
        verify(&tree, 1337, 3, entry).unwrap_err(),
        ("verify_failed".into(), "root_mismatch".into())
    );
}

#[test]
fn tickets() {
    let path = temp("ticket");
    let export = |from: u32| {
        signer(
            &format!(
                "export-leaves {TREE} --chain-id 1337 --from {from} --to 7 --hot-start 4 --out {path}"
            ),
            Some(SEED),
        )
    };
    let cold = export(2).unwrap_err();
    assert!(cold.0 == "leaf_out_of_range" && cold.1.contains("no caps"));
    assert!(fs::metadata(&path).is_err(), "nothing written");

    assert_eq!(export(4).unwrap()["count"], 4);
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains(&SEED[2..]));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let sign = |rest: &str| {
        signer(
            &format!("sign --ticket-file {path} --msg {MSG} {rest}"),
            None,
        )
    };
    let from_seed = signer(
        &format!("sign {TREE} --chain-id 1337 --leaf 6 --msg {MSG}"),
        Some(SEED),
    );
    assert_eq!(sign("--leaf 6 --chain-id 1337"), from_seed);
    assert_eq!(code(sign("--leaf 3")), "leaf_not_in_ticket");
    assert_eq!(code(sign("--leaf 5 --chain-id 11155111")), "bad_chain");
    assert_eq!(code(sign("--leaf 5 --seed-file x")), "bad_args");

    let mut ticket: Value = serde_json::from_str(&text).unwrap();
    ticket["leaves"][1]["secrets"][0] = json!(MSG);
    fs::write(&path, ticket.to_string()).unwrap();
    assert_eq!(code(sign("--leaf 5")), "bad_ticket");
    fs::remove_file(&path).unwrap();
}

#[test]
fn seed_handling() {
    let path = temp("seed");
    fs::write(&path, format!("{OTHER_SEED}\n")).unwrap();
    let from_file = signer(&format!("keygen {TREE} --seed-file {path}"), Some(SEED));
    assert_eq!(
        from_file,
        signer(&format!("keygen {TREE}"), Some(OTHER_SEED))
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        code(signer(
            &format!("keygen {TREE} --seed-file {path}"),
            Some(SEED)
        )),
        "bad_seed"
    );

    for args in [
        format!("keygen {TREE}"),
        format!("pubkey {TREE} --chain-id 1337 --leaf 1"),
        format!("sign {TREE} --chain-id 1337 --leaf 1 --msg {MSG}"),
    ] {
        assert!(
            !signer(&args, Some(SEED))
                .unwrap()
                .to_string()
                .contains(&SEED[2..])
        );
    }
    let short = signer(&format!("keygen {TREE}"), Some(&SEED[..20])).unwrap_err();
    assert!(!short.1.contains(&SEED[2..20]));
}

#[test]
fn vectors_and_help() {
    let path = temp("vectors");
    let printed = signer(
        &format!("vectors --height 3 --chains 1337,11155111 --out {path}"),
        None,
    )
    .unwrap();
    let file: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        (printed["cases"].as_u64(), &printed["root"]),
        (Some(22), &file["root"])
    );
    fs::remove_file(&path).unwrap();

    let help = Command::new(env!("CARGO_BIN_EXE_signer"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success() && String::from_utf8_lossy(&help.stdout).contains("keygen"));
}
