// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Factory} from "../src/Factory.sol";
import {IWinterlockAccount} from "../src/IWinterlockAccount.sol";

/// Everything that runs without EIP-8141 opcodes: factory, initialize, views, admin access, argument checks,
/// ETH receipt. The verify path is tested on the devnet by simulation, since this EVM has no TXPARAM.
/// Written with Claude Code (AI) for Vicky. Needs scripts/build.sh first (reads build/Account.bin).
contract AccountTest is Test {
    Factory factory;
    address implementation;

    bytes32 constant ROOT = keccak256("root");
    bytes32 constant SEED = keccak256("tree seed");
    uint8 constant HEIGHT = 10;
    address constant OWNER = address(0x0B0B);
    uint32 constant HOT_START = 1008;
    uint256 constant VALUE_CAP = 0.1 ether;
    uint256 constant FEE_CAP = 0.01 ether;
    address constant TARGET = address(0xBEEF);
    bytes32 constant SALT = bytes32(uint256(1));

    function setUp() public {
        bytes memory code = vm.parseBytes(string.concat("0x", vm.readFile("build/Account.bin")));
        address impl;
        assembly ("memory-safe") {
            impl := create(0, add(code, 0x20), mload(code))
        }
        require(impl != address(0), "implementation deploy failed");
        implementation = impl;
        factory = new Factory(impl);
    }

    function _create() internal returns (IWinterlockAccount) {
        return IWinterlockAccount(factory.createAccount(ROOT, SEED, HEIGHT, OWNER, HOT_START, VALUE_CAP, FEE_CAP, TARGET, SALT));
    }

    function _reason(string memory r) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(bytes(r)));
    }

    // ------------------------------------------------------------------ factory
    function test_createLandsAtPredictedAddressAsMinimalProxy() public {
        address predicted = factory.predictAddress(ROOT, SEED, HEIGHT, OWNER, HOT_START, VALUE_CAP, FEE_CAP, TARGET, SALT);
        IWinterlockAccount account = _create();
        assertEq(address(account), predicted);
        assertEq(address(account).code.length, 45, "EIP-1167 runtime is 45 bytes");
        assertEq(
            address(account).code,
            abi.encodePacked(hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3")
        );
    }

    function test_createIsIdempotent() public {
        address first = address(_create());
        address second = address(_create());
        assertEq(first, second);
    }

    function test_addressCommitsToEveryArgument() public view {
        address base = factory.predictAddress(ROOT, SEED, HEIGHT, OWNER, HOT_START, VALUE_CAP, FEE_CAP, TARGET, SALT);
        assertTrue(base != factory.predictAddress(bytes32(uint256(ROOT) + 1), SEED, HEIGHT, OWNER, HOT_START, VALUE_CAP, FEE_CAP, TARGET, SALT));
        assertTrue(base != factory.predictAddress(ROOT, SEED, HEIGHT, address(0xBAD), HOT_START, VALUE_CAP, FEE_CAP, TARGET, SALT));
        assertTrue(base != factory.predictAddress(ROOT, SEED, HEIGHT, OWNER, HOT_START, VALUE_CAP + 1, FEE_CAP, TARGET, SALT));
        assertTrue(base != factory.predictAddress(ROOT, SEED, HEIGHT, OWNER, HOT_START, VALUE_CAP, FEE_CAP, TARGET, bytes32(uint256(2))));
    }

    // ------------------------------------------------------------------ initialize and views
    function test_initializeStoresEveryField() public {
        IWinterlockAccount a = _create();
        assertEq(a.root(), ROOT);
        assertEq(a.treeSeed(), SEED);
        assertEq(a.height(), HEIGHT);
        assertEq(a.epoch(), 0);
        assertEq(a.hotStart(), HOT_START);
        assertEq(a.hotValueCap(), VALUE_CAP);
        assertEq(a.hotFeeCap(), FEE_CAP);
        assertEq(a.allowedTarget(), TARGET);
        assertEq(a.owner(), OWNER);
        assertFalse(a.hybridRequired());
    }

    function test_initializeOnlyOnce() public {
        IWinterlockAccount a = _create();
        vm.expectRevert(_reason("already initialized"));
        a.initialize(keccak256("attacker"), SEED, HEIGHT, address(this), 0, 0, 0, address(0));
    }

    function test_initializeRejectsZeroRootAndBadHeight() public {
        IWinterlockAccount bare = IWinterlockAccount(_freshProxy());
        vm.expectRevert(_reason("bad argument"));
        bare.initialize(bytes32(0), SEED, HEIGHT, OWNER, 0, 0, 0, address(0));
        vm.expectRevert(_reason("bad height"));
        bare.initialize(ROOT, SEED, 0, OWNER, 0, 0, 0, address(0));
        vm.expectRevert(_reason("bad height"));
        bare.initialize(ROOT, SEED, 29, OWNER, 0, 0, 0, address(0)); // (slot << 29) | leaf would overflow the uint32 index
        bare.initialize(ROOT, SEED, 28, OWNER, HOT_START, 0, 0, address(0)); // the tallest tree the index allows
        assertEq(IWinterlockAccount(address(bare)).height(), 28);
    }

    function test_initializeRejectsDirtyAddressBits() public {
        address bare = _freshProxy();
        bytes memory data = abi.encodeCall(IWinterlockAccount.initialize, (ROOT, SEED, HEIGHT, OWNER, 0, 0, 0, address(0)));
        assembly ("memory-safe") {
            mstore(add(data, add(0x20, 100)), or(mload(add(data, add(0x20, 100))), shl(160, 1))) // owner word, bit 160 set
        }
        (bool ok, bytes memory ret) = bare.call(data);
        assertFalse(ok);
        assertEq(ret, _reason("bad argument"));
    }

    // ------------------------------------------------------------------ admin: only the account itself
    function test_adminRefusesAnyoneButTheAccount() public {
        IWinterlockAccount a = _create();
        vm.expectRevert(_reason("no such function"));
        a.setOwner(address(this));
        vm.expectRevert(_reason("no such function"));
        a.setHybrid(true);
        vm.expectRevert(_reason("no such function"));
        a.setHotPolicy(0, 1 ether, 1 ether, address(this));
        vm.expectRevert(_reason("no such function"));
        a.rotate(keccak256("new root"), SEED, 12);
    }

    function test_setHybridAndOwnerFromTheAccount() public {
        IWinterlockAccount a = _create();
        vm.startPrank(address(a));
        a.setHybrid(true);
        a.setOwner(address(0xCAFE));
        vm.stopPrank();
        assertTrue(a.hybridRequired());
        assertEq(a.owner(), address(0xCAFE));
        assertEq(a.height(), HEIGHT, "other config fields untouched");
        assertEq(a.hotStart(), HOT_START);
        vm.prank(address(a));
        a.setHybrid(false);
        assertFalse(a.hybridRequired());
        assertEq(a.owner(), address(0xCAFE));
    }

    function test_setHotPolicyFromTheAccount() public {
        IWinterlockAccount a = _create();
        vm.prank(address(a));
        a.setHotPolicy(1000, 0, 5, address(0xD00D));
        assertEq(a.hotStart(), 1000);
        assertEq(a.hotValueCap(), 0, "zero cap: the kill switch");
        assertEq(a.hotFeeCap(), 5);
        assertEq(a.allowedTarget(), address(0xD00D));
        assertEq(a.owner(), OWNER, "owner untouched");
    }

    function test_rotateBumpsEpochAndKeepsTheRest() public {
        IWinterlockAccount a = _create();
        vm.startPrank(address(a));
        a.setHybrid(true);
        a.rotate(keccak256("root 2"), keccak256("seed 2"), 12);
        vm.stopPrank();
        assertEq(a.root(), keccak256("root 2"));
        assertEq(a.treeSeed(), keccak256("seed 2"));
        assertEq(a.height(), 12);
        assertEq(a.epoch(), 1);
        assertEq(a.owner(), OWNER);
        assertTrue(a.hybridRequired());
        assertEq(a.hotStart(), HOT_START);
        vm.prank(address(a));
        a.rotate(keccak256("root 3"), keccak256("seed 3"), 10);
        assertEq(a.epoch(), 2);
    }

    function test_rotateRejectsZeroRootAndBadHeight() public {
        IWinterlockAccount a = _create();
        vm.startPrank(address(a));
        vm.expectRevert(_reason("bad argument"));
        a.rotate(bytes32(0), SEED, 10);
        vm.expectRevert(_reason("bad height"));
        a.rotate(ROOT, SEED, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ review fixes (approved by Vicky, Nov 6)
    /// A: raising hotStart would turn tickets already exported to a phone into cold leaves, which have no caps.
    function test_hotBandCannotShrinkWithinAnEpoch() public {
        IWinterlockAccount a = _create();
        vm.startPrank(address(a));
        vm.expectRevert(_reason("hot: band cannot shrink"));
        a.setHotPolicy(HOT_START + 8, VALUE_CAP, FEE_CAP, TARGET);
        a.setHotPolicy(HOT_START, 0, FEE_CAP, TARGET); // same hotStart: fine (here, the kill switch)
        a.setHotPolicy(1000, VALUE_CAP, FEE_CAP, TARGET); // lower: fine, more leaves become hot
        vm.expectRevert(_reason("hot: band cannot shrink"));
        a.setHotPolicy(1001, VALUE_CAP, FEE_CAP, TARGET); // and it cannot go back up
        vm.stopPrank();
        assertEq(a.hotStart(), 1000);
    }

    /// D: with every leaf hot no admin call could ever run again, and with the kill switch on, nothing at all.
    function test_hotStartMustLeaveAColdLeaf() public {
        IWinterlockAccount bare = IWinterlockAccount(_freshProxy());
        vm.expectRevert(_reason("hot: no cold leaf left"));
        bare.initialize(ROOT, SEED, HEIGHT, OWNER, 0, 0, 0, address(0));
        vm.expectRevert(_reason("hot: no cold leaf left"));
        bare.initialize(ROOT, SEED, HEIGHT, OWNER, 1, 0, 0, address(0)); // epoch 0: leaf 0 cannot sign
        bare.initialize(ROOT, SEED, HEIGHT, OWNER, 2, 0, 0, address(0)); // leaf 1 stays cold
        assertEq(bare.hotStart(), 2);

        IWinterlockAccount a = _create();
        vm.startPrank(address(a));
        vm.expectRevert(_reason("hot: no cold leaf left"));
        a.setHotPolicy(0, 0, 0, address(0));
        vm.expectRevert(_reason("hot: no cold leaf left"));
        a.setHotPolicy(1, 0, 0, address(0));
        a.rotate(keccak256("root 2"), keccak256("seed 2"), HEIGHT);
        a.setHotPolicy(1, 0, 0, address(0)); // epoch 1: leaf 0 has key 1 << 32, so it can sign
        vm.stopPrank();
        assertEq(a.hotStart(), 1);
    }

    /// C: re-installing the current tree under the next epoch would reopen every leaf it has used.
    function test_rotateRefusesTheInstalledTree() public {
        IWinterlockAccount a = _create();
        vm.startPrank(address(a));
        vm.expectRevert(_reason("rotate: same tree"));
        a.rotate(ROOT, keccak256("new seed"), HEIGHT);
        vm.expectRevert(_reason("rotate: same tree"));
        a.rotate(keccak256("new root"), SEED, HEIGHT);
        a.rotate(keccak256("new root"), keccak256("new seed"), HEIGHT);
        vm.stopPrank();
        assertEq(a.epoch(), 1);
    }

    /// E: hybrid with no owner key would make every cold transaction unapprovable.
    function test_hybridAlwaysHasAnOwner() public {
        IWinterlockAccount noOwner =
            IWinterlockAccount(factory.createAccount(ROOT, SEED, HEIGHT, address(0), HOT_START, VALUE_CAP, FEE_CAP, TARGET, bytes32(uint256(9))));
        vm.prank(address(noOwner));
        vm.expectRevert(_reason("hybrid: no owner"));
        noOwner.setHybrid(true);

        IWinterlockAccount a = _create();
        vm.startPrank(address(a));
        a.setHybrid(true);
        vm.expectRevert(_reason("hybrid: owner needed"));
        a.setOwner(address(0));
        a.setHybrid(false);
        a.setOwner(address(0)); // fine once hybrid is off
        vm.stopPrank();
        assertEq(a.owner(), address(0));
    }

    function test_shortCalldataIsRefused() public {
        IWinterlockAccount a = _create();
        vm.prank(address(a));
        (bool ok, bytes memory ret) = address(a).call(abi.encodePacked(IWinterlockAccount.setOwner.selector));
        assertFalse(ok);
        assertEq(ret, _reason("short calldata"));
    }

    // ------------------------------------------------------------------ ETH and the verify path
    function test_receivesEth() public {
        IWinterlockAccount a = _create();
        (bool ok,) = address(a).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(a).balance, 1 ether);
    }

    function test_verifyPathHaltsOutsideAFrameTransaction() public {
        IWinterlockAccount a = _create();
        vm.prank(address(0xaa)); // the ENTRY_POINT sentinel: TXPARAM does not exist outside a frame transaction
        (bool ok,) = address(a).call("");
        assertFalse(ok);
    }

    function test_unknownFunctionIsRefused() public {
        IWinterlockAccount a = _create();
        (bool ok, bytes memory ret) = address(a).call(abi.encodeWithSignature("execute(address,uint256)", address(1), 1));
        assertFalse(ok);
        assertEq(ret, _reason("no such function"));
    }

    /// A proxy to the implementation that the factory has not initialized (for argument tests).
    function _freshProxy() internal returns (address proxy) {
        bytes memory code = abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3");
        assembly ("memory-safe") {
            proxy := create(0, add(code, 0x20), mload(code))
        }
    }
}
