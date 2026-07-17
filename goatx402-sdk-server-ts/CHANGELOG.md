# Changelog

## 0.3.0 - Unreleased

- Renamed the package `goatx402-sdk-server` to `goatflow-sdk-server` for the
  GOAT Flow rebrand.
- Renamed the exported `GoatX402Client`, `GoatX402Config`, and `GoatX402Error`
  APIs to `GoatFlowClient`, `GoatFlowConfig`, and `GoatFlowError`. Consumers
  must update imports and class references.

## 0.2.1 - 2026-07-12

- Make clean package builds reproducible and exclude sources and maps.
- Run the test suite on `prepublishOnly` so a publish cannot skip tests.
- Build `dist` on `prepare` so git-URL and source-checkout installs get a
  working package; `prepack` keeps the clean reproducible publish build, and
  the clean step is cross-platform (Node `fs.rmSync` instead of `rm -rf`).
- Declare the Node.js 18 runtime requirement.
- Add repository and license metadata.

## 0.2.0 - 2026-07-10

- Add unified hosted checkout session creation for DIRECT and DELEGATE flows.
- Retain the deprecated DELEGATE checkout wrapper for compatibility.

## 0.1.1 - 2026-06-12

- Harden authenticated requests with unique nonce signing and replay protection.
- Improve server SDK request reliability and response typing.

## 0.1.0 - 2026-03-01

- Initial TypeScript server SDK release.
