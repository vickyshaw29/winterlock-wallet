//! Runs the real binary and checks the JSON contract: exit 0 with one object on
//! stdout, or exit 1 with {"error", "detail"} on stderr, and never the seed.

use std::process::{Command, Output};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_signer");
const SEED: &str = "0x0707070707070707070707070707070707070707070707070707070707070707";
const OTHER_SEED: &str = "0x0909090909090909090909090909090909090909090909090909090909090909";
const MSG: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const TREE: [&str; 6] = [
    "--height",
    "3",
    "--generation",
    "2",
    "--chains",
    "1337,11155111",
];

fn run(args: &[&str], seed: Option<&str>) -> Output {
    let mut cmd = Command::new(BIN);
    cmd.args(args).env_remove("PQ_SEED");
    if let Some(seed) = seed {
        cmd.env("PQ_SEED", seed);
    }
    cmd.output().unwrap()
}

/// Expects success: one JSON object on one stdout line, nothing on stderr.
fn ok(args: &[&str], seed: Option<&str>) -> Value {
    let out = run(args, seed);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{args:?} failed: {stderr}");
    assert!(stderr.is_empty(), "stderr on success: {stderr}");
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "exactly one line: {stdout}");
    serde_json::from_str(&stdout).unwrap()
}

/// Expects failure: exit 1, nothing on stdout, a JSON error on stderr. Returns (code, detail).
fn err(args: &[&str], seed: Option<&str>) -> (String, String) {
    let out = run(args, seed);
    assert_eq!(out.status.code(), Some(1), "{args:?} should exit 1");
    assert!(out.stdout.is_empty(), "stdout on failure");
    let body: Value = serde_json::from_slice(&out.stderr).unwrap();
    (
        body["error"].as_str().unwrap().to_string(),
        body["detail"].as_str().unwrap().to_string(),
    )
}

fn with(command: &str, rest: &[&str]) -> Vec<String> {
    let mut args = vec![command.to_string()];
    args.extend(TREE.iter().chain(rest).map(|s| s.to_string()));
    args
}

fn refs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

#[test]
fn keygen_sign_verify_round_trip() {
    let keygen = ok(&refs(&with("keygen", &[])), Some(SEED));
    assert_eq!(keygen["leafCountPerChain"], 8);
    assert_eq!(keygen["chains"], json!([1337, 11155111]));

    let signed = ok(
        &refs(&with(
            "sign",
            &["--chain-id", "11155111", "--leaf", "5", "--msg", MSG],
        )),
        Some(SEED),
    );
    assert_eq!(signed["slot"], 1);
    assert_eq!(signed["authPath"].as_array().unwrap().len(), 3 + 4);
    let entry = signed["entry"].as_str().unwrap();
    assert_eq!(entry.len(), 2 + 2 * (2274 + 32 * 3));

    let verified = ok(
        &[
            "verify",
            "--tree-seed",
            keygen["treeSeed"].as_str().unwrap(),
            "--root",
            keygen["root"].as_str().unwrap(),
            "--height",
            "3",
            "--chain-id",
            "11155111",
            "--leaf",
            "5",
            "--msg",
            MSG,
            "--entry",
            entry,
        ],
        None,
    );
    assert_eq!(verified, json!({ "ok": true }));
}

#[test]
fn pubkey_matches_the_full_index() {
    let key = ok(
        &refs(&with("pubkey", &["--chain-id", "11155111", "--leaf", "5"])),
        Some(SEED),
    );
    assert_eq!(key["slot"], 1);
    assert_eq!(key["index"], (1 << 3) | 5);
    for field in ["publicSeed", "publicKeyHash", "leafNode"] {
        assert_eq!(key[field].as_str().unwrap().len(), 66, "{field}");
    }
}

