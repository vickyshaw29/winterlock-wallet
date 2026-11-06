use std::hint::black_box;
use std::process::Command;
use std::time::{Duration, Instant};

use signer::codec::hex0x;
use signer::entry::Entry;
use signer::hash::{Hash, keccak};
use signer::tree::Tree;
use signer::{keys, merkle, scheme, ticket, wots};

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

fn per_call<T>(calls: u32, mut f: impl FnMut(u32) -> T) -> Duration {
    median(
        (0..5)
            .map(|_| {
                let start = Instant::now();
                (0..calls).for_each(|i| drop(black_box(f(i))));
                start.elapsed() / calls
            })
            .collect(),
    )
}

fn once<T>(runs: usize, mut f: impl FnMut() -> T) -> Duration {
    median(
        (0..runs)
            .map(|_| {
                let start = Instant::now();
                drop(black_box(f()));
                start.elapsed()
            })
            .collect(),
    )
}

fn fmt(d: Duration) -> String {
    match d.as_nanos() as f64 {
        ns if ns < 1e3 => format!("{ns:.0} ns"),
        ns if ns < 1e6 => format!("{:.1} µs", ns / 1e3),
        ns if ns < 1e9 => format!("{:.1} ms", ns / 1e6),
        ns => format!("{:.2} s", ns / 1e9),
    }
}

fn table(title: &str, header: &str) {
    let columns = header.matches('|').count() - 1;
    println!("\n## {title}\n\n{header}\n|{}", " --- |".repeat(columns));
}

fn row(cells: &[&str]) {
    println!("| {} |", cells.join(" | "));
}

