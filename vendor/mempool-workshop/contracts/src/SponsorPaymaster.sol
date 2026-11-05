// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope} from "@forshtat/hegota-support/contracts/Params.sol";

/// Demo paymaster: pays for anyone while it has ETH. Not for production.
///
/// It deliberately does NOT check its own balance: BALANCE and SELFBALANCE are banned opcodes for an
/// unstaked entity during validation (the node rejects the tx with "payer uses banned opcode: BALANCE").
/// A real paymaster tracks deposits in its own storage, or stakes to unlock the opcode.
///
/// Fund it through the `value` of its creation: a plain transfer would run the fallback below,
/// which calls APPROVE outside a frame and fails.
contract SponsorPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    constructor() payable {}

    /// The VERIFY frame whose target is this paymaster lands here.
    fallback() external payable {
        approve(Scope.PAYMENT);
    }
}