#[test]
fn every_error_code_is_reachable() {
    let keygen = ok(&refs(&with("keygen", &[])), Some(SEED));
    let signed = ok(
        &refs(&with(
            "sign",
            &["--chain-id", "1337", "--leaf", "2", "--msg", MSG],
        )),
        Some(SEED),
    );
    let entry = signed["entry"].as_str().unwrap();
    let verify = |leaf: &str, entry: &str| {
        err(
            &[
                "verify",
                "--tree-seed",
                keygen["treeSeed"].as_str().unwrap(),
                "--root",
                keygen["root"].as_str().unwrap(),
                "--height",
                "3",
                "--chain-id",
                "1337",
                "--leaf",
                leaf,
                "--msg",
                MSG,
                "--entry",
                entry,
            ],
            None,
        )
    };
    let sign_leaf = |rest: &[&str]| err(&refs(&with("sign", rest)), Some(SEED));

    assert_eq!(err(&refs(&with("keygen", &[])), None).0, "bad_seed");
    assert_eq!(
        err(&refs(&with("keygen", &[])), Some("0x1234")).0,
        "bad_seed"
    );
    assert_eq!(
        err(
            &["keygen", "--height", "21", "--chains", "1337"],
            Some(SEED)
        )
        .0,
        "bad_height"
    );
    assert_eq!(
        sign_leaf(&["--chain-id", "1", "--leaf", "0", "--msg", MSG]).0,
        "bad_chain"
    );
    assert_eq!(
        err(
            &["keygen", "--height", "3", "--chains", "1337,1337"],
            Some(SEED)
        )
        .0,
        "bad_chain"
    );
    assert_eq!(
        sign_leaf(&["--chain-id", "1337", "--leaf", "8", "--msg", MSG]).0,
        "leaf_out_of_range"
    );
    assert_eq!(
        sign_leaf(&["--chain-id", "1337", "--leaf", "0", "--msg", "0x1234"]).0,
        "bad_msg_length"
    );
    assert_eq!(verify("2", &entry[..entry.len() - 2]).0, "bad_entry_length");
    assert_eq!(
        verify("3", entry),
        ("verify_failed".to_string(), "root_mismatch".to_string())
    );
    assert_eq!(
        err(&["keygen", "--chains", "1337"], Some(SEED)).0,
        "bad_args"
    );
    // There is deliberately no --seed flag.
    assert_eq!(
        err(
            &[
                "keygen", "--seed", SEED, "--height", "3", "--chains", "1337"
            ],
            None
        )
        .0,
        "bad_args"
    );
}

#[test]
fn no_output_contains_the_seed() {
    let seed_digits = &SEED[2..];
    let outputs = [
        ok(&refs(&with("keygen", &[])), Some(SEED)),
        ok(
            &refs(&with("pubkey", &["--chain-id", "1337", "--leaf", "1"])),
            Some(SEED),
        ),
        ok(
            &refs(&with(
                "sign",
                &["--chain-id", "1337", "--leaf", "1", "--msg", MSG],
            )),
            Some(SEED),
        ),
    ];
    for out in outputs {
        assert!(!out.to_string().contains(seed_digits));
    }
    let (_, detail) = err(&refs(&with("keygen", &[])), Some(&SEED[..20]));
    assert!(
        !detail.contains(&SEED[2..20]),
        "error detail echoes the seed"
    );
}

#[test]
fn seed_file_overrides_the_environment() {
    let path = std::env::temp_dir().join(format!("signer-cli-test-{}.hex", std::process::id()));
    std::fs::write(&path, format!("{OTHER_SEED}\n")).unwrap();
    let file = path.to_str().unwrap();

    let from_file = ok(&refs(&with("keygen", &["--seed-file", file])), Some(SEED));
    let from_env = ok(&refs(&with("keygen", &[])), Some(OTHER_SEED));
    assert_eq!(
        from_file["root"], from_env["root"],
        "the file's seed was used"
    );
    std::fs::remove_file(&path).unwrap();

    let missing = err(&refs(&with("keygen", &["--seed-file", file])), Some(SEED));
    assert_eq!(missing.0, "bad_seed");
}

#[test]
fn help_is_plain_text() {
    let out = run(&["--help"], None);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("keygen"));
}

#[test]
fn vectors_writes_a_file() {
    let path = std::env::temp_dir().join(format!("signer-vectors-{}.json", std::process::id()));
    let out = path.to_str().unwrap();

    let printed = ok(
        &[
            "vectors",
            "--height",
            "3",
            "--chains",
            "1337,11155111",
            "--out",
            out,
        ],
        None,
    );
    assert_eq!(printed["cases"], 22);
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(file["version"], 2);
    assert_eq!(file["root"], printed["root"]);
    std::fs::remove_file(&path).unwrap();

    let one_chain = err(
        &["vectors", "--height", "3", "--chains", "1337", "--out", out],
        None,
    );
    assert_eq!(one_chain.0, "bad_chain");
}

