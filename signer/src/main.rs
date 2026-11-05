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
use signer::hash::{Hash, hex0x, parse_hash, parse_hex};
use signer::scheme::{self, Reject, SignError};
use signer::ticket::{self, Ticket, TicketError};
use signer::tree::{SLOTS, Tree};
use signer::{derive, entry, vectors};

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
    /// Sign a 32-byte message with one leaf, from the seed or from a ticket file.
    Sign(SignArgs),
    /// Cut hot-band leaves into a ticket file for a device that never holds the seed.
    ExportLeaves(ExportArgs),
    /// Check an entry the way the account's verify frame does.
    Verify(VerifyArgs),
    /// Write the shared test vector file, from a fixed public throwaway seed.
    Vectors(VectorArgs),
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
struct SignArgs {
    /// Sign from a ticket file instead of the master seed.
    #[arg(long, conflicts_with_all = ["seed_file", "height", "generation", "chains"])]
    ticket_file: Option<PathBuf>,
    /// File holding the 32-byte master seed as hex. Overrides PQ_SEED.
    #[arg(long)]
    seed_file: Option<PathBuf>,
    #[arg(long, required_unless_present = "ticket_file")]
    height: Option<u32>,
    #[arg(long)]
    generation: Option<u32>,
    #[arg(long, value_delimiter = ',', required_unless_present = "ticket_file")]
    chains: Vec<u64>,
    /// Required with the seed. With a ticket it is optional and must match the ticket.
    #[arg(long, required_unless_present = "ticket_file")]
    chain_id: Option<u64>,
    #[arg(long)]
    leaf: u32,
    #[arg(long)]
    msg: String,
}

#[derive(Args)]
struct ExportArgs {
    #[command(flatten)]
    tree: TreeArgs,
    #[arg(long)]
    chain_id: u64,
    /// First leaf to export, inclusive.
    #[arg(long)]
    from: u32,
    /// Last leaf to export, inclusive.
    #[arg(long)]
    to: u32,
    /// The account's hotStart. Leaves below it get no caps, so they are never exported.
    #[arg(long)]
    hot_start: u32,
    #[arg(long)]
    out: PathBuf,
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

#[derive(Args)]
struct VectorArgs {
    #[arg(long)]
    height: u32,
    /// Chain ids in slot order; at least two, so slot 1 is covered.
    #[arg(long, value_delimiter = ',', required = true)]
    chains: Vec<u64>,
    #[arg(long)]
    out: PathBuf,
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
        Command::Sign(args) => sign(&args),
        Command::ExportLeaves(args) => export_leaves(&args),
        Command::Verify(args) => verify(&args),
        Command::Vectors(args) => write_vectors(&args),
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

fn sign(args: &SignArgs) -> Result<Value, Fail> {
    let msg = parse_msg(&args.msg)?;
    let entry = match &args.ticket_file {
        Some(path) => sign_from_ticket(path, args.chain_id, args.leaf, &msg)?,
        None => sign_from_seed(args, &msg)?,
    };
    Ok(json!({
        "slot": entry.slot,
        "leaf": args.leaf,
        "signature": hex0x(entry.signature.as_flattened()),
        "authPath": entry.auth_path.iter().map(|w| hex0x(w)).collect::<Vec<_>>(),
        "entry": hex0x(&entry.encode()),
    }))
}

fn sign_from_seed(args: &SignArgs, msg: &Hash) -> Result<entry::Entry, Fail> {
    let height = check_height(
        args.height
            .expect("clap requires --height without a ticket"),
    )?;
    let chain_id = args
        .chain_id
        .expect("clap requires --chain-id without a ticket");
    slot_of(&args.chains, chain_id)?;
    check_leaf(args.leaf, height)?;
    let master = master_seed(args.seed_file.as_deref())?;

    let generation = args.generation.unwrap_or(0);
    scheme::sign(
        &master,
        generation,
        height,
        &args.chains,
        chain_id,
        args.leaf,
        msg,
    )
    .map_err(|e| match e {
        SignError::BadChain => fail("bad_chain", format!("chain {chain_id} is not in --chains")),
        SignError::LeafOutOfRange => fail("leaf_out_of_range", format!("leaf {}", args.leaf)),
    })
}

fn sign_from_ticket(
    path: &Path,
    chain_id: Option<u64>,
    leaf: u32,
    msg: &Hash,
) -> Result<entry::Entry, Fail> {
    let ticket = read_ticket(path)?;
    if let Some(id) = chain_id.filter(|&id| id != ticket.chain_id) {
        return Err(fail(
            "bad_chain",
            format!("the ticket is for chain {}, not {id}", ticket.chain_id),
        ));
    }
    ticket.sign(leaf, msg).map_err(|e| match e {
        TicketError::LeafNotInTicket => fail(
            "leaf_not_in_ticket",
            format!("leaf {leaf} is not in {}", path.display()),
        ),
        TicketError::Corrupt => fail(
            "bad_ticket",
            format!("leaf {leaf} does not hash up to the ticket's root"),
        ),
    })
}

fn read_ticket(path: &Path) -> Result<Ticket, Fail> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| fail("bad_ticket", format!("cannot read {}: {e}", path.display())))?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|e| fail("bad_ticket", format!("{} is not JSON: {e}", path.display())))?;
    Ticket::from_json(&json).ok_or_else(|| {
        fail(
            "bad_ticket",
            format!("{} is not a version-1 ticket", path.display()),
        )
    })
}

