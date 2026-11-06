mod args;
mod commands;
mod io;

use std::process::ExitCode;

use clap::Parser;
use clap::error::ErrorKind;
use serde_json::json;
use signer::api::fail;

use args::{Cli, Command};

fn main() -> ExitCode {
    let result = match Cli::try_parse() {
        Ok(cli) => match cli.command {
            Command::Keygen(a) => commands::keygen(&a),
            Command::Pubkey(a) => commands::pubkey(&a),
            Command::Sign(a) => commands::sign(&a),
            Command::Verify(a) => commands::verify(&a),
            Command::ExportLeaves(a) => commands::export_leaves(&a),
            Command::Vectors(a) => commands::vectors(&a),
        },
        Err(e) if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) => {
            let _ = e.print();
            return ExitCode::SUCCESS;
        }
        Err(e) => Err(fail(
            "bad_args",
            e.to_string().lines().next().unwrap_or_default(),
        )),
    };
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