fn temp_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("signer-{name}-{}.json", std::process::id()))
}

/// Exports leaves 4–7 of chain 1337 (hot start 4) and returns the ticket path.
fn export_ticket(name: &str) -> std::path::PathBuf {
    let path = temp_path(name);
    let out = path.to_str().unwrap();
    let printed = ok(
        &refs(&with(
            "export-leaves",
            &[
                "--chain-id",
                "1337",
                "--from",
                "4",
                "--to",
                "7",
                "--hot-start",
                "4",
                "--out",
                out,
            ],
        )),
        Some(SEED),
    );
    assert_eq!(printed["count"], 4);
    assert_eq!(printed["slot"], 0);
    path
}

#[test]
fn ticket_signs_the_same_bytes_as_the_seed() {
    let path = export_ticket("ticket-same");
    let ticket = path.to_str().unwrap();

    let from_ticket = ok(
        &[
            "sign",
            "--ticket-file",
            ticket,
            "--leaf",
            "6",
            "--msg",
            MSG,
            "--chain-id",
            "1337",
        ],
        None,
    );
    let from_seed = ok(
        &refs(&with(
            "sign",
            &["--chain-id", "1337", "--leaf", "6", "--msg", MSG],
        )),
        Some(SEED),
    );
    assert_eq!(from_ticket, from_seed);

    let keygen = ok(&refs(&with("keygen", &[])), Some(SEED));
    let verified = ok(
        &[
            "verify",
            "--tree-seed",
            keygen["treeSeed"].as_str().unwrap(),
            "--root",
            keygen["root"].as_str().unwrap(),
            "--height",
            "3",
            "--chain-id",
            "1337",
            "--leaf",
            "6",
            "--msg",
            MSG,
            "--entry",
            from_ticket["entry"].as_str().unwrap(),
        ],
        None,
    );
    assert_eq!(verified, json!({ "ok": true }));
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn ticket_refusals() {
    let path = export_ticket("ticket-refusals");
    let ticket = path.to_str().unwrap();
    let sign_ticket = |leaf: &str, extra: &[&str]| {
        let mut args = vec![
            "sign",
            "--ticket-file",
            ticket,
            "--leaf",
            leaf,
            "--msg",
            MSG,
        ];
        args.extend(extra);
        err(&args, None).0
    };

    assert_eq!(sign_ticket("3", &[]), "leaf_not_in_ticket");
    assert_eq!(sign_ticket("8", &[]), "leaf_not_in_ticket");
    assert_eq!(sign_ticket("5", &["--chain-id", "11155111"]), "bad_chain");
    assert_eq!(sign_ticket("5", &["--seed-file", ticket]), "bad_args");

    // One changed secret no longer hashes up to the root.
    let mut json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    json["leaves"][1]["secrets"][0] = json!(MSG);
    std::fs::write(&path, json.to_string()).unwrap();
    assert_eq!(sign_ticket("5", &[]), "bad_ticket");

    std::fs::write(&path, "not json").unwrap();
    assert_eq!(sign_ticket("5", &[]), "bad_ticket");
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn export_refuses_cold_leaves() {
    let out = temp_path("ticket-cold");
    let refused = err(
        &refs(&with(
            "export-leaves",
            &[
                "--chain-id",
                "1337",
                "--from",
                "2",
                "--to",
                "7",
                "--hot-start",
                "4",
                "--out",
                out.to_str().unwrap(),
            ],
        )),
        Some(SEED),
    );
    assert_eq!(refused.0, "leaf_out_of_range");
    assert!(refused.1.contains("no caps"), "{}", refused.1);
    assert!(!out.exists(), "nothing written");
}

#[test]
fn ticket_file_holds_no_seed_and_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let path = export_ticket("ticket-private");
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains(&SEED[2..]), "the seed is in the ticket");
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    std::fs::remove_file(&path).unwrap();
}
