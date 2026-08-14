# Desktop Window Chrome

Cheers uses one semantic route toolbar with platform-native window framing. The
operating system owns window controls; React owns route title, navigation, and
feature actions.

## Ownership

```text
Route feature (Channel, Fleet, Activity, Settings)
  -> WindowChromeContext (semantic contribution + pane geometry)
  -> Desktop frame host
       -> macOS overlay renderer
       -> Windows/Linux command-bar renderer
       -> Web inline header
```

- `desktopPlatform.ts` selects the renderer. Feature code must not branch on
  `navigator.platform`.
- `WindowStateBridge.ts` is the only React bridge for focus, fullscreen,
  maximized, and scale-factor state.
- `WindowChromeModel.ts` owns stable Rail/Sidebar geometry. Routes do not paint
  title-bar background fragments.
- `WindowChromeActions` is the contextual action slot. Channel and route
  features retain action ownership while the host chooses where to present it.

## Platform behavior

### macOS

- Native `NSWindow` decorations and traffic lights remain enabled.
- `titleBarStyle: Overlay` and `hiddenTitle: true` are macOS-only configuration.
- React shares the 44 px title-bar row. Only blank nodes are Tauri drag regions.
- The 96 px native-controls inset is present in a normal window and released in
  fullscreen.
- An expanded chat shell paints exactly 56 px Rail + 240 px Sidebar in the row.
  A collapsed shell keeps no fake sidebar surface.

### Windows

- The system title bar, system menu, Minimize/Maximize/Close buttons, and Snap
  Layout behavior remain native.
- Cheers renders the same semantic route toolbar as a 44 px command bar below
  the native title bar.
- The command bar is never marked as a Tauri drag region. A future single-row
  Window Controls Overlay requires a native non-client-area bridge and must not
  be approximated with fake React caption buttons.

### Web and iOS

- Route headers remain inline. They do not mount desktop window chrome.

## Tauri configuration

- `tauri.conf.json` contains the decorated, native-frame baseline.
- `tauri.macos.conf.json` applies the overlay and traffic-light geometry.
- `tauri.windows.conf.json` contains Windows bundle settings and inherits the
  native decorated window.

Tauri merges the platform file into the base configuration. Window arrays are
replaced rather than merged item-by-item, so the macOS file intentionally
declares both `main` and `quickpanel`.

## Acceptance matrix

- macOS: active/inactive, normal/fullscreen, Sidebar open/closed, empty channel,
  rapid Workspace switching, and narrow window.
- Windows: normal/maximized, Snap Layout, 100/150/200% DPI, high contrast, RTL,
  and narrow window.
- Every platform: keyboard navigation, labelled icon actions, stable route
  actions, no interactive control inside a drag region, and no duplicate page
  header.
