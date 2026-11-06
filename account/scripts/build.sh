#!/usr/bin/env bash
# Builds the account and the standalone verifier: splices the hash-based verifier into each Yul object at its
# @include line, then compiles with solc 0.8.38 --strict-assembly --optimize (plan, interface 3). Both objects get
# the same verifier file, so the Foundry tests on HashSigVerifier test exactly the code the account runs.
# Written with Claude Code (AI) for Vicky.
#   scripts/build.sh                                              # with yul/hashsig/HashSigVerify.yul
#   HASHSIG_VERIFY=yul/hashsig/HashSigVerify.placeholder.yul scripts/build.sh   # the old test stand-in
set -euo pipefail
cd "$(dirname "$0")/.."

SOLC="${SOLC:-$HOME/Library/Application Support/svm/0.8.38/solc-0.8.38}"
VERIFIER="${HASHSIG_VERIFY:-yul/hashsig/HashSigVerify.yul}"
[[ -x "$SOLC" ]] || { echo "solc 0.8.38 not found at $SOLC (run 'forge build' once, or set SOLC)" >&2; exit 1; }
# Pin the exact compiler: the bytecode layout moves with optimizer versions, and 0.8.38 fixes a load-resolver bug.
"$SOLC" --version | grep -q '0.8.38+commit.1835d247' || { echo "need solc 0.8.38+commit.1835d247, got: $("$SOLC" --version | tail -1)" >&2; exit 1; }
[[ -f "$VERIFIER" ]] || { echo "verifier not found: $VERIFIER" >&2; exit 1; }

mkdir -p build
for OBJ in Account HashSigVerifier; do
  grep -q '^[[:space:]]*// @include-hashsig-verify' "yul/$OBJ.yul" || { echo "include line missing in yul/$OBJ.yul" >&2; exit 1; }
  awk -v f="$VERIFIER" '/^[[:space:]]*\/\/ @include-hashsig-verify/ { while ((getline line < f) > 0) print line; close(f); next } { print }' \
    "yul/$OBJ.yul" > "build/$OBJ.flat.yul"
  "$SOLC" --strict-assembly --optimize --bin "build/$OBJ.flat.yul" > "build/$OBJ.solc.out"
  awk '/Binary representation:/ { getline; print; exit }' "build/$OBJ.solc.out" | tr -d '[:space:]' > "build/$OBJ.bin"
  [[ -s "build/$OBJ.bin" ]] || { cat "build/$OBJ.solc.out" >&2; exit 1; }
  echo "build/$OBJ.bin: $(( $(wc -c < "build/$OBJ.bin") / 2 )) bytes"
done
echo "verifier: $VERIFIER"
if [[ "$VERIFIER" == *placeholder* ]]; then
  echo "WARNING: built with the PLACEHOLDER verifier, which checks no signature. Devnet testing only." >&2
fi
