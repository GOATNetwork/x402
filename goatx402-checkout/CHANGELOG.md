# Changelog

## goatflow-checkout 0.2.0 - 2026-09-24

- BREAKING: server-created sessions now default to /paykit/direct or
  /paykit/delegate. Use checkoutSessionPath to override the session route;
  checkoutPath keeps its legacy product/custom-checkout meaning.
- Add checkoutType for explicit DIRECT/DELEGATE routing.
- Preserve clean ESM, declaration and browser-IIFE packaging.
- Correct the hosted-origin example and place the types export condition first.
- Pin pnpm 10.28.0 and make package-local frozen installs reproducible.
- Update public integration documentation for PayKit session routing and
  legacy product/custom-checkout compatibility.

## goatflow-checkout 0.1.0 - 2026-07-21

- Renamed the package `goatx402-checkout` to `goatflow-checkout` for the GOAT
  Flow rebrand. This is the first release under the new npm package name.

## goatx402-checkout 0.1.0 - 2026-07-12

- Add the framework-free hosted Checkout SDK for popup, tab, and redirect flows.
- Support fixed DIRECT QuickPay products and unified DIRECT/DELEGATE Checkout
  Sessions.
- Harden the popup channel with exact origin, window-source, and nonce checks.
- Publish reproducible ESM, declaration, and browser-IIFE artifacts.
- Split the build lifecycle so source-checkout installs receive a working
  `dist`, while `prepack` still produces a clean reproducible package.
- Make the clean step cross-platform and run tests on `prepublishOnly`.
