      /// PLACEHOLDER for hashsig_verify (plan, interface 1) until Author's hashsig library is published.
      /// Written with Claude Code (AI) for Vicky.
      ///
      /// It checks NO signature. It only proves the message path from end to end: the 32 bytes after the
      /// version and slot bytes must equal the message hash, which the pipeline's stand-in signer writes
      /// there. Anyone who can read a transaction can satisfy it. Devnet testing only, never real funds.
      ///
      /// The real function replaces this file (scripts/build.sh, HASHSIG_VERIFY=...). Note the `leaf`
      /// argument: spec steps 5 to 8 need the leaf index (the seed P_leaf and the path's left/right bits),
      /// which the plan's interface 1 does not list. Confirm against the published library.
      function hashsig_verify(entry, entryLen, msgHash, root, treeSeed, height, leaf, chainId) -> ok {
        ok := eq(mload(add(entry, 2)), msgHash)
      }
