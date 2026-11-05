// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ExampleWallet, written for the EIP-8141 solc fork instead of @forshtat/hegota-support.
//
// https://github.com/chiranjeev13/solidity (release v0.8.38-eip8141.0) teaches inline assembly the EIP-8141
// opcodes as Yul builtins: `approve`, `txparam`, `framedataload`, `framedatacopy`, `frameparam`, `sigparam`,
// `sigdatacopy`. They are enabled by the EVM version `cancun+eip8141`; vanilla solc rejects this file.
// The builtins take their operands top of the stack first, the order of the EIP's stack tables.
//
// There is no base contract and no helper contract to deploy: the opcode runs in this contract's own code. That is
// why this wallet's nonce starts at 1, where the HegotaSupport-based ExampleWallet starts at 8 (it creates 7 helpers).
//
// This file lives outside contracts/src on purpose: `forge build` (vanilla solc) must not see it.
// Build it with `yarn compile:fork <path to the fork's solc>`.
contract ForkSolcWallet {
    // The ids and scope below are the numbers of the EIP-8141 tables (the names in @forshtat/hegota-support's Params.sol).
    uint256 private constant SIGPARAM_RESOLVED_SIGNER = 0;
    uint256 private constant TXPARAM_FRAME_COUNT = 9;
    uint256 private constant SCOPE_EXECUTION_AND_PAYMENT = 3;

    address public immutable owner;

    constructor(address owner_) payable {
        owner = owner_;
    }

    /// The VERIFY frame whose target is this wallet lands here.
    fallback() external payable {
        uint256 signer;
        assembly ("memory-safe") {
            signer := sigparam(0, SIGPARAM_RESOLVED_SIGNER)
        }
        require(address(uint160(signer)) == owner, "bad signer");
        assembly ("memory-safe") {
            // approve(offset, length, scope): offset and length are the (empty) return data that ends the frame.
            approve(0, 0, SCOPE_EXECUTION_AND_PAYMENT)
        }
    }

    /// The number of frames in the transaction that is running. Only callable inside a frame transaction.
    function frameCount() external view returns (uint256 count) {
        assembly ("memory-safe") {
            count := txparam(TXPARAM_FRAME_COUNT)
        }
    }
}
