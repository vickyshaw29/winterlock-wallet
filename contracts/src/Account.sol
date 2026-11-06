// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// EIP-8141 account signed with one-time WOTS+ keys from a Merkle tree. Each transaction names its leaf with a fresh
/// nonce key, (epoch << 32) | leaf, which the protocol consumes when the verify frame approves: the account never
/// records used leaves. The verify frame runs `Verifier.yul` by delegatecall.
contract Account {
    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;
    uint8 internal constant MAX_HEIGHT = 20;

    address public immutable verifier;

    bytes32 public root;
    bytes32 public treeSeed;
    uint8 public height;
    uint32 public epoch;

    event Rotated(uint32 epoch, bytes32 root);

    error Rejected(uint256 reason);
    error NotEntryPoint();
    error NotSelf();
    error BadTree();

    /// `epoch` is the tree's keygen generation, at least 1.
    constructor(address verifier_, bytes32 root_, bytes32 treeSeed_, uint8 height_, uint32 epoch_) payable {
        if (epoch_ == 0) revert BadTree();
        verifier = verifier_;
        epoch = epoch_;
        _setTree(root_, treeSeed_, height_);
    }

    /// The verify frame, whose data is empty, so there is no receive(): it would take the call. Anyone else may only
    /// send ETH. The verifier reads only the four words passed here; tests append a stand-in frame context in the
    /// frame data.
    fallback() external payable {
        if (msg.sender != ENTRY_POINT) {
            if (msg.data.length == 0) return;
            revert NotEntryPoint();
        }
        (address v, bytes32 r, bytes32 t, uint256 h, uint256 e) = (verifier, root, treeSeed, height, epoch);
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, r)
            mstore(add(p, 0x20), t)
            mstore(add(p, 0x40), h)
            mstore(add(p, 0x60), e)
            calldatacopy(add(p, 0x80), 0, calldatasize())
            // Asking for more gas than is left forwards all but 1/64 (EIP-150) without the GAS opcode, which the
            // mempool bans in validation.
            let ok := delegatecall(not(0), v, p, add(0x80, calldatasize()), 0, 0)
            returndatacopy(p, 0, returndatasize())
            if iszero(ok) { revert(p, returndatasize()) }
            return(p, returndatasize())
        }
    }

    /// Installs a new tree, built with keygen generation = the new epoch. Callable only by a SENDER frame of this
    /// account, so a hash-signed transaction authorises it.
    function rotate(bytes32 newRoot, bytes32 newTreeSeed, uint8 newHeight) external {
        if (msg.sender != address(this)) revert NotSelf();
        _setTree(newRoot, newTreeSeed, newHeight);
        emit Rotated(++epoch, newRoot);
    }

    function _setTree(bytes32 root_, bytes32 treeSeed_, uint8 height_) private {
        if (height_ == 0 || height_ > MAX_HEIGHT) revert BadTree();
        root = root_;
        treeSeed = treeSeed_;
        height = height_;
    }
}
