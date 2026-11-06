/// Winterlock account: a post-quantum smart account for EIP-8141 frame transactions (spec, "Account contract").
/// Written with Claude Code (AI) for Vicky.
///
/// One implementation behind EIP-1167 proxies; storage lives in each proxy. No execute function: SENDER
/// frames call their targets directly with the account as caller.
///
/// Build with account/scripts/build.sh: it splices the hash-based verifier in at the @include line below,
/// then runs solc 0.8.38 --strict-assembly --optimize. The EIP-8141 opcodes are emitted through verbatim;
/// their stack orders come from the ethrex source at the devnet commit 9aa3645d and were confirmed on chain
/// (spec, Day-0 results).
///
/// Storage (spec table):
///   0 root    1 treeSeed
///   2 config  bits 0-159 owner | 160-167 height | 168-199 epoch | 200-207 flags (bit 0 hybridRequired) | 208-239 hotStart
///   3 hotValueCap    4 hotFeeCap    5 allowedTarget
///
/// Every refusal reverts with one short reason (32 bytes of ASCII), which ethrex_simulateFrameTransaction
/// reports as revertData, so a refused transaction names the rule it broke.
object "Account" {
  code {
    datacopy(0, dataoffset("runtime"), datasize("runtime"))
    return(0, datasize("runtime"))
  }
  object "runtime" {
    code {
      // ================================================================ dispatch on the caller
      switch eq(caller(), 0xaa)
      case 1 { verifyFrame() }                 // ENTRY_POINT: a VERIFY (or DEFAULT) frame of a frame transaction
      default {
        switch eq(caller(), address())
        case 1 { selfCall() }                  // a SENDER frame of this account: admin functions
        default { publicCall() }               // views, initialize (once), plain ETH receipt
      }

      // ================================================================ EIP-8141 opcodes
      // The first verbatim argument ends up on top of the stack.
      function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }                         // pops param
      function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }         // pops frame, param
      function sigparam(param, sig) -> v { v := verbatim_2i_1o(hex"b4", sig, param) }               // pops sig, param
      function sigdatacopy(mem, offset, len, sig) { verbatim_4i_0o(hex"b5", mem, offset, len, sig) } // pops mem, offset, len, sig
      function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }                              // pops offset, length, scope; ends the frame

      // ================================================================ verify frame (spec, "Verify frame algorithm")
      // Runs as a static call. Reads only own storage, TXPARAM, FRAMEPARAM, SIGPARAM, SIGDATACOPY, CHAINID and
      // memory. Ends with APPROVE(0x3) or reverts.
      function verifyFrame() {
        // 2. Storage: three cold SLOADs; the hot-policy words are read only for a hot leaf.
        let root := sload(0)
        if iszero(root) { fail("not initialized") }
        let treeSeed := sload(1)
        let config := sload(2)
        let height := cfgHeight(config)

        // 3. Nonce mode: one fresh key at sequence 0, named (epoch << 32) | leaf.
        if iszero(eq(txparam(0x0e), 1)) { fail("nonce: key count") }
        let key := txparam(0x10)
        if iszero(key) { fail("nonce: legacy key") }
        if txparam(0x01) { fail("nonce: sequence") }
        if iszero(eq(shr(32, key), cfgEpoch(config))) { fail("nonce: epoch") }
        let leaf := and(key, 0xffffffff)
        if iszero(lt(leaf, shl(height, 1))) { fail("nonce: leaf range") }
        let hot := iszero(lt(leaf, cfgHotStart(config)))

        // 4. Signature shape: [owner ECDSA,] hash-based entry. Hot tickets carry no classical key.
        let count := 1
        if and(and(cfgFlags(config), 1), iszero(hot)) { count := 2 }
        if iszero(eq(txparam(0x0b), count)) { fail("sig: count") }
        if eq(count, 2) {
          if iszero(eq(sigparam(0x01, 0), 1)) { fail("sig: owner scheme") }    // SECP256K1, checked before the signer read
          if sigparam(0x02, 0) { fail("sig: owner msg") }                     // over the canonical sig hash, not any digest
          if iszero(eq(sigparam(0x00, 0), cfgOwner(config))) { fail("sig: owner") }
        }
        let p := sub(count, 1)
        if sigparam(0x01, p) { fail("sig: entry scheme") }                    // ARBITRARY (0); SIGPARAM 0x00 would halt on it
        if sigparam(0x02, p) { fail("sig: entry msg") }
        let entryLen := sigparam(0x03, p)
        if iszero(eq(entryLen, add(2146, mul(32, add(height, 4))))) { fail("sig: entry length") }
        let entry := 0x200                                                    // scratch below, verifier memory above
        sigdatacopy(entry, 0, entryLen, p)
        let head := mload(entry)
        if iszero(eq(byte(0, head), 1)) { fail("sig: entry version") }
        if gt(byte(1, head), 15) { fail("sig: entry slot") }

        // 5 to 8. WOTS+ over the canonical sig hash and the Merkle path to the root; the chain id is hashed
        // into every leaf, so a leaf built for another chain never verifies here.
        if iszero(hashsig_verify(entry, entryLen, txparam(0x08), root, treeSeed, height, leaf, chainid())) {
          fail("sig: hash-based check")
        }

        // 9. Hot tickets: only plain value transfers to the one allowed target, under both caps.
        if hot { hotPolicy() }

        // 10. Approve execution and payment. APPROVE ends the frame.
        approve(3)
        stop()
      }

      function hotPolicy() {
        let valueCap := sload(3)
        if iszero(valueCap) { fail("hot: disabled") }                         // a zero cap is the kill switch
        if gt(txparam(0x06), sload(4)) { fail("hot: fee cap") }               // the transaction's maximum cost
        let target := sload(5)
        // Every later frame. Frames before this one cannot move value: only SENDER frames may carry value,
        // and they run only after this frame approves.
        let total := 0
        let n := txparam(0x09)
        for { let i := add(txparam(0x0a), 1) } lt(i, n) { i := add(i, 1) } {
          if iszero(eq(frameparam(0x02, i), 2)) { fail("hot: frame mode") }   // SENDER only, no DEFAULT
          if frameparam(0x04, i) { fail("hot: frame data") }                  // no calldata
          if iszero(eq(frameparam(0x00, i), target)) { fail("hot: frame target") }
          let sum := add(total, frameparam(0x08, i))
          if lt(sum, total) { fail("hot: value overflow") }
          total := sum
        }
        if gt(total, valueCap) { fail("hot: value cap") }
      }

      // @include-hashsig-verify

      // ================================================================ admin: SENDER frames of this account
      function selfCall() {
        if lt(calldatasize(), 4) { stop() }                                   // the account paying itself
        switch selector()
        case 0x6c6f2d65 { rotate() }                                          // rotate(bytes32,bytes32,uint8)
        case 0xfd7f4621 { setHybrid() }                                       // setHybrid(bool)
        case 0x58aaa077 { setHotPolicy() }                                    // setHotPolicy(uint32,uint256,uint256,address)
        case 0x13af4035 { setOwner() }                                        // setOwner(address)
        default { publicCall() }
      }

      /// New tree, new generation: every secret of the new tree includes the new epoch, so it shares no
      /// one-time key with the old one. Leaves restart at 0 under the new epoch.
      function rotate() {
        needArgs(3)
        let newRoot := calldataload(4)
        if iszero(newRoot) { fail("bad argument") }
        let newHeight := argHeight(calldataload(68))
        // Re-installing the current tree under the next epoch would reopen every leaf it has already used.
        if or(eq(newRoot, sload(0)), eq(calldataload(36), sload(1))) { fail("rotate: same tree") }
        let config := sload(2)
        let epoch := add(cfgEpoch(config), 1)
        if gt(epoch, 0xffffffff) { fail("epoch overflow") }
        sstore(0, newRoot)
        sstore(1, calldataload(36))
        sstore(2, packConfig(cfgOwner(config), newHeight, epoch, cfgFlags(config), cfgHotStart(config)))
        stop()
      }

      function setHybrid() {
        needArgs(1)
        let on := argBool(calldataload(4))
        let config := sload(2)
        if and(on, iszero(cfgOwner(config))) { fail("hybrid: no owner") }                // no key could ever co-sign
        let flags := or(and(cfgFlags(config), 0xfe), on)
        sstore(2, packConfig(cfgOwner(config), cfgHeight(config), cfgEpoch(config), flags, cfgHotStart(config)))
        stop()
      }

      /// A zero value cap disables every hot ticket: the kill switch.
      /// hotStart can be kept or lowered, never raised within an epoch: raising it would turn tickets already
      /// handed to a hot device into cold leaves, which have no caps. To shrink the band, rotate to a new epoch.
      function setHotPolicy() {
        needArgs(4)
        let hotStart := argUint32(calldataload(4))
        let target := argAddress(calldataload(100))
        let config := sload(2)
        if gt(hotStart, cfgHotStart(config)) { fail("hot: band cannot shrink") }
        requireColdLeaf(hotStart, cfgEpoch(config))
        sstore(2, packConfig(cfgOwner(config), cfgHeight(config), cfgEpoch(config), cfgFlags(config), hotStart))
        sstore(3, calldataload(36))
        sstore(4, calldataload(68))
        sstore(5, target)
        stop()
      }

      function setOwner() {
        needArgs(1)
        let newOwner := argAddress(calldataload(4))
        let config := sload(2)
        if and(iszero(newOwner), and(cfgFlags(config), 1)) { fail("hybrid: owner needed") }  // turn hybrid off first
        sstore(2, packConfig(newOwner, cfgHeight(config), cfgEpoch(config), cfgFlags(config), cfgHotStart(config)))
        stop()
      }

      // ================================================================ public: views, initialize, ETH
      function publicCall() {
        if iszero(calldatasize()) { stop() }                                  // plain ETH receipt
        if lt(calldatasize(), 4) { fail("no such function") }
        switch selector()
        case 0x5dfc452b { initialize() }                                      // initialize(bytes32,bytes32,uint8,address,uint32,uint256,uint256,address)
        case 0xebf0c717 { returnWord(sload(0)) }                              // root()
        case 0x6f9875b4 { returnWord(sload(1)) }                              // treeSeed()
        case 0x0ef26743 { returnWord(cfgHeight(sload(2))) }                   // height()
        case 0x900cf0cf { returnWord(cfgEpoch(sload(2))) }                    // epoch()
        case 0x2ea7cf20 { returnWord(cfgHotStart(sload(2))) }                 // hotStart()
        case 0x682ba990 { returnWord(sload(3)) }                              // hotValueCap()
        case 0x3a36be2b { returnWord(sload(4)) }                              // hotFeeCap()
        case 0x73a8c682 { returnWord(sload(5)) }                              // allowedTarget()
        case 0x8da5cb5b { returnWord(cfgOwner(sload(2))) }                    // owner()
        case 0xb7d66406 { returnWord(and(cfgFlags(sload(2)), 1)) }            // hybridRequired()
        default { fail("no such function") }
      }

      /// Called by the factory in the same call that creates the proxy, so no one can initialize it first.
      /// Epoch starts at 0 and hybrid starts off; setHybrid(true) turns the co-signer on.
      function initialize() {
        if sload(0) { fail("already initialized") }
        needArgs(8)
        let newRoot := calldataload(4)
        if iszero(newRoot) { fail("bad argument") }
        let newHeight := argHeight(calldataload(68))
        let newOwner := argAddress(calldataload(100))
        let hotStart := argUint32(calldataload(132))
        requireColdLeaf(hotStart, 0)
        let target := argAddress(calldataload(228))
        sstore(0, newRoot)
        sstore(1, calldataload(36))
        sstore(2, packConfig(newOwner, newHeight, 0, 0, hotStart))
        sstore(3, calldataload(164))
        sstore(4, calldataload(196))
        sstore(5, target)
        stop()
      }

      // ================================================================ helpers
      function selector() -> s { s := shr(224, calldataload(0)) }
      function needArgs(n) { if lt(calldatasize(), add(4, mul(32, n))) { fail("short calldata") } }
      function argAddress(v) -> a { if shr(160, v) { fail("bad argument") } a := v }
      function argUint32(v) -> a { if shr(32, v) { fail("bad argument") } a := v }
      function argBool(v) -> a { if gt(v, 1) { fail("bad argument") } a := v }
      /// 1 to 28: the spec derives every secret from the full leaf index (slot << height) | leaf as a uint32,
      /// with 4 slot bits above the height, so a taller tree would wrap and give two chains the same keys.
      function argHeight(v) -> h { if or(iszero(v), gt(v, 28)) { fail("bad height") } h := v }
      /// Admin functions need a cold leaf: hotStart 0 makes every leaf hot, and so does 1 at epoch 0, where leaf 0
      /// cannot sign (its key would be 0, the legacy nonce). With the kill switch on, that would freeze the account.
      function requireColdLeaf(hotStart, epoch) {
        if or(iszero(hotStart), and(eq(hotStart, 1), iszero(epoch))) { fail("hot: no cold leaf left") }
      }
      function returnWord(v) { mstore(0, v) return(0, 32) }
      function fail(reason) { mstore(0, reason) revert(0, 32) }

      function packConfig(owner, h, epoch, flags, hotStart) -> c {
        c := or(or(or(or(owner, shl(160, h)), shl(168, epoch)), shl(200, flags)), shl(208, hotStart))
      }
      function cfgOwner(c) -> v { v := and(c, 0xffffffffffffffffffffffffffffffffffffffff) }
      function cfgHeight(c) -> v { v := and(shr(160, c), 0xff) }
      function cfgEpoch(c) -> v { v := and(shr(168, c), 0xffffffff) }
      function cfgFlags(c) -> v { v := and(shr(200, c), 0xff) }
      function cfgHotStart(c) -> v { v := and(shr(208, c), 0xffffffff) }
    }
  }
}
