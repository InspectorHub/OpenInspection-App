# Releasing the native app

This page is the release checklist for the Android app (and, once its prerequisites are in place, the iOS app). Releases are cut from
git tags; two workflows do the building:

| Workflow | Runs on | Produces |
|---|---|---|
| `.github/workflows/release-android.yml` | a pushed tag `vX.Y.Z`, or a manual run | on a tag: a signed APK, `SHA256SUMS` and a **draft** GitHub Release; from a branch: an unsigned APK as a pipeline check |
| `.github/workflows/release-ios.yml` | a pushed tag `vX.Y.Z`, or a manual run on a tag | a signed build uploaded to TestFlight |

> **The iOS workflow has not uploaded a build to TestFlight.** The `v0.1.0` tag run passed its verification job, then waited at the
> protected TestFlight environment. It needs an Apple developer account and the items listed under "iOS: what the workflow cannot do
> for you" below. Treat the first upload as a trial, and expect to adjust it.

> **Do not cut a release before the editor package that understands the `kept` upload answer is adopted** (`@inspectorhub/field-ui`
> 0.3.0 or later in `package.json`). An older editor treats that answer as a failure, so a photo the server has already kept would be
> reported as lost. Check the dependency before tagging.

The current dependency is `@inspectorhub/field-ui` 0.5.0, which meets that prerequisite. Check it again when tagging a later version.

## First tag run (`v0.1.0`, 2026-10-29)

The Android `verify`, `build`, `sign` and `release` jobs all passed. The signed APK passed v2/v3 signature verification and reports
`versionName` `0.1.0` and `versionCode` `1000`. Certificate SHA-256:
`5a320a607b0be568400c23fce6daf61b1bdd4f4defb5a3e015a1cd5a7825d738`. APK SHA-256:
`76a04984235dec02221688dbfdbd112258715d1bdd4e58fba2d7de6bee1f2c64`. The GitHub Release is a draft; compare the certificate with
the offline record before publishing.

The iOS `verify` job passed, but `testflight` is waiting for its protected environment. No Apple signing or upload was approved or
performed because the Apple credentials and variables are not configured.

Keep the Android draft unpublished until the large-package tag-pull fairness correction is included in a later patch release. A
120-inspection test showed that the 400-request ceiling could repeatedly leave the same inspections without a tag read.

## The version

`package.json` is the single source of the version. Nothing else carries a number you have to edit.

- The web bundle, the `X-Client-Version` header and the Settings screen read it through `vite.config.ts`.
- Android: `versionName` is the whole string; `versionCode` is `major * 1000000 + minor * 1000 + patch` (a pre-release suffix is
  ignored). Minor and patch must stay below 1000, and major up to 2100. The build refuses anything else.
- iOS: `MARKETING_VERSION` in the Xcode project must equal the version without a pre-release suffix. `node scripts/sync-ios-version.mjs`
  writes it, `node scripts/sync-ios-version.mjs --check` fails when it differs, and a test (`src/ios-version.test.ts`) fails the
  build when the committed project drifts. The iOS workflow runs the script itself and sets the build number
  (`CURRENT_PROJECT_VERSION`) to the run number times 100 plus the run attempt, so it never repeats across runs or re-runs. Run the script and commit the result whenever you bump the version.

The first external version is `0.1.0`. Use semantic versioning: a breaking change in what the app needs from the server, or
in the data it keeps on the device, is a major version.

### The version and the server's policy

The app sends its version as `X-Client-Version`. The engine can refuse versions below a minimum:

- `NATIVE_MIN_VERSION_ANDROID` / `NATIVE_MIN_VERSION_IOS`: a version below this answers **426 Upgrade Required** for editor writes; the
  app turns editing off, keeps uploading what it already holds, and shows an update-required screen. `NATIVE_DOWNLOAD_URL_ANDROID`
  (an https address) gives that screen its button.
- `NATIVE_RECOMMENDED_VERSION_ANDROID` / `NATIVE_RECOMMENDED_VERSION_IOS`: a dismissible banner, shown once per app version.

Before you publish a release:

1. Do not raise a `NATIVE_MIN_VERSION_*` above a version users can still get. Raise it only after the new release is published and
   installable, or every installed app is locked out of editing in the meantime.
2. The version in `package.json` must not be below any minimum already set on a server you operate.
3. Self-hosted operators set these variables on their own engine; tell them the version in the release notes.

See "Trying the version states on a device" in `docs/development.md` for how to see each state before shipping.

## Cutting a release

