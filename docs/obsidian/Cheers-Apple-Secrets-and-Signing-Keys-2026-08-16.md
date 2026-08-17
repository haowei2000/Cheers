---
title: Cheers Apple Secrets and Signing Assets
date: 2026-08-16
tags:
  - Cheers
  - Apple
  - GitHub-Actions
  - Code-Signing
  - Notarization
status: reference
---

# Cheers Apple Secrets and Signing Assets

## Summary

Cheers uses several Apple credentials that solve different problems. They must not be mixed:

1. iOS/TestFlight signing uses an `Apple Distribution` certificate and an iOS App Store provisioning profile.
2. App Store Connect API access uses an App Store Connect `.p8` API key for TestFlight upload and macOS notarization.
3. macOS Developer ID distribution uses a `Developer ID Application` certificate to sign the `.app` outside the Mac App Store.
4. Sign in with Apple and APNs use an Apple Developer `.p8` key tuple.
5. Tauri updater signing protects update payloads only; it does not satisfy Gatekeeper.

Recommended GitHub placement:

- Apple release and production deployment secrets: `production` Environment secrets.
- Public identifiers and callback URLs: `production` Environment variables.
- Non-Apple repository-wide automation secrets: repository-level secrets.

Chinese mirror: [Cheers-Apple-Secrets-and-Signing-Keys-2026-08-16.zh-CN.md](Cheers-Apple-Secrets-and-Signing-Keys-2026-08-16.zh-CN.md)

## GitHub Secrets

### `IOS_DISTRIBUTION_CERTIFICATE_P12`

Purpose: signs the iOS Release/TestFlight build.

Source: export `Apple Distribution: Haowei Wang (8M272Q9TAD)` from Keychain Access as `.p12`, then upload its base64 content.

Used by:

- `.github/workflows/release-ios.yml`

Expected certificate subject:

```text
CN=Apple Distribution: Haowei Wang (8M272Q9TAD)
```

Do not upload:

- `Apple Development`
- `Developer ID Application`
- `Developer ID Certification Authority`

### `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`

Purpose: password used to import `IOS_DISTRIBUTION_CERTIFICATE_P12` into the CI keychain.

Source: the export password set when exporting the `Apple Distribution` `.p12` from Keychain Access.

This is not the Apple ID password and not an App Store Connect API password.

### `IOS_PROVISIONING_PROFILE_BASE64`

Purpose: iOS App Store/TestFlight provisioning profile.

Source: base64 content of the `.mobileprovision` file downloaded from Apple Developer.

Used by:

- `.github/workflows/release-ios.yml`

Expected profile fields:

```text
Name = Cheers App Store Distribution
TeamIdentifier = 8M272Q9TAD
application-identifier = 8M272Q9TAD.app.cheers.ios
aps-environment = production
```

### `ASC_API_KEY_ID`

Purpose: App Store Connect API Key ID.

Used for:

- uploading iOS builds to TestFlight
- submitting macOS apps for notarization

Source: App Store Connect API key page. The downloaded key filename usually looks like:

```text
AuthKey_<ASC_API_KEY_ID>.p8
```

Current example:

```text
M9H8CZJVX5
```

### `ASC_API_ISSUER_ID`

Purpose: identifies the App Store Connect organization for API requests.

Used for:

- uploading iOS builds to TestFlight
- submitting macOS apps for notarization

It usually has UUID shape:

