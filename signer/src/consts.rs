pub const W: usize = 16;
pub const LEN1: usize = 64;
pub const LEN2: usize = 3;
pub const LEN: usize = LEN1 + LEN2;
pub const SIG_BYTES: usize = LEN * 32;

pub const SLOT_BITS: u8 = 4;
pub const SLOTS: usize = 1 << SLOT_BITS;
pub const MAX_HEIGHT: u8 = 20;

pub const ENTRY_VERSION: u8 = 1;
pub const ENTRY_HEADER: usize = 2;
pub const TICKET_VERSION: u64 = 1;
pub const VECTORS_VERSION: u64 = 2;

pub const TAG_SECRET: u8 = 0x01;
pub const TAG_TREE_SEED: u8 = 0x02;
pub const TAG_MASK: u8 = 0x03;

pub const EMPTY_SLOT_LABEL: &[u8] = b"nonce-bound-pq-wallet/empty-slot";
pub const VECTOR_SEED_LABEL: &[u8] = b"nonce-bound-pq-wallet/test-vectors";
pub const VECTOR_MESSAGE_LABEL: &[u8] = b"nonce-bound-pq-wallet/vector-message";
pub const VECTOR_OTHER_MESSAGE_LABEL: &[u8] = b"nonce-bound-pq-wallet/another-message";
