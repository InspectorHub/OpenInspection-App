#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objidl.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstdint>
#include <cwchar>
#include <iostream>
#include <iterator>
#include <limits>
#include <string>
#include <vector>

#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")

using Microsoft::WRL::ComPtr;

namespace {
constexpr size_t kMaxInputBytes = 50u * 1024u * 1024u;
constexpr size_t kMaxOutputBytes = 10u * 1024u * 1024u;
constexpr uint64_t kMaxPixels = 64'000'000u;
constexpr int kExitSuccess = 0;
constexpr int kExitCodecMissing = 2;
constexpr int kExitUnsupported = 3;
constexpr int kExitTooLarge = 4;
constexpr int kExitCorrupt = 5;

bool ReadInput(std::vector<BYTE>* bytes) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == INVALID_HANDLE_VALUE || input == nullptr) return false;
  std::vector<BYTE> buffer(64u * 1024u);
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(input, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
      const DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF) break;
      return false;
    }
    if (read == 0) break;
    if (bytes->size() + read > kMaxInputBytes) return false;
    bytes->insert(bytes->end(), buffer.begin(), buffer.begin() + read);
  }
  return !bytes->empty();
}

bool IsBrand(const BYTE* brand, const char* expected) {
  return brand[0] == static_cast<BYTE>(expected[0]) && brand[1] == static_cast<BYTE>(expected[1])
      && brand[2] == static_cast<BYTE>(expected[2]) && brand[3] == static_cast<BYTE>(expected[3]);
}

bool IsSupportedHeif(const std::vector<BYTE>& bytes) {
  if (bytes.size() < 16 || !IsBrand(bytes.data() + 4, "ftyp")) return false;
  const uint32_t boxSize = (static_cast<uint32_t>(bytes[0]) << 24) | (static_cast<uint32_t>(bytes[1]) << 16)
      | (static_cast<uint32_t>(bytes[2]) << 8) | static_cast<uint32_t>(bytes[3]);
  if (boxSize < 16 || boxSize > bytes.size() || (boxSize - 16) % 4 != 0) return false;
  bool foundHeif = false;
  for (uint32_t offset = 8; offset + 4 <= boxSize; offset += 4) {
    const BYTE* brand = bytes.data() + offset;
    if (IsBrand(brand, "avif") || IsBrand(brand, "avis")) return false;
    foundHeif = foundHeif || IsBrand(brand, "heic") || IsBrand(brand, "heix") || IsBrand(brand, "heim")
      || IsBrand(brand, "heis") || IsBrand(brand, "hevc") || IsBrand(brand, "hevx") || IsBrand(brand, "hevm")
      || IsBrand(brand, "hevs") || IsBrand(brand, "mif1") || IsBrand(brand, "msf1");
  }
  return foundHeif;
}

bool ParsePositiveInteger(const wchar_t* text, UINT* value) {
  if (text == nullptr || *text == L'\0') return false;
  uint64_t parsed = 0;
  for (const wchar_t* cursor = text; *cursor != L'\0'; ++cursor) {
    if (*cursor < L'0' || *cursor > L'9') return false;
    parsed = parsed * 10 + static_cast<uint64_t>(*cursor - L'0');
    if (parsed > std::numeric_limits<UINT>::max()) return false;
  }
  if (parsed == 0) return false;
  *value = static_cast<UINT>(parsed);
  return true;
}

bool ReadOptions(int argc, wchar_t** argv, UINT* maxLongEdge, UINT* keepOriginalMaxBytes, bool* keepOriginal) {
  if (argc == 3 && wcscmp(argv[1], L"--max-long-edge") == 0) {
    *keepOriginal = false;
    return ParsePositiveInteger(argv[2], maxLongEdge) && *maxLongEdge <= kMaxPixels;
  }
  if (argc == 3 && wcscmp(argv[1], L"--keep-original-max-bytes") == 0) {
    *keepOriginal = true;
    return ParsePositiveInteger(argv[2], keepOriginalMaxBytes) && *keepOriginalMaxBytes <= kMaxOutputBytes;
  }
  return false;
}

int ClassifyCodecError(HRESULT error) {
  if (error == WINCODEC_ERR_COMPONENTNOTFOUND || error == REGDB_E_CLASSNOTREG) return kExitCodecMissing;
  if (error == E_INVALIDARG || error == WINCODEC_ERR_UNSUPPORTEDOPERATION) return kExitUnsupported;
  return kExitCorrupt;
}

