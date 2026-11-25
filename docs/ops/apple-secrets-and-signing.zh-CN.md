---
title: Cheers Apple Secrets 与签名资产说明
date: 2026-08-16
tags:
  - Cheers
  - Apple
  - GitHub-Actions
  - Code-Signing
  - Notarization
status: reference
---

# Cheers Apple Secrets 与签名资产说明

## 结论

Cheers 的 Apple 相关配置分成五组，不能混用：

1. iOS/TestFlight 签名：`Apple Distribution` 证书和 iOS App Store provisioning profile。
2. App Store Connect API：上传 TestFlight、提交 macOS notarization 的 `.p8` API key。
3. macOS Developer ID：Mac App Store 之外分发时给 `.app` 签名的 `Developer ID Application` 证书。
4. Sign in with Apple / APNs：服务端生成 Apple client secret 或 APNs token 的 `.p8` key。
5. Tauri updater：只保护自动更新包，不负责 Apple Gatekeeper。

GitHub 中推荐的存放位置：

- Apple 发布与生产部署相关 secret：`production` Environment secrets。
- 公开标识符和 URL：`production` Environment variables。
- 与 Apple 无关、且 repo-level workflow 需要的 secret：repo-level secrets。

## GitHub Secrets

### `IOS_DISTRIBUTION_CERTIFICATE_P12`

用途：iOS Release / TestFlight 构建签名。

来源：Keychain Access 中的 `Apple Distribution: Haowei Wang (8M272Q9TAD)`，导出为 `.p12` 后 base64 上传。

用于：

- `.github/workflows/release-ios.yml`

正确证书 subject 应类似：

```text
CN=Apple Distribution: Haowei Wang (8M272Q9TAD)
```

不要放：

- `Apple Development`
- `Developer ID Application`
- `Developer ID Certification Authority`

### `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`

用途：导入 `IOS_DISTRIBUTION_CERTIFICATE_P12` 时使用的 `.p12` 导出密码。

来源：从 Keychain Access 导出 `Apple Distribution` `.p12` 时设置的密码。

注意：它不是 Apple ID 密码，也不是 App Store Connect API 密码。

### `IOS_PROVISIONING_PROFILE_BASE64`

用途：iOS App Store / TestFlight provisioning profile。

来源：Apple Developer 下载的 `.mobileprovision`，base64 上传。

用于：

- `.github/workflows/release-ios.yml`

正确 profile 应满足：

```text
Name = Cheers App Store Distribution
TeamIdentifier = 8M272Q9TAD
application-identifier = 8M272Q9TAD.app.cheers.ios
aps-environment = production
```

### `ASC_API_KEY_ID`

用途：App Store Connect API Key ID。

用于：

- iOS 上传 TestFlight
- macOS notarization

来源：App Store Connect API key 页面。文件名通常是：

```text
AuthKey_<ASC_API_KEY_ID>.p8
```

当前示例：

```text
M9H8CZJVX5
```

### `ASC_API_ISSUER_ID`

用途：App Store Connect API Issuer ID，用来标识 App Store Connect 组织。

用于：

- iOS 上传 TestFlight
- macOS notarization

它通常是 UUID 形状，例如：

