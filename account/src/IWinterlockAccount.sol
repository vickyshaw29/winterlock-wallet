// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// ABI of the Yul account in yul/Account.yul (spec, Shared interfaces 4). Written with Claude Code (AI) for Vicky.
interface IWinterlockAccount {
    /// Factory only, in the call that creates the proxy. Epoch starts at 0, hybrid off.
    function initialize(
        bytes32 root,
        bytes32 treeSeed,
        uint8 height,
        address owner,
        uint32 hotStart,
        uint256 hotValueCap,
        uint256 hotFeeCap,
        address allowedTarget
    ) external;

    // Admin: only a SENDER frame of the account itself (msg.sender == address(this)).
    function rotate(bytes32 newRoot, bytes32 newTreeSeed, uint8 newHeight) external;
    function setHybrid(bool on) external;
    function setHotPolicy(uint32 hotStart, uint256 valueCap, uint256 feeCap, address allowedTarget) external;
    function setOwner(address owner) external;

    // Views
    function root() external view returns (bytes32);
    function treeSeed() external view returns (bytes32);
    function height() external view returns (uint8);
    function epoch() external view returns (uint32);
    function hotStart() external view returns (uint32);
    function hotValueCap() external view returns (uint256);
    function hotFeeCap() external view returns (uint256);
    function allowedTarget() external view returns (address);
    function owner() external view returns (address);
    function hybridRequired() external view returns (bool);
}