1. Merge everything that belongs in the release. Confirm the `field-ui` dependency (see the warning above).
2. Bump `version` in `package.json` (and the lock file's two copies, for example with `npm version --no-git-tag-version X.Y.Z`), then
   run `node scripts/sync-ios-version.mjs` and commit the result with the bump.
3. Wait for CI to be green on that commit.
4. Tag that commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push upstream vX.Y.Z
   ```

   The tag must equal `v` plus the `package.json` version exactly. The workflow fails in its first job when it does not.
5. Each workflow runs the same checks as CI (type check, tests, build, release-bundle check, API types check). The Android
   workflow then builds an unsigned APK, and only after that waits for approval of its environment (see below) and signs. Review the
   tagged commit's diff **before** you approve: the approval screen does not show it.
6. Android: open the draft Release, read the job summary for the signing certificate fingerprint, compare it with the one you keep
   on record, write the release notes, and publish by hand. The workflow never publishes.
7. A manual run (`workflow_dispatch`) from a **branch** is a pipeline check. Android builds an unsigned APK and keeps it as a
   workflow artifact for 7 days; it never enters the `android-release` environment, never reads a secret, and never signs or creates a
   Release. iOS refuses a manual run that is not on a tag. A manual run on a tag ref does sign (after approval) and keeps the signed
   files for 30 days, but still creates no Release: only a pushed tag does.

### Pre-release versions

The Android version code ignores a pre-release suffix, so `0.1.0-rc.1` and `0.1.0` get the same `versionCode` (1000), and Android
cannot tell which is newer: it will not update one to the other without an uninstall, and an uninstall deletes data that has not
been uploaded. iOS also drops the suffix. So do not hand a pre-release to people who will later receive the final of the same
number as an update. Either test candidates on throwaway installs only, or bump the patch (`0.1.1`) for the final.

### Checklist

- [ ] `@inspectorhub/field-ui` is 0.3.0 or later.
- [ ] Version bumped in `package.json`; `sync-ios-version` run; tag equals `vX.Y.Z`.
- [ ] No server minimum was raised above an installable version (see above).
- [ ] CI green; every job of each release workflow runs green (Android: verify, build, sign, release; iOS: verify, testflight).
- [ ] Checksums published: `SHA256SUMS` is attached to the Release, and the signing certificate fingerprint is in the notes.
- [ ] The release signing key still has **two offline backups** (see below).
- [ ] iOS: the encryption compliance code is recorded in `Info.plist` (see below).
- [ ] iOS: the TestFlight build is still inside its 90-day window and the 60-day release cadence is kept (see below).

### Gradle wrapper, build tools and alignment

- The workflow runs `chmod +x ./gradlew` before calling the wrapper, because the file is committed without the executable bit and a
  Linux runner would otherwise answer "Permission denied".
- The signing job uses one pinned build-tools version (`BUILD_TOOLS_VERSION` in the workflow, 36.0.0, the version the project is
  compiled against). It installs it with `sdkmanager` when the runner image lacks it, and stops with a clear message when it still
  cannot find `apksigner`. Raise the pin deliberately, together with the compile SDK.
- The signing step runs `zipalign -c -P 16 4` as a **check only**. The maintainer's local unsigned build passed this check
  before signing. If the unsigned APK is ever misaligned, the check fails the job instead of shipping a misaligned file (signing with `apksigner` must come after
  alignment, so the workflow cannot align afterwards).

## Verifying a download

```bash
# the checksum
sha256sum -c SHA256SUMS

# the signature and the certificate (needs the Android SDK build-tools)
apksigner verify --verbose --print-certs InspectorHub-X.Y.Z.apk
```

`apksigner` must report `Verified using v2 scheme (APK Signature Scheme v2): true` and the same for v3. Compare
`Signer #1 certificate SHA-256 digest` with the fingerprint printed in the release job summary and in the release notes. The
fingerprint never changes for a given signing key; if it differs from earlier releases, do not install the file.

## What the owner configures in GitHub

Check this configuration before each release. As of 2026-10-28, GitHub has both environments restricted to `v*` tags, a required
maintainer reviewer with self-review allowed, a `v*` tag ruleset, and the four Android environment secret names below. The iOS
environment has no secrets or variables yet, so TestFlight signing and upload cannot run. Secret values and offline keystore backups
cannot be verified from the repository API.

All three items below are **required**, not suggestions. The workflows only gate who can reach a secret by naming an environment,
so the settings are the actual protection.

1. **Environments** (Settings, Environments): create `android-release` and `ios-release`, each with:
   - **Deployment branches and tags** limited to the `v*` tag pattern only (no branches). A run from a branch can then never enter the
     environment.
   - **Required reviewers** who are not the person who pushes the tag, with **Prevent self-review** switched on. While the project has a
     single maintainer this is a deliberate trade-off: that person is the only reviewer and **Prevent self-review** is off, because
     with it on nobody could approve a run. The approval is then a pause to re-read the tagged commit, not a second pair of eyes. Add
     a second reviewer and switch **Prevent self-review** on as soon as another maintainer exists.
2. **Environment-scoped secrets only.** Put every secret below in its environment, and keep **no** signing secret at repository or
   organization level: a workflow on a branch that does not name the environment could read a repository-level secret.
3. **A tag ruleset** (Settings, Rules) limiting creation of `v*` tags to maintainers. A tag push is what starts a signing run.

**Residual exposure, stated plainly.** These settings do not make a leak impossible. A maintainer who tags a malicious commit, and a
reviewer who approves without reading it, still hand the secrets to that commit's code. The Android key lives in a file and a
repository secret, not in a hardware module. The reviewer approves a run without seeing the diff, which is why you review the tagged
commit first. Keep the number of people who can tag or approve small, and treat a change to the release workflows or to anything
they run (`package.json` scripts, Gradle files, dependencies) as security sensitive. On iOS the distribution certificate is imported
into a keychain in the same approved job that ran `npm ci` and the build, so a detached process started by a dependency's install
script could use that keychain; the Android flow avoids this by building unsigned in one job and signing in another. The Android
build job and the signing job each record the unsigned APK's SHA-256 in their summaries; compare the two before you publish.

`ci.yml` is not covered by this: its actions are referenced by tag, not by commit, and it holds no secrets. The release workflows pin
every action to a full commit.

Secrets for Android (the `android-release` environment):

   | Secret | Holds |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | the PKCS12 keystore file, base64 encoded |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
   | `ANDROID_KEY_ALIAS` | the key alias (`inspectorhub`) |
   | `ANDROID_KEY_PASSWORD` | the key password (the same as the keystore password for a PKCS12 keystore) |

Secrets and variables for iOS (the `ios-release` environment; the variables are not secret):

   | Name | Kind | Holds |
   |---|---|---|
   | `IOS_DISTRIBUTION_CERT_P12_BASE64` | secret | the Apple Distribution certificate and key, as a base64 encoded `.p12` |
   | `IOS_DISTRIBUTION_CERT_PASSWORD` | secret | the password of that `.p12` |
   | `APPSTORE_API_PRIVATE_KEY` | secret | the contents of the App Store Connect API key (`AuthKey_*.p8`) |
   | `APPSTORE_ISSUER_ID` | variable | the App Store Connect API issuer id |
   | `APPSTORE_API_KEY_ID` | variable | the App Store Connect API key id |
   | `APPLE_TEAM_ID` | variable | the Apple developer team id |

### The Android signing key

The keystore is created once, with the JDK's `keytool`, for example:

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore release.p12 -keyalg RSA -keysize 4096 -validity 10000 -alias inspectorhub
```

**Keep two offline backups of the keystore and its password, in separate places.** Android only installs an update that is signed by
the same key as the installed app. Losing the key means every user has to uninstall and reinstall, which deletes any inspection data
that has not been uploaded. Never commit the keystore, never put its password in a file in the repository, and never paste a secret
into a workflow run's inputs.

Record the certificate SHA-256 fingerprint somewhere that is not the repository's own Release page (for example the project website
or the maintainer's notes), so a downloaded file can be checked against two independent places.

### Optional: Google Play

The workflow does not publish to Google Play. If you decide to use it: create the app record in the Play Console, enrol in Play App
Signing (the key in `ANDROID_KEYSTORE_BASE64` then becomes the upload key), and build an `.aab` with `./gradlew bundleRelease`
(this needs an extra step in the workflow that signs the bundle with `jarsigner`, which is what Play expects for bundles). Play
re-signs what you upload, so the fingerprint users see on a Play install is Play's, not the one in the release notes.

## iOS: what the workflow cannot do for you

These belong to the Apple developer account holder. The workflow cannot create any of them.

- [ ] An Apple developer account, and the Apple Distribution certificate exported as a `.p12`.
- [ ] The app record in App Store Connect for the bundle id `io.inspectorhub.app`.
- [ ] An App Store Connect API key with the App Manager role (issuer id, key id and the `.p8` file).
- [ ] **Encryption export compliance.** The app declares `ITSAppUsesNonExemptEncryption = YES` because its local database library ships
  an encryption implementation. Upload the classification documents in App Store Connect, wait for Apple to issue the compliance
  code, then record it as `ITSEncryptionExportComplianceCode` in `ios/App/App/Info.plist` and commit it. The workflow prints a
  warning when the key is missing; App Store Connect then asks for the answer on every build. The owner is the account holder; verify
  every regulation you cite against its primary text.
- [ ] Beta App Review material for external testing: review notes and a demo account. App Store Connect's TestFlight "Test
  Information" (description, feedback email, locale) must also be filled in, because the upload step checks it before uploading.

Review notes can say how to check the native abilities by hand: switch on airplane mode, fill in a section and take a photo, force-quit
and reopen to see the data is still there, then reconnect and watch it sync; the encrypted local storage, background upload and the
system share sheet.

### TestFlight cadence

A TestFlight build expires **90 days** after upload. The release rule is to ship a new build at least every **60 days** while testers
depend on it, which leaves a month of slack; a new tag is all it takes. External testing also needs the first build of each version to pass Beta App Review.

### What was assumed and is unverified

`release-ios.yml` follows the plan text and the action documentation, but no run has happened. In particular the following are
untested: manual signing with the profile name returned by the download step, the `Apple Distribution` certificate selector, the
export path `ios/App/output/App.ipa` that Capacitor's build writes, and the upload step's wait for TestFlight processing. Fix what
the first run shows, and tighten this page.

## If a release is wrong

Delete the draft Release and the tag (`git push upstream :refs/tags/vX.Y.Z`) and cut the next patch version. Do not move a tag that
anyone may have built from, and never reuse a published version: Android refuses to install a lower `versionCode` over a higher one.
