// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A contract whose storage a wallet reads from its VERIFY frame, to break the storage rule on demand
/// (see ViolatingWallet). Any call reads slot 0 of this contract and returns it.
///
/// The value is returned on purpose: a read whose result is unused is deleted by the optimizer, and the
/// contract would then violate nothing.
contract Foreign {
    fallback() external {
        assembly {
            mstore(0, sload(0))
            return(0, 32)
        }
    }
}
