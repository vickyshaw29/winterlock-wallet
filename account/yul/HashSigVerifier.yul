/// Standalone verifier for tests and pre-flight checks (plan, interface 2): the same hashsig_verify the account
/// runs, spliced in by scripts/build.sh from the same file, behind a plain ABI.
/// Written with Claude Code (AI) for Vicky.
///   verify(bytes32 root, bytes32 treeSeed, uint8 height, uint256 chainId, uint32 leaf, bytes32 msgHash, bytes entry)
///     returns (bool)                     selector 0xbb261e13
///   measure(same arguments) returns (bool ok, uint256 gasUsed)
///     gasUsed is what hashsig_verify itself costs, read with gas() around the call: on a node, an eth_call of
///     this gives that node's own gas schedule. Selector 0x8e0afc61.
object "HashSigVerifier" {
  code {
    datacopy(0, dataoffset("runtime"), datasize("runtime"))
    return(0, datasize("runtime"))
  }
  object "runtime" {
    code {
      let selector := shr(224, calldataload(0))
      if iszero(or(eq(selector, 0xbb261e13), eq(selector, 0x8e0afc61))) { revert(0, 0) }
      let off := add(4, calldataload(196))                                   // the bytes argument
      let len := calldataload(off)
      if gt(len, 0x2000) { revert(0, 0) }                                    // far above any valid entry
      // (names here must differ from hashsig_verify's parameters: Yul forbids shadowing)
      calldatacopy(0x200, add(off, 32), len)                                 // where the account puts the entry too
      let before := gas()
      let valid := hashsig_verify(0x200, len, calldataload(164), calldataload(4), calldataload(36), calldataload(68), calldataload(132), calldataload(100))
      let spent := sub(before, gas())
      mstore(0x00, valid)
      mstore(0x20, spent)
      switch selector
      case 0xbb261e13 { return(0x00, 0x20) }
      default { return(0x00, 0x40) }

      // @include-hashsig-verify
    }
  }
}