```text
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### `ASC_API_PRIVATE_KEY_P8`

Purpose: App Store Connect API private key.

Source: the `.p8` file downloaded for the App Store Connect API key.

Used by:

- `.github/workflows/release-ios.yml`
- `.github/workflows/release-desktop.yml`

Do not use it as `APPLE_PRIVATE_KEY_P8` unless it is truly also the Sign in with Apple key. In normal Apple setups, those are separate keys.

### `DEVELOPER_ID_APPLICATION_P12`

Purpose: signs the macOS app for distribution outside the Mac App Store.

Source: export `Developer ID Application: Haowei Wang (8M272Q9TAD)` from Keychain Access as `.p12`, then upload its base64 content.

Used by:

- `.github/workflows/release-desktop.yml`

Expected certificate subject:

```text
CN=Developer ID Application: Haowei Wang (8M272Q9TAD)
issuer=Developer ID Certification Authority, G2
```

Do not upload:

- `Apple Development`
- `Apple Distribution`
- `Developer ID Installer`
- `Developer ID Certification Authority`

### `DEVELOPER_ID_APPLICATION_PASSWORD`

Purpose: password used to import `DEVELOPER_ID_APPLICATION_P12` into the CI keychain.

Source: the export password set when exporting the `Developer ID Application` `.p12` from Keychain Access.

If this password or certificate is wrong, Tauri build fails during certificate import or signing.

### `APPLE_PRIVATE_KEY_P8`

Purpose: Sign in with Apple server-side signing. The APNs implementation may also reuse the complete `APPLE_*` key tuple.

Source: the Apple Developer `.p8` key that has Sign in with Apple enabled.

Used by:

- `.github/workflows/cd.yml`
- `.github/workflows/release-connector.yml`
- server runtime config

It must match the `APPLE_KEY_ID` variable:

```text
APPLE_KEY_ID = V88K9G69PQ
APPLE_PRIVATE_KEY_P8 = AuthKey_V88K9G69PQ.p8
```

Apple private `.p8` keys can only be downloaded once, at creation time. If the file is lost, create a replacement key and update both `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY_P8`.

### `DESKTOP_UPDATER_KEY`

Purpose: Tauri updater private key. It signs `.app.tar.gz` update payloads and the update feed.

Used by:

- `.github/workflows/release-desktop.yml`

This only protects in-app updates from tampering. It does not replace `Developer ID Application` signing and does not make Gatekeeper trust the app.

## GitHub Variables

### `APPLE_TEAM_ID`

Purpose: Apple Developer Team ID.

Current example:

```text
8M272Q9TAD
```

Used for:

- iOS signing
- Sign in with Apple
- APNs
- deployment payloads

### `APPLE_KEY_ID`

Purpose: Key ID for the Sign in with Apple/APNs key tuple.

It must match `APPLE_PRIVATE_KEY_P8`.

Do not confuse it with `ASC_API_KEY_ID`.

### `APPLE_CLIENT_ID`

Purpose: iOS native Sign in with Apple client identifier.

Current example:

```text
app.cheers.ios
```

### `APPLE_WEB_CLIENT_ID`

Purpose: Apple Services ID for web/macOS OAuth.

Current example:

```text
com.cheers.web
```

### `APPLE_WEB_REDIRECT_URI`

Purpose: callback URL used by Apple after the user completes login.

Current example:

```text
https://www.tocheers.com/api/v1/auth/oauth/apple/callback
```

### `OAUTH_WEB_RETURN_URL`

Purpose: URL where the app returns after the OAuth flow completes.

Current example:

```text
https://www.tocheers.com/auth/callback
```

## Local Verification Commands

### Verify a `.p12` certificate type

```bash
cd ~/Downloads

read -s P12PW
export P12PW
echo

openssl pkcs12 -legacy -in DeveloperIDApplication.p12 -nokeys -passin env:P12PW \
  | openssl x509 -noout -subject -issuer -enddate

openssl pkcs12 -legacy -in DeveloperIDApplication.p12 -nocerts -nodes -passin env:P12PW \
  | openssl pkey -noout -check

unset P12PW
```

Expected output for macOS release signing:

```text
CN=Developer ID Application: ...
Key is valid
```

### Verify the iOS provisioning profile

Some `.mobileprovision` files are DER CMS files, and `security cms` may fail to decode them. Homebrew OpenSSL can decode them:

```bash
/opt/homebrew/bin/openssl cms -inform DER -verify -noverify \
  -in Cheers_App_Store_Distribution.mobileprovision \
  -out profile.plist

plutil -extract Name raw -o - profile.plist
plutil -extract TeamIdentifier.0 raw -o - profile.plist
plutil -extract Entitlements.application-identifier raw -o - profile.plist
plutil -extract Entitlements.aps-environment raw -o - profile.plist
plutil -extract ExpirationDate raw -o - profile.plist
```

## Upload Commands

### iOS Distribution certificate

```bash
base64 -i Certificates.p12 \
  | gh secret set IOS_DISTRIBUTION_CERTIFICATE_P12 \
      --env production \
      --repo haowei2000/Cheers

gh secret set IOS_DISTRIBUTION_CERTIFICATE_PASSWORD \
  --env production \
  --repo haowei2000/Cheers
