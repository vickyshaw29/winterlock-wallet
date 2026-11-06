// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test, console} from "forge-std/Test.sol";
import {WOTSPlus} from "hashsigs/WOTSPlus.sol";

/// The spec's oracle check ("Oracle check that proves the format"), on vectors/h10.ts.json from the TypeScript signer:
///  1. our Yul verifier (build/HashSigVerifier.bin: the same hashsig_verify the account runs) gives every case's
///     expected answer;
///  2. Quip's WOTSPlus.verify, the normative WOTS+ format, accepts every valid signature with our public seed and
///     public key hash, and refuses the flipped-byte and wrong-message mutations.
/// Quip's AGPL code is used in tests only. Written with Claude Code (AI) for Vicky.
contract QuipWots {
    function verify(
        WOTSPlus.WinternitzAddress calldata publicKey,
        WOTSPlus.WinternitzMessage calldata message,
        WOTSPlus.WinternitzElements calldata signature
    ) external pure returns (bool) {
        return WOTSPlus.verify(publicKey, message, signature);
    }
}

interface IHashSigVerifier {
    function verify(bytes32 root, bytes32 treeSeed, uint8 height, uint256 chainId, uint32 leaf, bytes32 msgHash, bytes calldata entry)
        external
        view
        returns (bool);
}

