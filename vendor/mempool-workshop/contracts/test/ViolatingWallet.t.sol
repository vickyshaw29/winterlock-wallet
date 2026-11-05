// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ViolatingWallet} from "../src/ViolatingWallet.sol";
import {HegotaMocks, MockForeign} from "./HegotaMocks.sol";

contract ViolatingWalletTest is HegotaMocks {
    address owner = address(0xA11CE);
    ViolatingWallet w;
    address foreign;

    function setUp() public {
        foreign = address(new MockForeign());
        w = new ViolatingWallet(owner, foreign);
        mockApprove(address(w));
        mockSigner(address(w), owner);
    }

    function test_cleanFrameDataDoesNotReadForeignStorage() public {
        vm.expectCall(foreign, "", 0); // exactly zero calls
        (bool ok, ) = address(w).call("");
        assertTrue(ok);
    }

    function test_nonEmptyFrameDataReadsForeignStorage() public {
        vm.expectCall(foreign, "", 1);
        (bool ok, ) = address(w).call(hex"01");
        assertTrue(ok);
    }

    function test_rejectsOtherSignerEvenOnTheCleanPath() public {
        ViolatingWallet other = new ViolatingWallet(owner, foreign);
        mockApprove(address(other));
        mockSigner(address(other), address(0xBAD));
        (bool ok, ) = address(other).call("");
        assertFalse(ok);
    }
}
