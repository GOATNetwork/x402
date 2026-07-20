# Changelog

## 0.3.0 - Unreleased

- Renamed the package and CLI `goatx402-quickpay` to `goatflow-quickpay` for
  the GOAT Flow rebrand. The executable is now `npx goatflow-quickpay`, and the
  optional MPP dependency is `goatflow-sdk ^0.2.0`.
- Until the first `goatflow-sdk` release is eligible under the supply-chain
  policy, a temporary workspace link keeps frozen installs reproducible. The
  link must be removed and the lockfile refreshed before this package is
  tagged or published.
- Give an `EXPIRED` session with a known transaction hash bounded grace polls,
  warn callers not to pay again when it remains expired, and fail closed when a
  recovered confirmed session has no server transaction hash.

## 0.2.3 - 2026-07-12

- Fix `-h` being swallowed as a preceding flag's value (e.g. `inspect <url>
  --json -h`, `pay-x402 ... --force -h`): `-h` is now a flag boundary, so help
  is shown instead of the CLI proceeding with the command.

## 0.2.2 - 2026-07-12

- Add successful top-level CLI help for `--help`, `-h`, and `help`.
- Add regression coverage for CLI help routing and public command discovery.

## 0.2.1 - 2026-07-12

- Treat the `force` option as strictly boolean: only a literal `true` re-broadcasts
  a reused session, so a truthy non-boolean (e.g. the string `"false"`) can no
  longer bypass the double-pay guard.
- Report the server-confirmed hash for a fresh payment that a wallet fee-bumped
  into a replacement, while still preserving the locally broadcast hash for a
  forced reused session.
- Make clean package builds reproducible and publish only runtime artifacts.
- Run the test suite on `prepublishOnly` so a publish cannot skip tests.
- Split the build lifecycle so every install path gets a working `dist`:
  `prepare` runs a plain build (git-URL installs run only `prepare`, and a
  failed install no longer deletes an existing `dist`), while `prepack` runs a
  clean build for reproducible pack/publish artifacts; the clean step is
  cross-platform (Node `fs.rmSync` instead of `rm -rf`).
- Preserve the underlying error when the optional SDK cannot be imported.
- Allow the optional `goatx402-sdk` dependency to resolve to the 0.2.x line:
  the MPP surface QuickPay consumes is unchanged in 0.2.0, so no adaptation
  code is involved.
- Add repository and MIT license metadata.

## 0.2.0 - 2026-07-10

- Add fixed-price product payments with independent price-integrity checks.
- Add durable idempotent recovery for product payments.
- Require the Node-importable SDK release for MPP payments.

## 0.1.0 - 2026-06-12

- Initial QuickPay payer library and CLI release with x402 and MPP support.