contract HashSigVectorsTest is Test {
    /// Fields in alphabetical order: Foundry decodes JSON objects into structs that way.
    struct Case {
        bytes32[] authPath;
        uint256 chainId;
        bytes entry;
        bool expected;
        uint256 leaf;
        bytes32 message;
        string name;
        bytes32 publicKeyHash;
        bytes32 publicSeed;
        bytes signature;
        uint256 slot;
        uint256 steps;
    }

    IHashSigVerifier verifier;
    QuipWots quip;
    bytes32 root;
    bytes32 treeSeed;

    function setUp() public {
        bytes memory code = vm.parseBytes(string.concat("0x", vm.readFile("build/HashSigVerifier.bin")));
        address v;
        assembly ("memory-safe") {
            v := create(0, add(code, 0x20), mload(code))
        }
        require(v != address(0), "verifier deploy failed");
        verifier = IHashSigVerifier(v);
        quip = new QuipWots();
        string memory json = _json(); // read per test: a 2.9 MB string in storage would cost more gas than a block has
        root = abi.decode(vm.parseJson(json, ".root"), (bytes32));
        treeSeed = abi.decode(vm.parseJson(json, ".treeSeed"), (bytes32));
    }

    function _json() internal view returns (string memory) {
        return vm.readFile("../vectors/h10.ts.json");
    }

    function _cases() internal view returns (Case[] memory) {
        return abi.decode(vm.parseJson(_json(), ".cases"), (Case[]));
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (b.length > a.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }

    function _elements(bytes memory sig) internal pure returns (WOTSPlus.WinternitzElements memory e) {
        require(sig.length == 2144, "signature length");
        for (uint256 j = 0; j < 67; j++) {
            bytes32 w;
            assembly ("memory-safe") {
                w := mload(add(add(sig, 0x20), mul(j, 0x20)))
            }
            e.elements[j] = w;
        }
    }

    /// 1. Our Yul verifier on every case.
    function test_yulVerifierGivesEveryExpectedAnswer() public view {
        Case[] memory cases = _cases();
        assertEq(cases.length, 270, "case count");
        uint256 valid;
        for (uint256 i = 0; i < cases.length; i++) {
            Case memory c = cases[i];
            bool ok = verifier.verify(root, treeSeed, 10, c.chainId, uint32(c.leaf), c.message, c.entry);
            assertEq(ok, c.expected, c.name);
            if (c.expected) valid++;
        }
        assertEq(valid, 30, "valid cases");
    }

    /// 2. Quip's WOTSPlus on the WOTS+ layer of every case that touches it.
    function test_quipOracleAgreesOnTheWotsLayer() public view {
        Case[] memory cases = _cases();
        uint256 checked;
        for (uint256 i = 0; i < cases.length; i++) {
            Case memory c = cases[i];
            bool isValid = _endsWith(c.name, "-valid");
            bool isFlip = _endsWith(c.name, "-flipped-signature-byte");
            bool isWrongMsg = _endsWith(c.name, "-wrong-message");
            if (!isValid && !isFlip && !isWrongMsg) continue; // path, slot, leaf, chain, version: above the WOTS layer
            bytes memory sig = new bytes(2144);
            for (uint256 b = 0; b < 2144; b++) sig[b] = c.entry[2 + b]; // the signature inside the (maybe mutated) entry
            bool ok = quip.verify(
                WOTSPlus.WinternitzAddress({publicSeed: c.publicSeed, publicKeyHash: c.publicKeyHash}),
                WOTSPlus.WinternitzMessage({messageHash: c.message}),
                _elements(sig)
            );
            assertEq(ok, isValid, string.concat("Quip: ", c.name));
            if (isValid) assertEq(keccak256(sig), keccak256(c.signature), string.concat("entry carries the signature: ", c.name));
            checked++;
        }
        assertEq(checked, 90, "valid + flipped + wrong-message cases");
    }

    /// 3. Gas of hashsig_verify against the message's chain steps (best 45, worst 990).
    function test_gasPerChainStep() public view {
        Case[] memory cases = _cases();
        uint256 bestGas;
        uint256 worstGas;
        uint256 sumGas;
        uint256 sumSteps;
        uint256 n;
        for (uint256 i = 0; i < cases.length; i++) {
            Case memory c = cases[i];
            if (!c.expected) continue;
            uint256 g = gasleft();
            assertTrue(verifier.verify(root, treeSeed, 10, c.chainId, uint32(c.leaf), c.message, c.entry));
            uint256 used = g - gasleft();
            if (c.steps == 45) bestGas = used;
            if (c.steps == 990) worstGas = used;
            sumGas += used;
            sumSteps += c.steps;
            n++;
        }
        assertGt(bestGas, 0, "best-case vector present");
        assertGt(worstGas, 0, "worst-case vector present");
        uint256 perStep = (worstGas - bestGas) / (990 - 45);
        console.log("verifier call gas: best (45 steps)", bestGas);
        console.log("verifier call gas: worst (990 steps)", worstGas);
        console.log("gas per chain step", perStep);
        console.log("fixed part (call included)", bestGas - perStep * 45);
        console.log("average over valid vectors", sumGas / n, "at average steps", sumSteps / n);
    }
}

/// hashsig_verify's own cost in Foundry's EVM (measure() reads gas() around the call, so no harness overhead).
/// Compare with pipeline/scripts/measure-verifier.ts, which reads the same on the devnet.
contract HashSigMeasureTest is Test {
    function test_internalGasBestAndWorst() public {
        bytes memory code = vm.parseBytes(string.concat("0x", vm.readFile("build/HashSigVerifier.bin")));
        address v;
        assembly ("memory-safe") {
            v := create(0, add(code, 0x20), mload(code))
        }
        string memory json = vm.readFile("../vectors/h10.ts.json");
        bytes32 root = abi.decode(vm.parseJson(json, ".root"), (bytes32));
        bytes32 treeSeed = abi.decode(vm.parseJson(json, ".treeSeed"), (bytes32));
        // cases[40] = worstMessage-valid (index 4 x 9 cases per tag), cases[45] = bestMessage-valid
        for (uint256 i = 36; i <= 45; i += 9) {
            string memory at = string.concat(".cases[", vm.toString(i), "]");
            string memory name = abi.decode(vm.parseJson(json, string.concat(at, ".name")), (string));
            bytes memory entry = abi.decode(vm.parseJson(json, string.concat(at, ".entry")), (bytes));
            bytes32 message = abi.decode(vm.parseJson(json, string.concat(at, ".message")), (bytes32));
            uint256 leaf = abi.decode(vm.parseJson(json, string.concat(at, ".leaf")), (uint256));
            (bool ok, bytes memory out) = v.call(
                abi.encodeWithSelector(0x8e0afc61, root, treeSeed, uint8(10), uint256(1337), uint32(leaf), message, entry)
            );
            (bool valid, uint256 used) = abi.decode(out, (bool, uint256));
            assertTrue(ok && valid, name);
            console.log(name, used);
        }
    }
}