fn export_leaves(args: &ExportArgs) -> Result<Value, Fail> {
    let height = check_height(args.tree.height)?;
    let slot = slot_of(&args.tree.chains, args.chain_id)?;
    if args.from < args.hot_start {
        return Err(fail(
            "leaf_out_of_range",
            format!(
                "leaf {} is below --hot-start {}: a cold leaf on a hot device has no caps",
                args.from, args.hot_start
            ),
        ));
    }
    if args.from > args.to {
        return Err(fail(
            "leaf_out_of_range",
            format!("--from {} is after --to {}", args.from, args.to),
        ));
    }
    check_leaf(args.to, height)?;
    let master = master_seed(args.tree.seed_file.as_deref())?;

    let tree = Tree::build(&master, args.tree.generation, height, &args.tree.chains);
    let ticket = ticket::export(
        &tree,
        &master,
        args.tree.generation,
        args.chain_id,
        args.from,
        args.to,
    )
    .map_err(|_| fail("leaf_out_of_range", "range outside the tree"))?;
    let text = serde_json::to_string_pretty(&ticket.to_json()).unwrap() + "\n";
    write_secret_file(&args.out, &text).map_err(|e| {
        fail(
            "bad_args",
            format!("cannot write {}: {e}", args.out.display()),
        )
    })?;

    Ok(json!({
        "out": args.out.display().to_string(),
        "chainId": args.chain_id,
        "slot": slot,
        "from": args.from,
        "to": args.to,
        "count": args.to - args.from + 1,
    }))
}

/// Owner read and write only: the file holds one-time secrets.
fn write_secret_file(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::File::create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents.as_bytes())
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

fn write_vectors(args: &VectorArgs) -> Result<Value, Fail> {
    let height = check_height(args.height)?;
    if height < 2 {
        return Err(fail("bad_height", "vectors need height 2 or more"));
    }
    check_chains(&args.chains)?;
    if args.chains.len() < 2 {
        return Err(fail(
            "bad_chain",
            "list at least two chains so slot 1 is covered",
        ));
    }

    let file = vectors::generate(height, &args.chains);
    let write = || -> std::io::Result<()> {
        if let Some(dir) = args.out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&args.out, serde_json::to_string_pretty(&file)? + "\n")
    };
    write().map_err(|e| {
        fail(
            "bad_args",
            format!("cannot write {}: {e}", args.out.display()),
        )
    })?;

    Ok(json!({
        "out": args.out.display().to_string(),
        "cases": file["cases"].as_array().map_or(0, Vec::len),
        "root": file["root"],
    }))
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
