use std::io::Write;
use std::path::Path;

use serde_json::Value;
use signer::api::{self, Fail, fail};
use signer::hash::Hash;

pub fn seed(file: Option<&Path>) -> Result<Hash, Fail> {
    let text = match file {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| fail("bad_seed", format!("{}: {e}", path.display())))?,
        None => {
            std::env::var("PQ_SEED").map_err(|_| fail("bad_seed", "set --seed-file or PQ_SEED"))?
        }
    };
    api::seed(&text)
}

pub fn read_ticket(path: &Path) -> Result<Value, Fail> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| fail("bad_ticket", format!("{}: {e}", path.display())))?;
    serde_json::from_str(&text).map_err(|e| fail("bad_ticket", e.to_string()))
}

pub fn write_json(path: &Path, value: &Value, private: bool) -> Result<(), Fail> {
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = open_for_write(path, private)?;
        // A file that already existed keeps its old mode through the open: narrow it before writing.
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all((serde_json::to_string_pretty(value)? + "\n").as_bytes())
    };
    write().map_err(|e| fail("bad_args", format!("{}: {e}", path.display())))
}

/// A private file is created with mode 0600, so no other user can open it, not even
/// between the create and a later chmod.
fn open_for_write(path: &Path, private: bool) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    options.open(path)
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn private_file_is_created_0600() {
        let path = std::env::temp_dir().join(format!("signer-born-private-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let file = super::open_for_write(&path, true).unwrap();
        let mode = file.metadata().unwrap().permissions().mode() & 0o777;
        std::fs::remove_file(&path).unwrap();
        // With the usual umask 022, a plain create would give 0644 here.
        assert_eq!(
            mode & 0o077,
            0,
            "mode {mode:o} at creation, before any chmod"
        );
    }
}
