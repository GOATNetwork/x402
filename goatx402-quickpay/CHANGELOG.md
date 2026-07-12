# Changelog

## 0.2.1 - 2026-07-12

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
