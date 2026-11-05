// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Foreign} from "../src/Foreign.sol";

contract ForeignTest is Test {
    // Guards against the optimizer removing the read: the whole point of Foreign is that it touches its own storage.
    function test_readsItsOwnStorageSlotZero() public {
        Foreign f = new Foreign();
        vm.store(address(f), bytes32(0), bytes32(uint256(0xC0FFEE)));
        (bool ok, bytes memory out) = address(f).call("");
        assertTrue(ok);
        assertEq(abi.decode(out, (uint256)), 0xC0FFEE);
    }
}
