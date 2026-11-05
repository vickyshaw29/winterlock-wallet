use std::io::Write;
use std::path::Path;

use serde_json::Value;
use signer::codec::parse_hash;
use signer::error::Error;
use signer::hash::Hash;
use signer::ticket::Ticket;

use crate::{Fail, fail};

pub fn seed(file: Option<&Path>) -> Result<Hash, Fail> {
    let text = match file {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| fail("bad_seed", format!("{}: {e}", path.display())))?,
        None => {
            std::env::var("PQ_SEED").map_err(|_| fail("bad_seed", "set --seed-file or PQ_SEED"))?
        }
    };
    parse_hash(text.trim()).ok_or_else(|| fail("bad_seed", "seed must be 32 bytes of hex"))
}

pub fn msg(s: &str) -> Result<Hash, Fail> {
    parse_hash(s).ok_or_else(|| fail("bad_msg_length", "msg must be 32 bytes of hex"))
}

pub fn read_ticket(path: &Path) -> Result<Ticket, Fail> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| fail("bad_ticket", format!("{}: {e}", path.display())))?;
    let json: Value = serde_json::from_str(&text).map_err(|e| fail("bad_ticket", e.to_string()))?;
    Ok(Ticket::from_json(&json).ok_or(Error::BadTicket)?)
}

pub fn write_json(path: &Path, value: &Value, private: bool) -> Result<(), Fail> {
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = std::fs::File::create(path)?;
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all((serde_json::to_string_pretty(value)? + "\n").as_bytes())
    };
    write().map_err(|e| fail("bad_args", format!("{}: {e}", path.display())))
}