HRESULT MakeFactory(ComPtr<IWICImagingFactory>* factory) {
  HRESULT result = CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_PPV_ARGS(factory->GetAddressOf()));
  if (FAILED(result)) result = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                                 IID_PPV_ARGS(factory->GetAddressOf()));
  return result;
}

HRESULT CreateBitmap(IWICImagingFactory* factory, IWICBitmapSource* frame, UINT sourceWidth, UINT sourceHeight,
                     UINT maxLongEdge, bool keepOriginal, ComPtr<IWICBitmapSource>* source,
                     UINT* outputWidth, UINT* outputHeight) {
  *outputWidth = sourceWidth;
  *outputHeight = sourceHeight;
  ComPtr<IWICBitmapSource> sized = frame;
  if (!keepOriginal && maxLongEdge > 0 && std::max(sourceWidth, sourceHeight) > maxLongEdge) {
    const double scale = static_cast<double>(maxLongEdge) / static_cast<double>(std::max(sourceWidth, sourceHeight));
    *outputWidth = std::max<UINT>(1, static_cast<UINT>(sourceWidth * scale + 0.5));
    *outputHeight = std::max<UINT>(1, static_cast<UINT>(sourceHeight * scale + 0.5));
    ComPtr<IWICBitmapScaler> scaler;
    HRESULT result = factory->CreateBitmapScaler(&scaler);
    if (SUCCEEDED(result)) result = scaler->Initialize(frame, *outputWidth, *outputHeight, WICBitmapInterpolationModeFant);
    if (FAILED(result)) return result;
    sized = scaler;
  }

  ComPtr<IWICFormatConverter> converter;
  HRESULT result = factory->CreateFormatConverter(&converter);
  if (SUCCEEDED(result)) result = converter->Initialize(sized.Get(), GUID_WICPixelFormat32bppBGRA,
      WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom);
  if (FAILED(result)) return result;

  const UINT stride = *outputWidth * 4;
  std::vector<BYTE> pixels(static_cast<size_t>(stride) * *outputHeight);
  result = converter->CopyPixels(nullptr, stride, static_cast<UINT>(pixels.size()), pixels.data());
  if (FAILED(result)) return result;
  for (size_t offset = 0; offset + 3 < pixels.size(); offset += 4) {
    const UINT alpha = pixels[offset + 3];
    for (size_t channel = 0; channel < 3; ++channel) {
      pixels[offset + channel] = static_cast<BYTE>((pixels[offset + channel] * alpha + 255u * (255u - alpha) + 127u) / 255u);
    }
    pixels[offset + 3] = 255;
  }
  ComPtr<IWICBitmap> bitmap;
  result = factory->CreateBitmapFromMemory(*outputWidth, *outputHeight, GUID_WICPixelFormat32bppBGRA,
      stride, static_cast<UINT>(pixels.size()), pixels.data(), &bitmap);
  if (FAILED(result)) return result;
  *source = bitmap;
  return S_OK;
}

HRESULT EncodeJpeg(IWICImagingFactory* factory, IWICBitmapSource* source, float quality, std::vector<BYTE>* output) {
  ComPtr<IStream> memory;
  HRESULT result = CreateStreamOnHGlobal(nullptr, TRUE, &memory);
  ComPtr<IWICStream> stream;
  if (SUCCEEDED(result)) result = factory->CreateStream(&stream);
  if (SUCCEEDED(result)) result = stream->InitializeFromIStream(memory.Get());
  ComPtr<IWICBitmapEncoder> encoder;
  if (SUCCEEDED(result)) result = factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder);
  if (SUCCEEDED(result)) result = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> options;
  if (SUCCEEDED(result)) result = encoder->CreateNewFrame(&frame, &options);
  if (SUCCEEDED(result) && options) {
    PROPBAG2 property{};
    property.pstrName = const_cast<wchar_t*>(L"ImageQuality");
    VARIANT value{};
    VariantInit(&value);
    value.vt = VT_R4;
    value.fltVal = quality;
    result = options->Write(1, &property, &value);
    VariantClear(&value);
  }
  if (SUCCEEDED(result)) result = frame->Initialize(options.Get());
  UINT width = 0, height = 0;
  if (SUCCEEDED(result)) result = source->GetSize(&width, &height);
  if (SUCCEEDED(result)) result = frame->SetSize(width, height);
  WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
  if (SUCCEEDED(result)) result = frame->SetPixelFormat(&format);
  if (SUCCEEDED(result)) result = frame->WriteSource(source, nullptr);
  if (SUCCEEDED(result)) result = frame->Commit();
  if (SUCCEEDED(result)) result = encoder->Commit();
  if (FAILED(result)) return result;

  HGLOBAL handle = nullptr;
  result = GetHGlobalFromStream(memory.Get(), &handle);
  if (FAILED(result)) return result;
  STATSTG info{};
  result = memory->Stat(&info, STATFLAG_NONAME);
  if (FAILED(result)) return result;
  const ULONGLONG length = info.cbSize.QuadPart;
  if (length == 0 || length > kMaxOutputBytes) return HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE);
  const SIZE_T size = static_cast<SIZE_T>(length);
  const auto* data = static_cast<const BYTE*>(GlobalLock(handle));
  if (data == nullptr) return E_OUTOFMEMORY;
  output->assign(data, data + size);
  GlobalUnlock(handle);
  return S_OK;
}