fn main() {
    let master = keccak(&[b"bench"]);
    let msgs: Vec<Hash> = (0..1000u32).map(|i| keccak(&[&i.to_be_bytes()])).collect();
    let msg = |i: u32| &msgs[i as usize % msgs.len()];
    let sk = keys::secrets(&master, 0, 0);
    let seed = keys::public_seed(&keys::tree_seed(&master, 0), 0);
    let sigs: Vec<_> = msgs.iter().map(|m| wots::sign(&sk, &seed, m)).collect();
    let nodes: Vec<Hash> = (0..1024u32).map(|i| keccak(&[&i.to_be_bytes()])).collect();
    let (zeros, ones) = ([0u8; 32], [0xffu8; 32]);
    let (sig_zeros, sig_ones) = (
        wots::sign(&sk, &seed, &zeros),
        wots::sign(&sk, &seed, &ones),
    );

    table("Primitives", "| Operation | Hash calls | Time |");
    let prims: [(&str, &str, Duration); 11] = [
        (
            "keccak256, 64-byte input",
            "1",
            per_call(200_000, |i| keccak(&[msg(i), &master])),
        ),
        (
            "67 leaf secrets",
            "67",
            per_call(10_000, |i| keys::secrets(&master, 0, i)),
        ),
        (
            "16 chain masks",
            "16",
            per_call(10_000, |i| wots::masks(msg(i))),
        ),
        (
            "WOTS+ public key (one leaf)",
            "1,022",
            per_call(1_000, |_| wots::public_key_hash(&sk, &seed)),
        ),
        (
            "WOTS+ sign, random message",
            "~515",
            per_call(2_000, |i| wots::sign(&sk, &seed, msg(i))),
        ),
        (
            "WOTS+ sign, all-0 message (best)",
            "31",
            per_call(2_000, |_| wots::sign(&sk, &seed, &zeros)),
        ),
        (
            "WOTS+ sign, all-F message (worst)",
            "976",
            per_call(2_000, |_| wots::sign(&sk, &seed, &ones)),
        ),
        (
            "WOTS+ verify, random message",
            "~523",
            per_call(2_000, |i| {
                wots::recover_public_key_hash(&sigs[i as usize % 1000], &seed, msg(i))
            }),
        ),
        (
            "WOTS+ verify, all-F message (best)",
            "62",
            per_call(2_000, |_| {
                wots::recover_public_key_hash(&sig_ones, &seed, &ones)
            }),
        ),
        (
            "WOTS+ verify, all-0 message (worst)",
            "1,007",
            per_call(2_000, |_| {
                wots::recover_public_key_hash(&sig_zeros, &seed, &zeros)
            }),
        ),
        (
            "Merkle levels over 1,024 nodes",
            "1,023",
            per_call(200, |_| merkle::levels(nodes.clone())),
        ),
    ];
    for (name, hashes, d) in prims {
        row(&[name, hashes, &fmt(d)]);
    }

    table(
        "Tree build = keygen = the tree part of a cold sign",
        "| Height | Leaves per chain | 1 chain | 2 chains |",
    );
    let mut t14 = Duration::ZERO;
    for h in [4u8, 6, 8, 10, 12, 14] {
        let runs = if h <= 10 { 5 } else { 1 };
        let one = once(runs, || Tree::build(&master, 0, h, &[1337]).unwrap());
        let two = once(runs, || {
            Tree::build(&master, 0, h, &[1337, 11155111]).unwrap()
        });
        row(&[
            &h.to_string(),
            &(1u32 << h).to_string(),
            &fmt(one),
            &fmt(two),
        ]);
        t14 = one;
    }
    for h in [16u8, 18, 20] {
        let est = t14 * (1 << (h - 14));
        row(&[
            &h.to_string(),
            &(1u32 << h).to_string(),
            &format!("≈ {} (est.)", fmt(est)),
            &format!("≈ {} (est.)", fmt(est * 2)),
        ]);
    }

    let tree = Tree::build(&master, 0, 10, &[1337]).unwrap();
    let (tree_seed, root) = (tree.tree_seed(), tree.root());
    let entries: Vec<_> = msgs
        .iter()
        .map(|m| scheme::sign(&tree, 1337, 42, m).unwrap().encode())
        .collect();
    let tickets = ticket::export(&tree, 1337, 1008, 1023).unwrap();

    table(
        "Operations at h = 10, tree already built",
        "| Operation | Time |",
    );
    let ops: [(&str, Duration); 7] = [
        (
            "scheme::sign (secrets + WOTS+ sign + path)",
            per_call(2_000, |i| {
                scheme::sign(&tree, 1337, i % 1024, msg(i)).unwrap()
            }),
        ),
        (
            "scheme::verify (what the Yul will do)",
            per_call(2_000, |i| {
                scheme::verify(
                    &tree_seed,
                    &root,
                    10,
                    1337,
                    42,
                    msg(i),
                    &entries[i as usize % 1000],
                )
            }),
        ),
        (
            "pubkey: derive one leaf, no tree",
            per_call(2_000, |i| keys::leaf(&master, 0, i, 1337)),
        ),
        (
            "auth path, 14 siblings",
            per_call(200_000, |i| tree.auth_path(0, i % 1024)),
        ),
        (
            "entry decode, 2,594 bytes",
            per_call(200_000, |i| {
                Entry::decode(&entries[i as usize % 1000], 10).unwrap()
            }),
        ),
        (
            "export 16 tickets",
            per_call(200, |_| ticket::export(&tree, 1337, 1008, 1023).unwrap()),
        ),
        (
            "ticket sign (incl. root self-check)",
            per_call(2_000, |i| tickets.sign(1008 + i % 16, msg(i)).unwrap()),
        ),
    ];
    for (name, d) in ops {
        row(&[name, &fmt(d)]);
    }

    let dir = std::env::temp_dir().join(format!("signer-bench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ticket_path = dir.join("ticket.json");
    let (seed_hex, msg_hex) = (hex0x(&master), hex0x(&msgs[0]));
    let tree_args = "--height 10 --chains 1337";
    let run = |args: String| {
        let out = Command::new(env!("CARGO_BIN_EXE_signer"))
            .args(args.split_whitespace())
            .env("PQ_SEED", &seed_hex)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    };
    let export = format!(
        "export-leaves {tree_args} --chain-id 1337 --from 1008 --to 1023 --hot-start 1008 --out {}",
        ticket_path.display()
    );
    run(export.clone());
    let entry = hex0x(&entries[0]);
    let verify = format!(
        "verify --tree-seed {} --root {} --height 10 --chain-id 1337 --leaf 42 --msg {msg_hex} --entry {entry}",
        hex0x(&tree_seed),
        hex0x(&root)
    );

    table(
        "CLI end to end at h = 10 (process start, JSON, files)",
        "| Command | Time |",
    );
    let commands = [
        ("signer keygen", format!("keygen {tree_args}")),
        (
            "signer sign (seed: builds the tree)",
            format!("sign {tree_args} --chain-id 1337 --leaf 42 --msg {msg_hex}"),
        ),
        (
            "signer sign --ticket-file",
            format!(
                "sign --ticket-file {} --leaf 1010 --msg {msg_hex}",
                ticket_path.display()
            ),
        ),
        ("signer verify", verify),
        (
            "signer pubkey",
            format!("pubkey {tree_args} --chain-id 1337 --leaf 42"),
        ),
        ("signer export-leaves (16)", export),
    ];
    for (name, args) in commands {
        row(&[name, &fmt(once(7, || run(args.clone())))]);
    }
    std::fs::remove_dir_all(&dir).unwrap();
}
