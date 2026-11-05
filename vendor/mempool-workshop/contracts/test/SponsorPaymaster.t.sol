// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SponsorPaymaster} from "../src/SponsorPaymaster.sol";
import {HegotaMocks} from "./HegotaMocks.sol";

contract SponsorPaymasterTest is HegotaMocks {
    event Approved(uint256 scope);

    function test_approvesPaymentScope() public {
        SponsorPaymaster pm = new SponsorPaymaster{value: 0.01 ether}();
        mockApprove(address(pm));
        vm.expectEmit(address(pm));
        emit Approved(1); // scope 1 = PAYMENT
        (bool ok, ) = address(pm).call("");
        assertTrue(ok);
    }

    // BALANCE/SELFBALANCE are banned for an unstaked entity, so the validation code must not check its own balance.
    function test_approvesWithoutAnyBalanceCheck() public {
        SponsorPaymaster pm = new SponsorPaymaster();
        mockApprove(address(pm));
        (bool ok, ) = address(pm).call("");
        assertTrue(ok);
    }

    function test_revertsWhenApprovalFails() public {
        SponsorPaymaster pm = new SponsorPaymaster();
        mockApproveOutsideFrame(address(pm));
        (bool ok, ) = address(pm).call("");
        assertFalse(ok);
    }
}
