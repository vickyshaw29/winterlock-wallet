// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {WOTSPlus} from "hashsigs/WOTSPlus.sol";

/// Oracle check: the pipeline's TypeScript port of the WOTS+ digits (pipeline/src/wots.ts), which the grinder
/// uses to predict verify gas, must agree with Quip's WOTSPlus.sol, the spec's normative format, on every case
/// in pipeline/test/fixtures/wots-digits.json (bun scripts/gen-wots-fixture.ts). Quip's AGPL code is used in
/// tests only, never linked into the build.
/// Written with Claude Code (AI) for Vicky.
contract QuipDigits {
    function digits(WOTSPlus.WinternitzMessage calldata message) external pure returns (uint8[] memory) {
        return WOTSPlus.computeMessageHashChainIndexes(message);
    }
}

contract WotsDigitsOracleTest is Test {
    /// Fields in alphabetical order: Foundry decodes JSON objects into structs that way.
    struct Case {
        uint256[] digits;
        bytes32 msg;
        uint256 steps;
    }

    function test_tsDigitsMatchQuip() public {
        QuipDigits quip = new QuipDigits();
        string memory json = vm.readFile("../pipeline/test/fixtures/wots-digits.json");
        Case[] memory cases = abi.decode(vm.parseJson(json, ".cases"), (Case[]));
        assertGt(cases.length, 60, "fixture too small");
        for (uint256 i = 0; i < cases.length; i++) {
            bytes32 msgHash = cases[i].msg;
            uint256[] memory expected = cases[i].digits;
            uint256 expectedSteps = cases[i].steps;

            uint8[] memory got = quip.digits(WOTSPlus.WinternitzMessage({messageHash: msgHash}));
            assertEq(got.length, 67, "67 chains");
            assertEq(expected.length, 67, "fixture has 67 digits");
            uint256 steps;
            for (uint256 j = 0; j < 67; j++) {
                assertEq(uint256(got[j]), expected[j], string.concat("digit ", vm.toString(j), " of case ", vm.toString(i)));
                steps += 15 - got[j]; // WOTSPlus.verify runs ChainLen - chainIdx - 1 steps per chain
            }
            assertEq(steps, expectedSteps, string.concat("steps of case ", vm.toString(i)));
        }
    }
}
