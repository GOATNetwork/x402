# Releasing the npm packages

This repo publishes four npm packages: `goatx402-sdk` (from `goatx402-sdk/`),
`goatx402-sdk-server` (from `goatx402-sdk-server-ts/`),
`goatx402-quickpay` (from `goatx402-quickpay/`), and `goatx402-checkout`
(from `goatx402-checkout/`). The automated publish workflow was removed for
security reasons (unrestricted trigger, unpinned actions); until a hardened
workflow replaces it, releases follow this manual runbook. Every step is
required — ad-hoc publishes drifting from git is the root cause this process
exists to prevent.

## Publish repository — GOATNetwork/x402

Releases are cut from the canonical `github.com/GOATNetwork/x402` repository
(decided 2026-07-12). `repository.url` in all four packages points there and
must stay that way. Development may happen on forks, but the release commit —
and its tags — must land on the canonical repository's default branch before
anything is published: never publish from a fork checkout, or the published
metadata would reference tags the canonical repository does not contain. When
the hardened publish workflow is restored (see follow-ups), it lives in the
canonical repository and re-enables npm `--provenance` from there.

## Runbook

The order is deliberate: the release state is committed first, validated
second, and tagged/published only after validation — a tag must never point at
a commit that was not tested, and nothing from a dirty tree may ship.

1. **Stamp CHANGELOGs and merge.** Replace each releasing package's
   `Unreleased` heading with the release date (versions already on the registry
   keep their original dates), and land that change on the default branch of
   `GOATNetwork/x402` through the normal PR flow. This merge commit is the
   release commit — never release from a feature branch or a dirty tree.
2. **Clean checkout of the release commit.** `git clone` (or
   `git worktree add`) at that exact commit — do not reuse a working tree with
   local modifications.
3. **Install and test.** These packages ship a `pnpm-lock.yaml` and no
   `package-lock.json`, so a reproducible install uses pnpm. In each package
   directory: `pnpm install --frozen-lockfile` then `npm run test:run`. The
   `prepublishOnly` hook re-runs tests at publish time as a backstop, not a
   substitute for this step.
4. **Version-uniqueness guard.** For each package, confirm the version is not
   already taken: `npm view <name> versions`. Never republish or reuse a
   version number.
5. **Tag the validated commit.** One annotated tag per package release, pushed
   individually — never `git push --tags`, which pushes every local tag:
   `git tag -a goatx402-sdk@0.2.0 -m "goatx402-sdk 0.2.0" <release-commit>`
   then `git push origin goatx402-sdk@0.2.0`.
6. **Publish in dependency order:** `goatx402-sdk` first, then
   `goatx402-quickpay`, `goatx402-sdk-server`, and `goatx402-checkout`.
   QuickPay's optional dependency range advertises the SDK 0.2.x line, so
   publishing the SDK first avoids a window where an advertised version does
   not exist. Run `npm publish` from the tagged clean checkout in each package
   directory; `prepack` produces a clean build and `prepublishOnly` runs tests.
7. **Post-publish smoke.** In a scratch directory, install each published
   package from the registry and import it in Node ESM. For QuickPay, verify
   `npx goatx402-quickpay --help`; for Checkout, also verify the browser IIFE.
   Refresh `goatx402-quickpay/pnpm-lock.yaml` so it resolves the newly published
   SDK.

## Follow-ups tracked

- Restore a hardened publish workflow in the canonical repo: default-branch/
  tag-gated, protected environment, SHA-pinned actions, `--provenance`.
- CI matrix for all four packages (build + tests on push/PR).
