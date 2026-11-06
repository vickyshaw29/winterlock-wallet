// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Account as PQAccount} from "../src/Account.sol";

/// The test EVM has no frame opcodes, so the account runs `VerifierMock.yul`: `Verifier.yul` with each opcode
/// reading a stand-in frame context that the tests pass as the verify frame's data.
contract AccountTest is Test {
    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;
    uint32 internal constant EPOCH = 1;
    uint256 internal constant APPROVED = 3;

    struct Frame {
        uint256 keyCount;
        uint256 key;
        uint256 seq;
        uint256 sigCount;
        uint256 scheme;
        uint256 length;
        bytes32 sigHash;
        bytes entry;
    }

    string internal vectors;
    PQAccount internal account;

    function setUp() public {
        vectors = vm.readFile("../vectors/h10.json");
        account = new PQAccount(
            _deployYul("out/VerifierMock.yul/VerifierMock.json"),
            vm.parseJsonBytes32(vectors, ".root"),
            vm.parseJsonBytes32(vectors, ".treeSeed"),
            uint8(vm.parseJsonUint(vectors, ".params.height")),
            EPOCH
        );
    }

    function test_vectors() public {
        uint256 i;
        for (; vm.keyExistsJson(vectors, _case(i, "")); ++i) {
            Frame memory f = _frame(i);
            if (vm.parseJsonBool(vectors, _case(i, ".expected"))) {
                _assertApproved(f);
            } else {
                _assertRejected(f, _reason(vm.parseJsonString(vectors, _case(i, ".reason"))));
            }
        }
        assertEq(i, 22);
    }

    function test_rejectsNonceShape() public {
        Frame memory f = _frame(0);
        f.seq = 1;
        _assertRejected(f, 1);
        f = _frame(0);
        f.keyCount = 2;
        _assertRejected(f, 1);
    }

    function test_rejectsOtherEpoch() public {
        Frame memory f = _frame(0);
        f.key = uint256(EPOCH + 1) << 32;
        _assertRejected(f, 2);
        f.key = 0;
        _assertRejected(f, 2);
    }

    function test_rejectsSignatureShape() public {
        Frame memory f = _frame(0);
        f.sigCount = 2;
        _assertRejected(f, 4);
        f = _frame(0);
        f.scheme = 1;
        _assertRejected(f, 5);
    }

    function test_verifyOnlyFromEntryPoint() public {
        (bool ok, bytes memory ret) = address(account).call(_encode(_frame(0)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(PQAccount.NotEntryPoint.selector));
    }

    function test_verifierRefusesDirectCalls() public {
        (bool ok, bytes memory ret) = account.verifier().call(_encode(_frame(0)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(PQAccount.Rejected.selector, 0));
    }

    /// A real verify frame has empty data: it must reach the verifier, which sees no frame context here.
    function test_emptyDataFromEntryPointVerifies() public {
        vm.prank(ENTRY_POINT);
        (bool ok, bytes memory ret) = address(account).staticcall("");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(PQAccount.Rejected.selector, 1));
    }

    function test_rotate() public {
        bytes32 newRoot = keccak256("root");
        vm.expectEmit(address(account));
        emit PQAccount.Rotated(EPOCH + 1, newRoot);
        vm.prank(address(account));
        account.rotate(newRoot, keccak256("seed"), 12);

        assertEq(account.root(), newRoot);
        assertEq(account.treeSeed(), keccak256("seed"));
        assertEq(account.height(), 12);
        assertEq(account.epoch(), EPOCH + 1);
        _assertRejected(_frame(0), 2);
    }

    function test_rotateOnlySelf() public {
        vm.expectRevert(PQAccount.NotSelf.selector);
        account.rotate(bytes32(0), bytes32(0), 10);
    }

    function test_rejectsBadTree() public {
        vm.startPrank(address(account));
        vm.expectRevert(PQAccount.BadTree.selector);
        account.rotate(bytes32(0), bytes32(0), 0);
        vm.expectRevert(PQAccount.BadTree.selector);
        account.rotate(bytes32(0), bytes32(0), 21);
        vm.stopPrank();

        vm.expectRevert(PQAccount.BadTree.selector);
        new PQAccount(address(0), bytes32(0), bytes32(0), 10, 0);
    }

    function test_receivesEth() public {
        (bool ok,) = address(account).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(account).balance, 1 ether);
    }

    function test_mockMatchesVerifier() public {
        string memory mock = vm.readFile("src/Verifier.yul");
        mock = vm.replace(
            mock,
            "// Account's verify frame",
            "// Generated from src/Verifier.yul by test/Account.t.sol: the frame opcodes read a stand-in context that\n"
            "// tests append to the calldata.\n// Account's verify frame"
        );
        mock = vm.replace(mock, 'object "Verifier"', 'object "VerifierMock"');
        mock = vm.replace(mock, 'v := verbatim_1i_1o(hex"b0", p)', "v := calldataload(add(0x80, shl(5, p)))");
        mock = vm.replace(mock, 'v := verbatim_2i_1o(hex"b4", i, p)', "v := calldataload(add(0x2a0, shl(5, p)))");
        mock = vm.replace(mock, 'verbatim_4i_0o(hex"b5", m, o, l, i)', "calldatacopy(m, add(0x320, o), l)");
        mock = vm.replace(mock, 'verbatim_3i_0o(hex"aa", 0, 0, scope)', "mstore(0, scope) return(0, 0x20)");
        if (keccak256(bytes(mock)) != keccak256(bytes(vm.readFile("test/VerifierMock.yul")))) {
            vm.writeFile("test/VerifierMock.yul", mock);
            revert("test/VerifierMock.yul was stale and is rewritten: run forge test again");
        }
    }

    /// Gas of the verify frame for each valid vector, without the protocol's 20,000 for the key's first use.
    function test_gas() public {
        for (uint256 i; i < 16; i += 5) {
            Frame memory f = _frame(i);
            (bool ok,) = _verify(f);
            uint256 used = vm.lastFrameGas().gasTotalUsed;
            assertTrue(ok);
            console2.log(vm.parseJsonString(vectors, _case(i, ".name")), _steps(f.sigHash), used);
        }
    }

    /// vm.getCode cannot read a Yul artifact: its ABI is null.
    function _deployYul(string memory artifact) internal returns (address verifier) {
        bytes memory code = vm.parseJsonBytes(vm.readFile(artifact), ".bytecode.object");
        assembly {
            verifier := create(0, add(code, 0x20), mload(code))
        }
        assertTrue(verifier != address(0));
    }

    function _assertApproved(Frame memory f) internal {
        (bool ok, bytes memory ret) = _verify(f);
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), APPROVED);
    }

    function _assertRejected(Frame memory f, uint256 reason) internal {
        (bool ok, bytes memory ret) = _verify(f);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(PQAccount.Rejected.selector, reason));
    }

    /// A verify frame is a static call from the entry point.
    function _verify(Frame memory f) internal returns (bool ok, bytes memory ret) {
        bytes memory data = _encode(f);
        vm.prank(ENTRY_POINT);
        (ok, ret) = address(account).staticcall(data);
    }

    /// Frame data in the layout `VerifierMock.yul` reads: 17 TXPARAM words, 4 SIGPARAM words, the entry.
    function _encode(Frame memory f) internal pure returns (bytes memory) {
        uint256[17] memory txParams;
        txParams[0x01] = f.seq;
        txParams[0x08] = uint256(f.sigHash);
        txParams[0x0b] = f.sigCount;
        txParams[0x0e] = f.keyCount;
        txParams[0x10] = f.key;
        uint256[4] memory sigParams;
        sigParams[1] = f.scheme;
        sigParams[3] = f.length;
        return abi.encodePacked(txParams, sigParams, f.entry);
    }

    function _frame(uint256 i) internal returns (Frame memory) {
        vm.chainId(vm.parseJsonUint(vectors, _case(i, ".chainId")));
        bytes memory entry = vm.parseJsonBytes(vectors, _case(i, ".entry"));
        return Frame({
            keyCount: 1,
            key: uint256(EPOCH) << 32 | vm.parseJsonUint(vectors, _case(i, ".leaf")),
            seq: 0,
            sigCount: 1,
            scheme: 0,
            length: entry.length,
            sigHash: vm.parseJsonBytes32(vectors, _case(i, ".message")),
            entry: entry
        });
    }

    function _case(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".cases[", vm.toString(i), "]", field);
    }

    function _reason(string memory reason) internal pure returns (uint256) {
        bytes32 r = keccak256(bytes(reason));
        if (r == keccak256("leaf_out_of_range")) return 3;
        if (r == keccak256("bad_entry_length")) return 6;
        if (r == keccak256("bad_version")) return 7;
        if (r == keccak256("bad_slot")) return 8;
        if (r == keccak256("root_mismatch")) return 9;
        revert(reason);
    }

    /// Hash steps the verifier runs for a message: 15 - digit for each of the 67 digits.
    function _steps(bytes32 message) internal pure returns (uint256) {
        uint256 sum;
        for (uint256 i; i < 64; ++i) {
            sum += uint256(message) >> (252 - 4 * i) & 0xf;
        }
        uint256 c = 960 - sum;
        return c + 45 - (c >> 8) - (c >> 4 & 0xf) - (c & 0xf);
    }
}
