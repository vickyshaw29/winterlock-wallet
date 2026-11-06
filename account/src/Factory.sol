// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IWinterlockAccount} from "./IWinterlockAccount.sol";

/// Deploys Winterlock accounts as EIP-1167 minimal proxies with CREATE2 (spec, "Factory").
/// Written with Claude Code (AI) for Vicky.
///
/// The CREATE2 salt hashes every argument, so an address commits to its root, owner and policy: nobody can
/// deploy a different account at an address someone has already funded.
contract Factory {
    /// The Yul account every proxy delegates to.
    address public immutable implementation;

    event AccountCreated(address indexed account, bytes32 root, address owner);

    constructor(address implementation_) {
        require(implementation_.code.length > 0, "no implementation code");
        implementation = implementation_;
    }

    /// Called from the deploy frame (or by an EOA). Returns the existing account unchanged if it already exists.
    function createAccount(
        bytes32 root,
        bytes32 treeSeed,
        uint8 height,
        address owner,
        uint32 hotStart,
        uint256 hotValueCap,
        uint256 hotFeeCap,
        address allowedTarget,
        bytes32 salt
    ) external returns (address account) {
        bytes32 s = _salt(root, treeSeed, height, owner, hotStart, hotValueCap, hotFeeCap, allowedTarget, salt);
        account = _predict(s);
        if (account.code.length > 0) return account;

        bytes memory code = _proxyInitCode();
        address created;
        assembly ("memory-safe") {
            created := create2(0, add(code, 0x20), mload(code), s)
        }
        require(created == account, "create2 failed");
        emit AccountCreated(account, root, owner);
        IWinterlockAccount(account).initialize(root, treeSeed, height, owner, hotStart, hotValueCap, hotFeeCap, allowedTarget);
    }

    /// The counterfactual address, so the account can be funded before it exists.
    function predictAddress(
        bytes32 root,
        bytes32 treeSeed,
        uint8 height,
        address owner,
        uint32 hotStart,
        uint256 hotValueCap,
        uint256 hotFeeCap,
        address allowedTarget,
        bytes32 salt
    ) external view returns (address) {
        return _predict(_salt(root, treeSeed, height, owner, hotStart, hotValueCap, hotFeeCap, allowedTarget, salt));
    }

    function _salt(
        bytes32 root,
        bytes32 treeSeed,
        uint8 height,
        address owner,
        uint32 hotStart,
        uint256 hotValueCap,
        uint256 hotFeeCap,
        address allowedTarget,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(root, treeSeed, height, owner, hotStart, hotValueCap, hotFeeCap, allowedTarget, salt));
    }

    /// EIP-1167: 10 bytes of init code, then the 45-byte runtime that DELEGATECALLs everything to `implementation`.
    function _proxyInitCode() internal view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }

    function _predict(bytes32 s) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), s, keccak256(_proxyInitCode()))))));
    }
}
