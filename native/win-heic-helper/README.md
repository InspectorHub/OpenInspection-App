# Windows HEIC helper

This small x64 executable uses Windows Imaging Component (WIC) to decode HEIF still images and writes a metadata-free JPEG to stdout.

The helper accepts the image bytes only on stdin. It never accepts a file path. Its only command-line forms are `--max-long-edge <integer>` and `--keep-original-max-bytes <integer>`. The process runs with no shell and receives no environment-provided path in packaged builds.

Build it from a Visual Studio Developer Command Prompt or PowerShell session with the x64 C++ tools installed:

```powershell
npm run build:heic-helper
```

The output is written to `dist-electron/native/win-heic-helper.exe` and is not checked into source control. Windows HEIF and HEVC extensions are required for supported HEIC files. The helper does not tone-map HDR PQ/HLG images.
