// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// The test EVM has no frame opcodes, so a contract that inherits HegotaSupport cannot run `approve` or `sigparam` here.
/// HegotaSupport creates its helpers in its constructor, in a fixed order, so their addresses are known: this puts
/// stand-ins with the same interface at those addresses (`vm.etch`). For ERC8421_WORKSHOP the order is Approve (1st create,
/// nonce 1), TxParam, FrameDataLoad, FrameDataCopy, FrameParam, SigParam (6th, nonce 6), SigDataCopy.
abstract contract HegotaMocks is Test {
    uint256 private constant APPROVE_NONCE = 1;
    uint256 private constant SIGPARAM_NONCE = 6;

    /// `approve(scope)` on `account` emits `Approved(scope)` from `account` (the helper runs by delegatecall).
    function mockApprove(address account) internal {
        vm.etch(vm.computeCreateAddress(account, APPROVE_NONCE), address(new MockApprove()).code);
    }

    /// `approve` on `account` fails, as APPROVE does outside a frame.
    function mockApproveOutsideFrame(address account) internal {
        vm.etch(vm.computeCreateAddress(account, APPROVE_NONCE), address(new MockApproveOutsideFrame()).code);
    }

    /// `sigparam(_, _)` on `account` answers `signer`, whatever it is asked.
    function mockSigner(address account, address signer) internal {
        vm.etch(vm.computeCreateAddress(account, SIGPARAM_NONCE), address(new MockSigParam(signer)).code);
    }
}

contract MockApprove {
    event Approved(uint256 scope);

    fallback() external payable {
        emit Approved(abi.decode(msg.data, (uint256)));
    }
}

contract MockApproveOutsideFrame {
    fallback() external payable {
        revert("not in a frame");
    }
}

contract MockSigParam {
    address internal immutable SIGNER;

    constructor(address signer_) {
        SIGNER = signer_;
    }

    fallback() external payable {
        bytes memory out = abi.encode(SIGNER);
        assembly {
            return(add(out, 32), 32)
        }
    }
}

/// Stand-in for Foreign: tests observe calls to it with vm.expectCall.
contract MockForeign {
    fallback() external payable {}
}
