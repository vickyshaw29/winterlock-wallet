//! The signer CLI. All file and environment access lives here, so the library
//! stays pure and portable to WebAssembly.
//!
//! Contract: exit 0 with exactly one JSON object on stdout, or exit 1 with
//! {"error": code, "detail": text} on stderr. Nothing else is ever printed, and
//! no output ever contains the master seed.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::error::ErrorKind;
use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};
use signer::hash::Hash;
use signer::scheme::{self, Reject, SignError};
use signer::tree::{SLOTS, Tree};
use signer::{derive, entry};

/// Signing builds the whole tree, and h = 20 already takes minutes per chain.
const MAX_HEIGHT: u32 = 20;

#[derive(Parser)]
#[command(
    name = "signer",
    about = "Nonce-bound WOTS+ signer: one master seed, a key tree, JSON out"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Build the tree and print its root and tree seed.
    Keygen(TreeArgs),
    /// Print one leaf's public seed, public key hash and leaf node.
    Pubkey {
        #[command(flatten)]
        tree: TreeArgs,
        #[command(flatten)]
        at: LeafArgs,
    },
    /// Sign a 32-byte message with one leaf.
    Sign {
        #[command(flatten)]
        tree: TreeArgs,
        #[command(flatten)]
        at: LeafArgs,
        #[arg(long)]
        msg: String,
    },
    /// Check an entry the way the account's verify frame does.
    Verify(VerifyArgs),
}

#[derive(Args)]
struct TreeArgs {
    /// File holding the 32-byte master seed as hex. Overrides PQ_SEED.
    #[arg(long)]
    seed_file: Option<PathBuf>,
    /// Height of each chain's subtree (2^h leaves per chain).
    #[arg(long)]
    height: u32,
    /// The account's epoch: 0 at creation, +1 per rotation.
    #[arg(long, default_value_t = 0)]
    generation: u32,
    /// Chain ids in slot order, comma separated.
    #[arg(long, value_delimiter = ',', required = true)]
    chains: Vec<u64>,
}

#[derive(Args)]
struct LeafArgs {
    #[arg(long)]
    chain_id: u64,
    /// The per-chain leaf index, which the nonce key carries.
    #[arg(long)]
    leaf: u32,
}

#[derive(Args)]
struct VerifyArgs {
    #[arg(long)]
    tree_seed: String,
    #[arg(long)]
    root: String,
    #[arg(long)]
    height: u32,
    #[arg(long)]
    chain_id: u64,
    #[arg(long)]
    leaf: u32,
    #[arg(long)]
    msg: String,
    #[arg(long)]
    entry: String,
}

struct Fail {
    code: &'static str,
    detail: String,
}

fn fail(code: &'static str, detail: impl Into<String>) -> Fail {
    Fail {
        code,
        detail: detail.into(),
    }
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) => {
            let _ = e.print();
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            let detail = e.to_string();
            return report(Err(fail("bad_args", detail.lines().next().unwrap_or(""))));
        }
    };

    report(match cli.command {
        Command::Keygen(tree) => keygen(&tree),
        Command::Pubkey { tree, at } => pubkey(&tree, &at),
        Command::Sign { tree, at, msg } => sign(&tree, &at, &msg),
        Command::Verify(args) => verify(&args),
    })
}

fn report(result: Result<Value, Fail>) -> ExitCode {
    match result {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(f) => {
            eprintln!("{}", json!({ "error": f.code, "detail": f.detail }));
            ExitCode::FAILURE
        }
    }
}

fn keygen(args: &TreeArgs) -> Result<Value, Fail> {
    let height = check_height(args.height)?;
    check_chains(&args.chains)?;
    let master = master_seed(args.seed_file.as_deref())?;

    let tree = Tree::build(&master, args.generation, height, &args.chains);
    Ok(json!({
        "treeSeed": hex0x(&derive::tree_seed(&master, args.generation)),
        "root": hex0x(&tree.root()),
        "height": height,
        "generation": args.generation,
        "chains": args.chains,
        "leafCountPerChain": 1u64 << height,
    }))
}

fn pubkey(args: &TreeArgs, at: &LeafArgs) -> Result<Value, Fail> {
    let height = check_height(args.height)?;
    let slot = slot_of(&args.chains, at.chain_id)?;
    check_leaf(at.leaf, height)?;
    let master = master_seed(args.seed_file.as_deref())?;

    // One leaf needs no tree: derive it directly.
    let index = derive::leaf_index(slot, at.leaf, height);
    let leaf = derive::leaf(&master, args.generation, index, at.chain_id);
    Ok(json!({
        "chainId": at.chain_id,
        "slot": slot,
        "leaf": at.leaf,
        "index": index,
        "publicSeed": hex0x(&leaf.public_seed),
        "publicKeyHash": hex0x(&leaf.public_key_hash),
        "leafNode": hex0x(&leaf.node),
    }))
}