```text
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### `ASC_API_PRIVATE_KEY_P8`

用途：App Store Connect API 私钥。

来源：App Store Connect API key 下载的 `.p8` 文件。

用于：

- `.github/workflows/release-ios.yml`
- `.github/workflows/release-desktop.yml`

不要把它当作 `APPLE_PRIVATE_KEY_P8`，除非它确实也是 Sign in with Apple key。通常这两类 key 不是同一个。

### `DEVELOPER_ID_APPLICATION_P12`

用途：macOS App Store 之外分发时的 Developer ID 签名。

来源：Keychain Access 中的 `Developer ID Application: Haowei Wang (8M272Q9TAD)`，导出为 `.p12` 后 base64 上传。

用于：

- `.github/workflows/release-desktop.yml`

正确证书 subject 应类似：

```text
CN=Developer ID Application: Haowei Wang (8M272Q9TAD)
issuer=Developer ID Certification Authority, G2
```

不要放：

- `Apple Development`
- `Apple Distribution`
- `Developer ID Installer`
- `Developer ID Certification Authority`

### `DEVELOPER_ID_APPLICATION_PASSWORD`

用途：导入 `DEVELOPER_ID_APPLICATION_P12` 时使用的 `.p12` 导出密码。

来源：从 Keychain Access 导出 `Developer ID Application` `.p12` 时设置的密码。

如果密码或证书不匹配，Tauri build 会在导入或签名阶段失败。

### `APPLE_PRIVATE_KEY_P8`

用途：Sign in with Apple 服务端签名，也可被 APNs 逻辑复用完整 `APPLE_*` key tuple。

来源：Apple Developer 的 Keys 页面中启用了 Sign in with Apple 的 `.p8` 文件。

用于：

- `.github/workflows/cd.yml`
- `.github/workflows/release-connector.yml`
- server runtime config

必须和 variable `APPLE_KEY_ID` 匹配。例如：

```text
APPLE_KEY_ID = V88K9G69PQ
APPLE_PRIVATE_KEY_P8 = AuthKey_V88K9G69PQ.p8
```

Apple 的 `.p8` 私钥只能在创建 key 时下载一次。如果丢失，只能新建 key，并同时更新 `APPLE_KEY_ID` 和 `APPLE_PRIVATE_KEY_P8`。

### `DESKTOP_UPDATER_KEY`

用途：Tauri updater 私钥，用来签名 `.app.tar.gz` 更新包和 update feed。

用于：

- `.github/workflows/release-desktop.yml`

注意：它只保证应用内自动更新包没有被篡改。它不能替代 `Developer ID Application`，也不能让 Gatekeeper 信任 macOS app。

## GitHub Variables

### `APPLE_TEAM_ID`

用途：Apple Developer Team ID。

当前示例：

```text
8M272Q9TAD
```

用于：

- iOS signing
- Sign in with Apple
- APNs
- deployment payload

### `APPLE_KEY_ID`

用途：Sign in with Apple / APNs key 的 Key ID。

必须和 `APPLE_PRIVATE_KEY_P8` 对应。

不要和 `ASC_API_KEY_ID` 混淆。

### `APPLE_CLIENT_ID`

用途：iOS native Sign in with Apple client identifier。

当前示例：

```text
app.cheers.ios
```

### `APPLE_WEB_CLIENT_ID`

用途：Web / macOS OAuth 使用的 Apple Services ID。

当前示例：

```text
com.cheers.web
```

### `APPLE_WEB_REDIRECT_URI`

用途：Apple 登录完成后回调到 Cheers gateway 的 URL。

当前示例：

```text
https://www.tocheers.com/api/v1/auth/oauth/apple/callback
```

### `OAUTH_WEB_RETURN_URL`

用途：OAuth 流程完成后回到前端或桌面端的返回 URL。

当前示例：

```text
https://www.tocheers.com/auth/callback
```

## 本地验证命令

### 验证 `.p12` 证书类型

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

期望看到：

```text
CN=Developer ID Application: ...
Key is valid
```

### 验证 iOS provisioning profile

有些 `.mobileprovision` 是 DER CMS 格式，`security cms` 可能解析失败。可以用 Homebrew OpenSSL：

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

## 上传命令

### iOS Distribution 证书

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

## 常见混淆

### `Apple Distribution` 和 `Developer ID Application`

`Apple Distribution` 用于 iOS TestFlight / App Store。

`Developer ID Application` 用于 macOS App Store 之外分发。

它们都是 distribution 类证书，但用途完全不同。

### `Apple Development`

`Apple Development` 只用于开发调试。它有私钥也不能用于 release workflow。

### `Developer ID Certification Authority`

这是中间 CA，不是你的签名身份。不要导出它作为 `.p12`。

### `ASC_API_PRIVATE_KEY_P8` 和 `APPLE_PRIVATE_KEY_P8`

`ASC_API_PRIVATE_KEY_P8` 用于 App Store Connect API。

`APPLE_PRIVATE_KEY_P8` 用于 Sign in with Apple / APNs key tuple。

文件名中的 Key ID 必须和对应 variable 匹配。

### `DESKTOP_UPDATER_KEY` 和 Developer ID

`DESKTOP_UPDATER_KEY` 签 Tauri 更新包。

`DEVELOPER_ID_APPLICATION_P12` 签 macOS app，配合 notarization 通过 Gatekeeper。

两个都需要，但解决的是不同信任边界。

## Release 前检查清单

- `gh secret list --env production --repo haowei2000/Cheers` 中存在全部必需 secrets。
- `gh variable list --env production --repo haowei2000/Cheers` 中 `APPLE_KEY_ID` 与 `APPLE_PRIVATE_KEY_P8` 文件名匹配。
- `DEVELOPER_ID_APPLICATION_P12` 本地验证输出 `CN=Developer ID Application`。
- `IOS_DISTRIBUTION_CERTIFICATE_P12` 本地验证输出 `CN=Apple Distribution`。
- iOS provisioning profile 的 `application-identifier` 是 `8M272Q9TAD.app.cheers.ios`。
- macOS release 日志通过 `Verify Developer ID signature + notarization`。
- macOS release 日志中不能再出现 `Signing with identity "-"` 或 `skipping app notarization`。

## 失败日志解读

### `Signing with identity "-"`

表示 Tauri 退回 ad-hoc signing。Gatekeeper 会认为包不可信。

### `skipping app notarization`

表示 notarization 所需的 `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` 没被 Tauri 识别。

### `certificate ... does not match provided identity "Developer ID Application"`

表示 `DEVELOPER_ID_APPLICATION_P12` 里面放错证书。常见误传：

- `Apple Development`
- `Apple Distribution`

### `Mac verify error: invalid password?`

表示 `.p12` 密码不匹配。

### `Algorithm (RC2-40-CBC) unsupported`

表示 `.p12` 使用旧加密算法。OpenSSL 3 需要加 `-legacy` 才能解析。
