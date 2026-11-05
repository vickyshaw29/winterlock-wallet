//! The signature entry the account copies in with SIGDATACOPY:
//! version (1) ‖ slot (1) ‖ WOTS+ signature (2,144) ‖ auth path (32 × (h + 4)).

use crate::hash::Hash;
use crate::scheme::Reject;
use crate::tree::{SLOT_BITS, SLOTS};
use crate::wots::{self, Chains};

pub const VERSION: u8 = 0x01;
const HEADER: usize = 2;

/// 2,274 + 32h bytes: 2,594 at h = 10.
pub fn len(height: u8) -> usize {
    HEADER + wots::SIG_BYTES + 32 * (height as usize + SLOT_BITS as usize)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub slot: u8,
    pub signature: Chains,
    pub auth_path: Vec<Hash>,
}

impl Entry {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER + wots::SIG_BYTES + 32 * self.auth_path.len());
        out.push(VERSION);
        out.push(self.slot);
        out.extend_from_slice(self.signature.as_flattened());
        out.extend_from_slice(self.auth_path.as_flattened());
        out
    }

    /// Checks length, version and slot in the verifier's order, then splits the bytes.
    pub fn decode(bytes: &[u8], height: u8) -> Result<Entry, Reject> {
        if bytes.len() != len(height) {
            return Err(Reject::BadEntryLength);
        }
        if bytes[0] != VERSION {
            return Err(Reject::BadVersion);
        }
        let slot = bytes[1];
        if slot as usize >= SLOTS {
            return Err(Reject::BadSlot);
        }
        let (words, _) = bytes[HEADER..].as_chunks::<32>();
        let (signature, path) = words.split_at(wots::LEN);
        Ok(Entry {
            slot,
            signature: signature.try_into().unwrap(),
            auth_path: path.to_vec(),
        })
    }
}