fn sign(args: &TreeArgs, at: &LeafArgs, msg: &str) -> Result<Value, Fail> {
    let height = check_height(args.height)?;
    slot_of(&args.chains, at.chain_id)?;
    check_leaf(at.leaf, height)?;
    let msg = parse_msg(msg)?;
    let master = master_seed(args.seed_file.as_deref())?;

    let entry = scheme::sign(
        &master,
        args.generation,
        height,
        &args.chains,
        at.chain_id,
        at.leaf,
        &msg,
    )
    .map_err(|e| match e {
        SignError::BadChain => fail(
            "bad_chain",
            format!("chain {} is not in --chains", at.chain_id),
        ),
        SignError::LeafOutOfRange => fail("leaf_out_of_range", format!("leaf {}", at.leaf)),
    })?;

    Ok(json!({
        "slot": entry.slot,
        "leaf": at.leaf,
        "signature": hex0x(entry.signature.as_flattened()),
        "authPath": entry.auth_path.iter().map(|w| hex0x(w)).collect::<Vec<_>>(),
        "entry": hex0x(&entry.encode()),
    }))
}

fn verify(args: &VerifyArgs) -> Result<Value, Fail> {
    let height = check_height(args.height)?;
    check_leaf(args.leaf, height)?;
    let tree_seed = parse_hash(&args.tree_seed)
        .ok_or_else(|| fail("bad_args", "--tree-seed must be 32 bytes of hex"))?;
    let root =
        parse_hash(&args.root).ok_or_else(|| fail("bad_args", "--root must be 32 bytes of hex"))?;
    let msg = parse_msg(&args.msg)?;
    let bytes =
        parse_hex(&args.entry).ok_or_else(|| fail("bad_entry_length", "--entry is not hex"))?;

    match scheme::verify(
        &tree_seed,
        &root,
        height,
        args.chain_id,
        args.leaf,
        &msg,
        &bytes,
    ) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(Reject::BadEntryLength) => Err(fail(
            "bad_entry_length",
            format!("{} bytes, expected {}", bytes.len(), entry::len(height)),
        )),
        Err(Reject::LeafOutOfRange) => {
            Err(fail("leaf_out_of_range", format!("leaf {}", args.leaf)))
        }
        Err(reject) => Err(fail("verify_failed", reject.reason())),
    }
}

/// --seed-file wins over PQ_SEED: an explicit flag beats the environment.
/// Error details never echo the seed.
fn master_seed(file: Option<&Path>) -> Result<Hash, Fail> {
    let text = match file {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| fail("bad_seed", format!("cannot read {}: {e}", path.display())))?,
        None => std::env::var("PQ_SEED")
            .map_err(|_| fail("bad_seed", "give --seed-file or set PQ_SEED"))?,
    };
    parse_hash(text.trim()).ok_or_else(|| fail("bad_seed", "the seed must be 32 bytes of hex"))
}

fn check_height(height: u32) -> Result<u8, Fail> {
    if height > MAX_HEIGHT {
        return Err(fail(
            "bad_height",
            format!("height {height} is above {MAX_HEIGHT}: signing builds the whole tree"),
        ));
    }
    Ok(height as u8)
}

fn check_chains(chains: &[u64]) -> Result<(), Fail> {
    if chains.len() > SLOTS {
        return Err(fail(
            "bad_chain",
            format!("at most {SLOTS} chains per tree"),
        ));
    }
    for (i, chain) in chains.iter().enumerate() {
        if chains[..i].contains(chain) {
            return Err(fail("bad_chain", format!("chain {chain} is listed twice")));
        }
    }
    Ok(())
}

fn slot_of(chains: &[u64], chain_id: u64) -> Result<u8, Fail> {
    check_chains(chains)?;
    chains
        .iter()
        .position(|&c| c == chain_id)
        .map(|s| s as u8)
        .ok_or_else(|| fail("bad_chain", format!("chain {chain_id} is not in --chains")))
}

fn check_leaf(leaf: u32, height: u8) -> Result<(), Fail> {
    if leaf >= 1 << height {
        return Err(fail(
            "leaf_out_of_range",
            format!("leaf {leaf} is not below 2^{height}"),
        ));
    }
    Ok(())
}

fn parse_msg(s: &str) -> Result<Hash, Fail> {
    parse_hash(s).ok_or_else(|| fail("bad_msg_length", "--msg must be 32 bytes of hex"))
}

/// Accepts either case, with or without 0x.
fn parse_hex(s: &str) -> Option<Vec<u8>> {
    let digits = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    hex::decode(digits).ok()
}

fn parse_hash(s: &str) -> Option<Hash> {
    parse_hex(s)?.try_into().ok()
}

/// Always 0x-prefixed lowercase.
fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}
