// Account's verify frame, run by delegatecall. Calldata: root, treeSeed, height, epoch.
// Approves execution and payment when the transaction uses one fresh nonce key (epoch << 32 | leaf) and carries one
// signature entry: 0x01 ‖ slot ‖ 67 WOTS+ chain elements over the sig hash ‖ (height + 4) Merkle siblings.
// Reverts with Rejected(reason) otherwise, and when called directly.
object "Verifier" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        mstore(size, address())
        return(0, add(size, 0x20))
    }
    object "runtime" {
        code {
            {
                // only an account running this code by delegatecall may approve: the code ends with our own address
                codecopy(0, sub(codesize(), 0x20), 0x20)
                if eq(mload(0), address()) { reject(0) }

                let height := calldataload(0x40)

                let key := txparam(0x10)
                if iszero(and(eq(txparam(0x0e), 1), iszero(txparam(0x01)))) { reject(1) }
                // epoch is never 0, so the legacy nonce key 0 never matches
                if iszero(eq(shr(32, key), calldataload(0x60))) { reject(2) }
                let leaf := and(key, 0xffffffff)
                if iszero(lt(leaf, shl(height, 1))) { reject(3) }

                if iszero(eq(txparam(0x0b), 1)) { reject(4) }
                if sigparam(0, 1) { reject(5) }
                let len := add(2274, shl(5, height))
                if iszero(eq(sigparam(0, 3), len)) { reject(6) }

                // memory: scratch 0x00-0x5f, masks r[k] at 0x60 + 32k for k in 1..15, entry at 0x260
                sigdatacopy(0x260, 0, len, 0)
                let header := shr(240, mload(0x260))
                if iszero(eq(shr(8, header), 1)) { reject(7) }
                let slot := and(header, 0xff)
                if iszero(lt(slot, 16)) { reject(8) }

                let index := or(shl(height, slot), leaf)
                mstore(0, calldataload(0x20))
                mstore(0x20, shl(224, index))
                let seed := keccak256(0, 0x24)

                if iszero(eq(root(seed, index, height, txparam(0x08)), calldataload(0))) { reject(9) }
                approve(3)
            }

            function root(seed, index, height, msg) -> node {
                mstore(1, seed)
                mstore8(0, 3)
                for { let k := 1 } lt(k, 16) { k := add(k, 1) } {
                    mstore(0x21, shl(240, k))
                    mstore(add(0x60, shl(5, k)), keccak256(0, 0x23))
                }

                // the 67 digits: the message's 64 nibbles, then the checksum 960 - (their sum) as 3 nibbles,
                // which shift into msg from tail; the sum adds nibbles into bytes, bytes into 16-bit lanes, then
                // the lanes in the top lane of a multiply
                let v := add(
                    and(msg, 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f),
                    and(shr(4, msg), 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f)
                )
                v := add(
                    and(v, 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff),
                    and(shr(8, v), 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff)
                )
                let tail := shl(244, sub(960, shr(240, mul(v, 0x0001000100010001000100010001000100010001000100010001000100010001))))

                // chain j runs from its digit d to 15: x = keccak256(x ^ r[k]) for k in d+1..15, two steps per pass
                for { let e := 0x262 } lt(e, 0xac2) { e := add(e, 0x20) } {
                    let d := shr(252, msg)
                    msg := or(shl(4, msg), shr(252, tail))
                    tail := shl(4, tail)

                    let x := mload(e)
                    let p := add(0x80, shl(5, d))
                    if iszero(and(d, 1)) {
                        mstore(0, xor(x, mload(p)))
                        x := keccak256(0, 0x20)
                        p := add(p, 0x20)
                    }
                    for { } lt(p, 0x260) { p := add(p, 0x40) } {
                        mstore(0, xor(x, mload(p)))
                        mstore(0, xor(keccak256(0, 0x20), mload(add(p, 0x20))))
                        x := keccak256(0, 0x20)
                    }
                    mstore(e, x)
                }

                mstore(0, seed)
                mstore(0x20, chainid())
                mstore(0x40, keccak256(0x262, 2144))
                node := keccak256(0, 0x60)

                for { let k := 0 } lt(k, add(height, 4)) { k := add(k, 1) } {
                    let b := shl(5, and(shr(k, index), 1))
                    mstore(b, node)
                    mstore(xor(b, 0x20), mload(add(0xac2, shl(5, k))))
                    node := keccak256(0, 0x40)
                }
            }

            function reject(reason) {
                mstore(0, shl(224, 0x94064f91))
                mstore(4, reason)
                revert(0, 0x24)
            }

            function txparam(p) -> v { v := verbatim_1i_1o(hex"b0", p) }
            function sigparam(i, p) -> v { v := verbatim_2i_1o(hex"b4", i, p) }
            function sigdatacopy(m, o, l, i) { verbatim_4i_0o(hex"b5", m, o, l, i) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
