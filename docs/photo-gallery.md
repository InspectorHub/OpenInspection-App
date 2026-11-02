# Saving photos to the device gallery

The setting "Save photos I take to my gallery" (off by default) keeps a copy of each photo taken in the app in the device's photo library. The app never deletes these copies. Only photos taken in the app (`source` camera or burst) are copied, never ones picked from the library.

## Where the copy goes

| Platform | Mechanism | Where | Permission |
|---|---|---|---|
| Android 10 and later | `@capgo/capacitor-file-sharer` (MediaStore insert) | `Pictures/InspectorHub` | none |
| Android 9 and earlier, or a version that cannot be read | `@capacitor-community/media` | album folder in the app's own media folder (`Android/media/<package>/InspectorHub`) | none |
| iOS | `@capacitor-community/media`, no album | Recents | "add only" (`NSPhotoLibraryAddUsageDescription`) |
| Windows | Electron main process, channel `gallery:save` | `Pictures\InspectorHub` | none |

A macOS desktop build is not packaged. The desktop adapter is platform-neutral (`~/Pictures/InspectorHub`; a sandboxed Mac App Store build would need `com.apple.security.assets.pictures.read-write`).

## What was measured

On a Huawei ALP-AL00 (Android 10), 2026-11-02:

- With the file sharer: the file is in `/sdcard/Pictures/InspectorHub`, the media index lists it with `relative_path=Pictures/InspectorHub/`, the system gallery shows an album "InspectorHub", no permission is asked, and an uninstall of the app leaves the photo in place.
- With the media plugin: the copy is indexed and shown, but its folder is inside the app's own media directory, so an uninstall deletes it. That is why the file sharer is used where it can be.
- The Android version is read from the User-Agent Client Hints (`platformVersion`) first, then from the user agent, because Google is freezing the WebView user agent to "Android 10". Unknown means the media plugin.
- Not measured: other Android versions and makers, iOS (read from the plugin's source only, not run), and Windows on a real library.

## Licences

`@capgo/capacitor-file-sharer` is MPL-2.0 (file-level copyleft). The app uses it unmodified from npm; its source is at https://github.com/Cap-go/capacitor-file-sharer. `@capacitor-community/media` is MIT. This app is AGPL-3.0-only and its own source is public.

## Checks

- Unit tests: `src/platform/photo-gallery-capacitor.test.ts`, `src/field/gallery-copy.test.ts`, `electron/main/gallery.test.ts`.
- iOS simulator smoke (`scripts/ios-simulator-smoke.sh`): reads `NSPhotoLibraryAddUsageDescription` and the registered `MediaPlugin` from the built app. The simulator has no camera and the release build has no Diagnostics screen, so the permission prompt and a real save are checked on an iPhone.
