use crate::consts::{ENTRY_HEADER, ENTRY_VERSION, LEN, SIG_BYTES, SLOT_BITS, SLOTS};
use crate::error::Error;
use crate::hash::Hash;
use crate::wots::Chains;

pub fn len(height: u8) -> usize {
    ENTRY_HEADER + SIG_BYTES + 32 * usize::from(height + SLOT_BITS)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub slot: u8,
    pub signature: Chains,
    pub auth_path: Vec<Hash>,
}

impl Entry {
    pub fn encode(&self) -> Vec<u8> {
        let header = [ENTRY_VERSION, self.slot];
        [
            &header[..],
            self.signature.as_flattened(),
            self.auth_path.as_flattened(),
        ]
        .concat()
    }

    pub fn decode(bytes: &[u8], height: u8) -> Result<Entry, Error> {
        if bytes.len() != len(height) {
            return Err(Error::BadEntryLength);
        }
        if bytes[0] != ENTRY_VERSION {
            return Err(Error::BadVersion);
        }
        if usize::from(bytes[1]) >= SLOTS {
            return Err(Error::BadSlot);
        }
        let (signature, path) = bytes[ENTRY_HEADER..].as_chunks::<32>().0.split_at(LEN);
        Ok(Entry {
            slot: bytes[1],
            signature: signature.try_into().unwrap(),
            auth_path: path.to_vec(),
        })
    }
}
