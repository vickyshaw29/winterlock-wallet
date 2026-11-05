// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// Minimal single-owner smart contract wallet for EIP-8141.
///
/// It contains no ECDSA code. The tx carries a SECP256K1 signature entry whose `signer` is the owner;
/// the protocol verifies that signature before any frame runs. The wallet's VERIFY frame only has to
/// confirm that the signer the protocol verified is its owner (`sigparam`), then approve execution and payment.
///
/// Fund it through the `value` of its creation: a plain transfer would run the fallback below,
/// which needs a frame context and fails.
contract ExampleWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable owner;

    constructor(address owner_) payable {
        owner = owner_;
    }

    /// The VERIFY frame whose target is this wallet lands here.
    fallback() external payable {
        require(address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) == owner, "bad signer");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }
}
