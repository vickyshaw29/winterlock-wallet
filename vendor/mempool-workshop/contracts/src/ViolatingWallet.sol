// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// A wallet that breaks a mempool rule on demand, to show the difference between mempools.
///
/// Same owner check as ExampleWallet. In addition, when the VERIFY frame carries non-empty `data`, the wallet
/// reads a storage slot of a contract it does not own (`FOREIGN`, see Foreign.sol: SLOAD slot 0).
/// That is a storage-rule violation:
///   - the canonical mempool (EIP-8141) rejects it: ethrex says `StorageReadNonSender`;
///   - the standard alt-mempool rejects it for an unstaked entity ("unstaked payer accessed … slot …")
///     and admits it once the wallet is staked.
/// Empty `data` is the clean path, used for the staking tx itself (a wallet must be admissible to stake).
contract ViolatingWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable owner;
    address internal immutable FOREIGN;

    constructor(address owner_, address foreign_) payable {
        owner = owner_;
        FOREIGN = foreign_;
    }

    fallback() external payable {
        require(address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) == owner, "bad signer");
        if (msg.data.length > 0) {
            (bool read, ) = FOREIGN.staticcall(""); // the violation
            read;
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }
}
