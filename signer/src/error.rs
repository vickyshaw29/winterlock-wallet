use std::fmt;

use crate::consts::{MAX_HEIGHT, SLOTS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    BadHeight,
    BadChain,
    LeafOutOfRange,
    BadEntryLength,
    BadVersion,
    BadSlot,
    RootMismatch,
    LeafNotInTicket,
    BadTicket,
}

impl Error {
    pub fn as_str(self) -> &'static str {
        match self {
            Error::BadHeight => "bad_height",
            Error::BadChain => "bad_chain",
            Error::LeafOutOfRange => "leaf_out_of_range",
            Error::BadEntryLength => "bad_entry_length",
            Error::BadVersion => "bad_version",
            Error::BadSlot => "bad_slot",
            Error::RootMismatch => "root_mismatch",
            Error::LeafNotInTicket => "leaf_not_in_ticket",
            Error::BadTicket => "bad_ticket",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::BadHeight => write!(f, "height must be at most {MAX_HEIGHT}"),
            Error::BadChain => write!(f, "chain not listed, or list repeats or exceeds {SLOTS}"),
            Error::LeafOutOfRange => write!(f, "leaf outside the tree"),
            Error::BadEntryLength => write!(f, "entry must be 2274 + 32h bytes"),
            Error::BadVersion => write!(f, "unknown entry version"),
            Error::BadSlot => write!(f, "slot above {}", SLOTS - 1),
            Error::RootMismatch => write!(f, "signature does not reach the root"),
            Error::LeafNotInTicket => write!(f, "leaf not in ticket"),
            Error::BadTicket => write!(f, "ticket malformed or not under its root"),
        }
    }
}
