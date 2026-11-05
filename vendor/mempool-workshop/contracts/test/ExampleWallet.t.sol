// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ExampleWallet} from "../src/ExampleWallet.sol";
import {HegotaMocks} from "./HegotaMocks.sol";

contract ExampleWalletTest is HegotaMocks {
    event Approved(uint256 scope);

    address owner = address(0xA11CE);
    address stranger = address(0xBAD);

    function test_acceptsOwnerSignature() public {
        ExampleWallet w = new ExampleWallet(owner);
        mockApprove(address(w));
        mockSigner(address(w), owner);
        vm.expectEmit(address(w));
        emit Approved(3); // scope 3 = execution and payment
        (bool ok, ) = address(w).call("");
        assertTrue(ok);
    }

    function test_rejectsOtherSigner() public {
        ExampleWallet w = new ExampleWallet(owner);
        mockApprove(address(w));
        mockSigner(address(w), stranger);
        (bool ok, ) = address(w).call("");
        assertFalse(ok);
    }
}