bool WriteOutput(const std::vector<BYTE>& bytes) {
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == INVALID_HANDLE_VALUE || output == nullptr) return false;
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD written = 0;
    const DWORD count = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, MAXDWORD));
    if (!WriteFile(output, bytes.data() + offset, count, &written, nullptr) || written == 0) return false;
    offset += written;
  }
  return true;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  UINT maxLongEdge = 0, keepOriginalMaxBytes = 0;
  bool keepOriginal = false;
  if (!ReadOptions(argc, argv, &maxLongEdge, &keepOriginalMaxBytes, &keepOriginal)) return kExitUnsupported;
  std::vector<BYTE> input;
  if (!ReadInput(&input)) return kExitUnsupported;
  if (!IsSupportedHeif(input)) return kExitUnsupported;

  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(result)) return kExitCorrupt;
  ComPtr<IWICImagingFactory> factory;
  result = MakeFactory(&factory);
  ComPtr<IWICStream> stream;
  if (SUCCEEDED(result)) result = factory->CreateStream(&stream);
  if (SUCCEEDED(result)) result = stream->InitializeFromMemory(input.data(), static_cast<DWORD>(input.size()));
  ComPtr<IWICBitmapDecoder> decoder;
  if (SUCCEEDED(result)) result = factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder);
  if (FAILED(result)) {
    const int exitCode = ClassifyCodecError(result);
    CoUninitialize();
    return exitCode;
  }
  UINT frameCount = 0;
  result = decoder->GetFrameCount(&frameCount);
  if (FAILED(result) || frameCount == 0) { CoUninitialize(); return kExitCorrupt; }
  ComPtr<IWICBitmapFrameDecode> frame;
  result = decoder->GetFrame(0, &frame);
  UINT width = 0, height = 0;
  if (SUCCEEDED(result)) result = frame->GetSize(&width, &height);
  if (FAILED(result) || width == 0 || height == 0) { CoUninitialize(); return kExitCorrupt; }
  if (static_cast<uint64_t>(width) * static_cast<uint64_t>(height) > kMaxPixels) { CoUninitialize(); return kExitTooLarge; }

  ComPtr<IWICBitmapSource> bitmap;
  UINT outputWidth = 0, outputHeight = 0;
  result = CreateBitmap(factory.Get(), frame.Get(), width, height, maxLongEdge, keepOriginal, &bitmap, &outputWidth, &outputHeight);
  if (FAILED(result)) { CoUninitialize(); return ClassifyCodecError(result); }
  std::vector<BYTE> jpeg;
  const float qualities[] = {0.98f, 0.92f, 0.85f};
  const size_t qualityCount = keepOriginal ? std::size(qualities) : 2;
  for (size_t index = keepOriginal ? 0 : 1; index < qualityCount; ++index) {
    jpeg.clear();
    result = EncodeJpeg(factory.Get(), bitmap.Get(), qualities[index], &jpeg);
    if (FAILED(result)) {
      CoUninitialize();
      return result == HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE) ? kExitTooLarge : ClassifyCodecError(result);
    }
    const size_t ceiling = keepOriginal ? keepOriginalMaxBytes : kMaxOutputBytes;
    if (jpeg.size() <= ceiling) break;
    if (index + 1 == qualityCount) { CoUninitialize(); return kExitTooLarge; }
  }
  if (jpeg.size() < 4 || jpeg[0] != 0xff || jpeg[1] != 0xd8 || jpeg[2] != 0xff || jpeg[jpeg.size() - 2] != 0xff || jpeg.back() != 0xd9) {
    CoUninitialize();
    return kExitCorrupt;
  }
  const bool written = WriteOutput(jpeg);
  CoUninitialize();
  return written ? kExitSuccess : kExitCorrupt;
}
