use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "signer", about = "Nonce-bound WOTS+ signer")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Build the key tree and print its root
    Keygen(TreeArgs),
    /// Print one leaf's public key
    Pubkey(PubkeyArgs),
    /// Sign a 32-byte message from the seed or a ticket
    Sign(SignArgs),
    /// Check an entry as the account's verify frame does
    Verify(VerifyArgs),
    /// Write hot-band leaves to a ticket file
    ExportLeaves(ExportArgs),
    /// Write the shared test vector file
    Vectors(VectorArgs),
}

#[derive(Args)]
pub struct TreeArgs {
    /// Overrides PQ_SEED
    #[arg(long)]
    pub seed_file: Option<PathBuf>,
    #[arg(long)]
    pub height: u8,
    #[arg(long, default_value_t = 0)]
    pub generation: u32,
    #[arg(long, value_delimiter = ',', required = true)]
    pub chains: Vec<u64>,
}

#[derive(Args)]
pub struct PubkeyArgs {
    #[command(flatten)]
    pub tree: TreeArgs,
    #[arg(long)]
    pub chain_id: u64,
    #[arg(long)]
    pub leaf: u32,
}

#[derive(Args)]
pub struct SignArgs {
    #[arg(long, conflicts_with_all = ["seed_file", "height", "generation", "chains"])]
    pub ticket_file: Option<PathBuf>,
    #[arg(long)]
    pub seed_file: Option<PathBuf>,
    #[arg(long, required_unless_present = "ticket_file")]
    pub height: Option<u8>,
    #[arg(long, default_value_t = 0)]
    pub generation: u32,
    #[arg(long, value_delimiter = ',', required_unless_present = "ticket_file")]
    pub chains: Vec<u64>,
    #[arg(long, required_unless_present = "ticket_file")]
    pub chain_id: Option<u64>,
    #[arg(long)]
    pub leaf: u32,
    #[arg(long)]
    pub msg: String,
}

#[derive(Args)]
pub struct VerifyArgs {
    #[arg(long)]
    pub tree_seed: String,
    #[arg(long)]
    pub root: String,
    #[arg(long)]
    pub height: u8,
    #[arg(long)]
    pub chain_id: u64,
    #[arg(long)]
    pub leaf: u32,
    #[arg(long)]
    pub msg: String,
    #[arg(long)]
    pub entry: String,
}

#[derive(Args)]
pub struct ExportArgs {
    #[command(flatten)]
    pub tree: TreeArgs,
    #[arg(long)]
    pub chain_id: u64,
    #[arg(long)]
    pub from: u32,
    #[arg(long)]
    pub to: u32,
    /// The account's hotStart; colder leaves are refused
    #[arg(long)]
    pub hot_start: u32,
    #[arg(long)]
    pub out: PathBuf,
}

#[derive(Args)]
pub struct VectorArgs {
    #[arg(long)]
    pub height: u8,
    #[arg(long, value_delimiter = ',', required = true)]
    pub chains: Vec<u64>,
    #[arg(long)]
    pub out: PathBuf,
}
