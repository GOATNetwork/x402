# Changelog

## 0.2.1 - 2026-07-12

- Verify approvals actually take effect instead of trusting the receipt alone.
  A non-compliant ERC20 that signals a rejected `approve` by returning `false`
  without reverting mines a status-1 receipt; the SDK previously reported
  success while the allowance was unchanged. Now every approval that is about
  to be sent is strictly simulated first (via `staticCall`, when the contract
  exposes it), and every zero-target write (a USDT-style reset and a `0n`
  revocation) is confirmed by reading the allowance back — so a revocation can
  no longer falsely claim success while spend authority persists. Non-zero
  targets rely on the pre-send simulation plus a status-1 receipt (no post-read,
  which would risk a false negative against a concurrent `transferFrom`).

## 0.2.0 - 2026-07-12

- **BREAKING:** `PaymentHelper.approveToken` now requires an explicit amount and
  resolves to `undefined` whenever no transaction was needed because the
  allowance already equals the requested value (including revoking an
  already-zero allowance).
- **BREAKING:** approval helpers now default to exact amounts; unlimited approval
  requires `{ unlimited: true }`.
- **BREAKING:** `decimals()` now resolves to a JavaScript number at runtime; it
  previously resolved to a bigint despite the `Promise<number>` typing.
- Make ERC20 approvals exact-amount by default, with explicit unlimited opt-in.
- Validate approval inputs at runtime before any transaction is sent (amount
  must be a bigint, non-negative, within uint256; options must be an object;
  `unlimited` must be a boolean when provided), so plain-JavaScript callers
  cannot reset an existing allowance and then fail, or grant unlimited
  approval from a truthy non-boolean; zero combined with `{ unlimited: true }`
  is rejected. The `unlimited` option is read exactly once, so a getter cannot
  pass validation and then flip to grant an unvalidated unlimited approval.
- Judge `ensureApproval` sufficiency against the requested amount; `unlimited`
  only raises the value written when a new approval is needed, and a zero
  amount remains a no-op (`{ needed: false }`) as in 0.1.x.
- Probe non-zero -> non-zero allowance changes with a free eth_call
  simulation first: tokens that accept a direct overwrite (standard ERC20s)
  get a single approval with no reset and no transient zero-allowance window.
  Only when the simulation does not positively succeed (USDT-style tokens,
  transport failures, or contract objects without simulation support) is a
  confirmed approve(0) reset submitted before the final approval; if that
  final approval then fails or is rejected in the wallet, the allowance
  remains zero and the call must be re-run.
- Keep sufficient allowances unchanged in `ensureApproval`, and confirm any final
  approval transaction before returning.
- Skip the transaction entirely when `setApproval` targets the value the
  allowance already holds, including zero-amount revocation of an already-zero
  allowance (`ApprovalUpdate.tx` is now optional).
- Follow successful wallet fee-bump replacements while confirming approval
  transactions, sharing one replacement classifier and one policy with the MPP
  client: any replacement that preserves the original (to, data) is followed
  unless its reason is an explicit `'cancelled'`, and success is decided by
  the replacement's receipt status. The ethers `cancelled` boolean is not
  consulted (ethers sets it for every non-repriced replacement).
- Trust a replacement's attached receipt only when its hash matches the
  replacement transaction; otherwise wait on the replacement directly, so a
  nonstandard provider cannot cause a false approval success or failure.
- Cap replacement-following at 10 hops with cycle detection in both the
  approval waiter and the MPP payment watcher, so a broken or malicious
  provider cannot trap callers in an endless replacement chain.
- Validate the full six-method contract surface in the `ERC20Token`
  constructor and strip internal test seams from the published type
  declarations.
- Make clean package builds reproducible and exclude sources, tests, and maps.
- Build `dist` on `prepare` so git-URL and source-checkout installs get a
  working package; `prepack` keeps the clean reproducible publish build, and
  the clean step is cross-platform (Node `fs.rmSync` instead of `rm -rf`).
- Run the test suite on `prepublishOnly` so a publish cannot skip tests.
- Declare Node.js >= 18 in `engines`, matching the sibling packages.

## 0.1.2 - 2026-07-10

- Fix direct Node.js ESM imports by replacing the runtime JSON ABI import with
  portable human-readable ABI fragments.

## 0.1.1 - 2026-06-12

- Add the MPP buyer client with challenge, payment, verification, retry, and
  transaction-replacement recovery support.
- Harden MPP failure recovery so callers retain the transaction context needed
  to resume verification safely.

## 0.1.0 - 2026-03-01

- Initial frontend payment SDK release.