```

### iOS provisioning profile

```bash
base64 -i Cheers_App_Store_Distribution.mobileprovision \
  | gh secret set IOS_PROVISIONING_PROFILE_BASE64 \
      --env production \
      --repo haowei2000/Cheers
```

### App Store Connect API key

```bash
printf '%s' '<ASC_API_KEY_ID>' \
  | gh secret set ASC_API_KEY_ID \
      --env production \
      --repo haowei2000/Cheers

printf '%s' '<ASC_API_ISSUER_ID>' \
  | gh secret set ASC_API_ISSUER_ID \
      --env production \
      --repo haowei2000/Cheers

gh secret set ASC_API_PRIVATE_KEY_P8 \
  --env production \
  --repo haowei2000/Cheers < AuthKey_<ASC_API_KEY_ID>.p8
```

### macOS Developer ID

```bash
base64 -i DeveloperIDApplication.p12 \
  | gh secret set DEVELOPER_ID_APPLICATION_P12 \
      --env production \
      --repo haowei2000/Cheers

gh secret set DEVELOPER_ID_APPLICATION_PASSWORD \
  --env production \
  --repo haowei2000/Cheers
```

### Sign in with Apple key

```bash
gh secret set APPLE_PRIVATE_KEY_P8 \
  --env production \
  --repo haowei2000/Cheers < AuthKey_<APPLE_KEY_ID>.p8
```

## Common Mix-Ups

### `Apple Distribution` vs. `Developer ID Application`

`Apple Distribution` is for iOS TestFlight/App Store builds.

`Developer ID Application` is for macOS apps distributed outside the Mac App Store.

Both are distribution credentials, but they are not interchangeable.

### `Apple Development`

`Apple Development` is only for local development and debugging. It may include a valid private key, but it must not be used in release workflows.

### `Developer ID Certification Authority`

This is an intermediate CA certificate, not your signing identity. Do not export it as the `.p12`.

### `ASC_API_PRIVATE_KEY_P8` vs. `APPLE_PRIVATE_KEY_P8`

`ASC_API_PRIVATE_KEY_P8` is for the App Store Connect API.

`APPLE_PRIVATE_KEY_P8` is for the Sign in with Apple/APNs key tuple.

The Key ID in the filename must match the corresponding GitHub variable.

### `DESKTOP_UPDATER_KEY` vs. Developer ID

`DESKTOP_UPDATER_KEY` signs Tauri updater payloads.

`DEVELOPER_ID_APPLICATION_P12` signs the macOS app, and notarization plus stapling lets Gatekeeper trust it.

Both are needed, but they protect different trust boundaries.

## Release Checklist

- `gh secret list --env production --repo haowei2000/Cheers` contains all required secrets.
- `gh variable list --env production --repo haowei2000/Cheers` shows an `APPLE_KEY_ID` that matches the `APPLE_PRIVATE_KEY_P8` file.
- `DEVELOPER_ID_APPLICATION_P12` verifies locally as `CN=Developer ID Application`.
- `IOS_DISTRIBUTION_CERTIFICATE_P12` verifies locally as `CN=Apple Distribution`.
- The iOS provisioning profile has `application-identifier = 8M272Q9TAD.app.cheers.ios`.
- The macOS release log passes `Verify Developer ID signature + notarization`.
- The macOS release log must not show `Signing with identity "-"` or `skipping app notarization`.

## Failure Log Guide

### `Signing with identity "-"`

Tauri fell back to ad-hoc signing. Gatekeeper will not trust the package.

### `skipping app notarization`

Tauri did not find the notarization environment: `APPLE_API_KEY`, `APPLE_API_ISSUER`, and `APPLE_API_KEY_PATH`.

### `certificate ... does not match provided identity "Developer ID Application"`

`DEVELOPER_ID_APPLICATION_P12` contains the wrong certificate. Common mistakes:

- `Apple Development`
- `Apple Distribution`

### `Mac verify error: invalid password?`

The `.p12` password does not match the file.

### `Algorithm (RC2-40-CBC) unsupported`

The `.p12` uses old encryption. OpenSSL 3 needs `-legacy` to parse it.

### `bundle is not Developer ID signed`

If the log also shows notarization was accepted, check the verification command. `codesign -dv` may not emit `Authority=` lines; use:

```bash
codesign --display --verbose=4 "$APP"
```
