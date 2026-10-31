# Branding

`inspectorhub-mark.svg` is the InspectorHub house mark, a byte-for-byte copy of the file the InspectorHub website serves as its favicon (`https://inspectorhub.io/favicon.svg`). It is square, carries its own margin, and uses an orange gradient for the roof and the H.

The app icons are generated from it by `scripts/build-icons.mjs` (see "Regenerating the app icons" in `docs/development.md`):

- `electron/builder/icon.png` and `icon.ico` (Windows), transparent background
- `android/app/src/main/res/mipmap-*/ic_launcher*.png` (Android launcher and adaptive foreground)
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` (opaque, on white)

These are the InspectorHub product brand assets. A fork that distributes a modified build under another identity should replace them with its own.
