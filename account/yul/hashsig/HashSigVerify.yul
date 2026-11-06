      /// hashsig_verify: spec, verify frame algorithm steps 5 to 8. Written with Claude Code (AI) for Vicky during the
      /// event (the hashsig library was not published); checked against Quip's WOTSPlus.sol in account/test.
      ///
      /// WOTS+ in Quip's wire format (n = 32, keccak256, w = 16, 67 chains) under the spec's tree:
      ///   index  = (slot << height) | leaf, slot from the entry, leaf from the nonce key
      ///   P      = keccak256(treeSeed ‖ uint32(index))
      ///   r_k    = keccak256(0x03 ‖ P ‖ uint16(k)), k = 1..15
      ///   pk_j   = chain(sig_j) from position d_j to 15, x = keccak256(x XOR r_s)
      ///   leaf   = keccak256(P ‖ uint256(chainId) ‖ keccak256(pk_0 ‖ ... ‖ pk_66))
      ///   root   = h + 4 path hashes, bit k of index picks the side (0: our node is the left child)
      /// entry: memory pointer to version (1) ‖ slot (1) ‖ signature (67 x 32) ‖ path (32 x (height + 4)).
      /// Returns 1 or 0, never reverts. Memory: scratch 0x00-0x5f, r_1..r_15 in the 512 bytes after the entry
      /// (rounded up to a word), and the chains are completed IN PLACE: the signature bytes of the entry are
      /// overwritten with the chain ends (callers pass a copy they no longer need). Reads no storage, makes no calls.
      function hashsig_verify(entry, entryLen, msgHash, root, treeSeed, height, leaf, chainId) -> ok {
        if or(iszero(height), gt(height, 28)) { leave }                      // the uint32 index needs h + 4 <= 32
        if iszero(eq(entryLen, add(2146, shl(5, add(height, 4))))) { leave }
        if iszero(lt(leaf, shl(height, 1))) { leave }
        let head := mload(entry)
        if iszero(eq(byte(0, head), 1)) { leave }                            // version 0x01
        let slot := byte(1, head)
        if gt(slot, 15) { leave }
        let index := or(shl(height, slot), leaf)

        let r := and(add(add(entry, entryLen), 31), not(31))                 // r_k at r + 32k
        let P := hs_publicSeed(treeSeed, index)
        hs_randomization(P, r)
        let node := hs_leafNode(P, chainId, hs_publicKeyHash(add(entry, 2), msgHash, r))
        ok := eq(hs_root(node, add(entry, 2146), index, add(height, 4)), root)
      }

      function hs_publicSeed(treeSeed, index) -> P {
        mstore(0x00, treeSeed)
        mstore(0x20, shl(224, index))                                        // uint32 big-endian at 0x20
        P := keccak256(0x00, 0x24)
      }

      /// r_k = keccak256(0x03 ‖ P ‖ uint16(k)): 35 bytes laid out at 0x00 (prefix), 0x01 (P), 0x21 (k).
      function hs_randomization(P, r) {
        mstore(0x01, P)
        mstore8(0x00, 0x03)
        for { let k := 1 } lt(k, 16) { k := add(k, 1) } {
          mstore(0x21, shl(240, k))
          mstore(add(r, shl(5, k)), keccak256(0x00, 0x23))
        }
      }

      /// Completes all 67 chains in place over the signature (64 message digits, high nibble first, then the 3
      /// digits of the 12-bit checksum sum(15 - d) over the message digits) and returns keccak256 of the chain ends.
      function hs_publicKeyHash(sig, msgHash, r) -> pkHash {
        let rBase := add(r, 0x20)                                            // r_{d+1} is at rBase + 32 d
        let csum := 0
        let ptr := sig
        let msgEnd := add(sig, 0x800)                                        // 64 message chains
        for { let shift := 252 } lt(ptr, msgEnd) { ptr := add(ptr, 0x20) } {
          let d := and(shr(shift, msgHash), 0xf)
          csum := add(csum, sub(15, d))
          mstore(ptr, hs_chain(mload(ptr), add(rBase, shl(5, d)), sub(15, d)))
          shift := sub(shift, 4)
        }
        let c0 := shr(8, csum)                                               // csum < 2^12: three digits
        let c1 := and(shr(4, csum), 0xf)
        let c2 := and(csum, 0xf)
        mstore(ptr, hs_chain(mload(ptr), add(rBase, shl(5, c0)), sub(15, c0)))
        mstore(add(ptr, 0x20), hs_chain(mload(add(ptr, 0x20)), add(rBase, shl(5, c1)), sub(15, c1)))
        mstore(add(ptr, 0x40), hs_chain(mload(add(ptr, 0x40)), add(rBase, shl(5, c2)), sub(15, c2)))
        pkHash := keccak256(sig, 2144)
      }

      /// The last t steps of a chain (WOTSPlus.chain from index d = 15 - t): x = keccak256(x XOR r_s) for
      /// s = d + 1 .. 15, with p pointing at r_{d+1}. No loop: t is split into its bits and each bit runs an
      /// unrolled block of 8, 4, 2 or 1 steps, in order, so a step costs a keccak plus a few opcodes. This is
      /// where the verifier spends its gas (about 500 steps on an average message).
      function hs_chain(x, p, t) -> y {
        y := x
        if and(t, 8) {
            mstore(0x00, xor(y, mload(p))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0x20)))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0x40)))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0x60)))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0x80)))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0xa0)))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0xc0)))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0xe0)))) y := keccak256(0x00, 0x20)
          p := add(p, 0x100)
        }
        if and(t, 4) {
            mstore(0x00, xor(y, mload(p))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0x20)))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0x40)))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0x60)))) y := keccak256(0x00, 0x20)
          p := add(p, 0x80)
        }
        if and(t, 2) {
            mstore(0x00, xor(y, mload(p))) y := keccak256(0x00, 0x20)
            mstore(0x00, xor(y, mload(add(p, 0x20)))) y := keccak256(0x00, 0x20)
          p := add(p, 0x40)
        }
        if and(t, 1) {
            mstore(0x00, xor(y, mload(p))) y := keccak256(0x00, 0x20)
        }
      }

      function hs_leafNode(P, chainId, pkHash) -> node {
        mstore(0x00, P)
        mstore(0x20, chainId)
        mstore(0x40, pkHash)
        node := keccak256(0x00, 0x60)
      }

      function hs_root(leafNode, path, index, depth) -> node {
        node := leafNode
        for { let k := 0 } lt(k, depth) { k := add(k, 1) } {
          let sibling := mload(add(path, shl(5, k)))
          switch and(shr(k, index), 1)
          case 0 { mstore(0x00, node) mstore(0x20, sibling) }
          default { mstore(0x00, sibling) mstore(0x20, node) }
          node := keccak256(0x00, 0x40)
        }
      }
