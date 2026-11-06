# Backend fixes after review (Nov 6, ~10:20 IST)

Work in `/Users/vicky/Documents/winterlock-backend` (branch `feat/backend`), on `backend/` and `pipeline/` only. Another
agent is building `web/` there and its tests import `backend/test/helpers.ts` and `backend/test/fake-chain.ts`: keep
their exports working (add, do not rename or remove). Never commit, push or stage; nothing to any network; never read
`~/.winterlock`. The original brief is `.claude/briefs/backend-design.md` in `/Users/vicky/Documents/winterlock`; the
review findings are below with their fixes. Vicky approved these defaults: 1 merge main later (not now), 2 the grind fix
lands first, 3 scripts refuse rotated records, 4 new wallets' owner is the EOA, 5 funding tops up to WL_FUND_WEI, 6 keep
the contiguous-cut rule, 7 re-check an Unknown rotation every 30 s, 8 README attribution at commit time.

## Must fix

A. **Critical (3 of 4 reviewers):** a missing device journal is recreated empty by the next ticket cut, and tickets that
   already signed sign again. Create a device journal only on a real first cut: no `exported` leaf in the epoch's cold
   journal and no `tickets/epoch<e>-*.json`. Otherwise 409 `device_unusable` ("recover <file>; a new journal would re-sign
   used tickets"), and cut nothing. Guard the pipeline too: `TicketDevice.open({create:true})` throws when ticket files
   of the epoch exist. GET tickets and the no_tickets message report exported-but-unjournaled leaves instead of inviting a
   cut. Regression test: cut, a refused hot send signs ticket 12, delete only the device journal, restart, cut → 409 and no
   second signature on 12.
B. **High:** a hot "stuck payment" cannot stick: sendKeyed grinds maxFeePerGas up from the caller's low fee, past the
   devnet's base fee. When the caller fixes the fee (`p.fees` given), grind the LAST sender frame's execution limit,
   one gas per try, instead; fee and deadline both stay exact. Normal sends keep grinding the fee (Vicky's decision).
   Test: a hot send with maxFeePerGasWei 1 keeps exactly fee 1, expires on the fake (base fee above 1), the retry lands on a
   fresh ticket; and a normal send still grinds the fee.
C. **Medium:** an admin call needs two cold leaves (estimate + call). Keep the last 2 cold leaves for admin calls: a keyed
   send that would leave fewer than 2 unused cold leaves answers 409 `leaves_exhausted` ("the last 2 cold leaves are kept
   for rotation and the kill switch"); an admin call with fewer than 2 answers 409 before spending anything. Cold-band
   exhaustion is 409 everywhere, never 500.
D. **Medium:** a request with no or a bad Host shows Bun's development error page with a stack trace: `development: false`,
   an `error` handler that answers the generic 500 JSON. Raise `idleTimeout` (60 s) so a slow GET is not cut off. Body
   limit counted in bytes, checked from Content-Length first.
E. **Medium:** a rotation writes a pipeline wallet's record back over whatever the file now holds. Re-read it first; if it
   names another account, write the updated record to the archive name `deployment-<chain>.<account>.json` (the
   pipeline's convention) and leave the current file alone. Default 3: `pipeline/scripts/lib/wallet.ts` `accountSigner`
   and `openJournal` throw a clear error for a record whose tree generation is not 0 ("rotated by the backend; the
   scripts sign at epoch 0 only").
F. Defaults 4, 5, 7: owner = the EOA's address in POST /wallets; funding tops up to WL_FUND_WEI (check what it does now);
   an Unknown rotation is re-checked in-process every 30 s until decided.

## Cheap lows (do them)

- estimate.ts: a failed key read leaves the leaf `reserved` (a phantom lane that blocks rotation): burn it in a finally.
- Public mempool: sendWithRetry's drop wait asks the sidecar, which never saw the attempt: for `mempool: "public"` wait
  until `node.transactionByHash` answers null instead.
- 422 bodies: include the JSON-RPC error message as a violation when the refusal came as an RPC error.
- Check the signer CLI exists and runs (`--help`) before reserving a ticket; answer 500 `signer_unavailable` without
  burning anything.
- A wallet with hybridRequired on: refuse keyed sends and admin calls with 409 `hybrid_unsupported` before reserving.
- A plain Error from sendKeyed before onSubmitted during a rotation counts as unknown, not dead: keep rotationPending
  until the chain decides.
- README: the run steps install `pipeline/` dependencies too.
- A test for I8's guard on a send that started but has not reserved yet (`rt.busy`).

## Also

- G. `GET /api/status` → `{ chainId, head, headAgeSeconds, stalled, fake }` (fake = chain id 31337, the local fake chain),
  for the screens' status line; 502 when the node cannot be read. Document it in backend/README.md.
- H. The grind fix from the main checkout (proxy holdback, measured GRIND): copy `pipeline/src/grind.ts`,
  `pipeline/src/config.ts` and `pipeline/test/grind.test.ts` from `/Users/vicky/Documents/winterlock` (same content, so
  the later merge is clean), and apply only its two-line change in `pipeline/test/submit.test.ts` (the hot-ticket test:
  maxStepsFor with GRIND.hot instead of the old formula). Then make every backend and pipeline test pass with the new
  GRIND values.

## Done means

Pipeline and backend: tsc clean and every test green (report counts); A and B each put back once and caught by a test;
`backend/README.md` updated (status endpoint, the 2-leaf reserve, device_unusable, hybrid_unsupported).
