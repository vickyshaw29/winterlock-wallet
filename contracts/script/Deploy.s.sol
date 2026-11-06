// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {Account as PQAccount} from "../src/Account.sol";

/// Deploys an Account for a tree from `signer keygen --generation <EPOCH>`: ROOT, TREE_SEED, HEIGHT and EPOCH come
/// from its output. Deploys the shared Verifier too, unless VERIFIER names one.
contract Deploy is Script {
    function run() external returns (address verifier, PQAccount account) {
        verifier = vm.envOr("VERIFIER", address(0));
        vm.startBroadcast();
        if (verifier == address(0)) {
            bytes memory code = vm.parseJsonBytes(vm.readFile("out/Verifier.yul/Verifier.json"), ".bytecode.object");
            assembly {
                verifier := create(0, add(code, 0x20), mload(code))
            }
            require(verifier != address(0), "verifier deploy failed");
        }
        account = new PQAccount(
            verifier,
            vm.envBytes32("ROOT"),
            vm.envBytes32("TREE_SEED"),
            uint8(vm.envUint("HEIGHT")),
            uint32(vm.envUint("EPOCH"))
        );
        vm.stopBroadcast();
    }
}
