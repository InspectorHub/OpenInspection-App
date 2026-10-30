#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objidl.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstdint>
#include <cwchar>
#include <cstring>
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
constexpr int kExitTooLargeBytes = 6;

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

uint32_t ReadU32(const std::vector<BYTE>& bytes, size_t offset) {
  return (static_cast<uint32_t>(bytes[offset]) << 24) | (static_cast<uint32_t>(bytes[offset + 1]) << 16)
      | (static_cast<uint32_t>(bytes[offset + 2]) << 8) | static_cast<uint32_t>(bytes[offset + 3]);
}

void AppendU32(std::vector<BYTE>* bytes, uint32_t value) {
  bytes->push_back(static_cast<BYTE>(value >> 24));
  bytes->push_back(static_cast<BYTE>(value >> 16));
  bytes->push_back(static_cast<BYTE>(value >> 8));
  bytes->push_back(static_cast<BYTE>(value));
}

struct BoxView { size_t start; size_t size; size_t header; };

bool FindBox(const std::vector<BYTE>& bytes, size_t begin, size_t end, const char* type, BoxView* found) {
  for (size_t offset = begin; offset + 8 <= end;) {
    uint64_t size = ReadU32(bytes, offset);
    size_t header = 8;
    if (size == 1) {
      if (offset + 16 > end) return false;
      size = (static_cast<uint64_t>(ReadU32(bytes, offset + 8)) << 32) | ReadU32(bytes, offset + 12);
      header = 16;
    } else if (size == 0) {
      size = end - offset;
    }
    if (size < header || size > end - offset) return false;
    if (memcmp(bytes.data() + offset + 4, type, 4) == 0) {
      *found = {offset, static_cast<size_t>(size), header};
      return true;
    }
    offset += static_cast<size_t>(size);
  }
  return false;
}

std::vector<BYTE> MakeBox(const char* type, const std::vector<BYTE>& body) {
  std::vector<BYTE> box;
  AppendU32(&box, static_cast<uint32_t>(body.size() + 8));
  box.insert(box.end(), type, type + 4);
  box.insert(box.end(), body.begin(), body.end());
  return box;
}

// WIC reports the irot-adjusted size, but its HEIF decoder returns
// WINCODEC_ERR_UNSUPPORTEDOPERATION when CopyPixels is called on such a frame.
// Remove the item's transform property before decoding, then rotate the decoded
// pixels ourselves. This keeps the source item and all other metadata intact.
bool StripPrimaryIrot(std::vector<BYTE>* bytes, UINT* rotation, UINT* primaryWidth, UINT* primaryHeight) {
  *rotation = 0;
  *primaryWidth = 0;
  *primaryHeight = 0;
  BoxView meta{};
  if (!FindBox(*bytes, 0, bytes->size(), "meta", &meta)) return true;
  if (meta.size < meta.header + 4) return false;
  const size_t metaBody = meta.start + meta.header + 4; // FullBox version and flags.
  const size_t metaEnd = meta.start + meta.size;
  BoxView pitm{}, iprp{};
  if (!FindBox(*bytes, metaBody, metaEnd, "pitm", &pitm)
      || !FindBox(*bytes, metaBody, metaEnd, "iprp", &iprp)) return false;
  if (pitm.size < pitm.header + 4) return false;
  const BYTE pitmVersion = (*bytes)[pitm.start + pitm.header];
  if (pitmVersion > 1 || pitm.size < pitm.header + (pitmVersion == 0 ? 6 : 8)) return false;
  const size_t pitmIdOffset = pitm.start + pitm.header + 4;
  const uint32_t primaryId = pitmVersion == 0 ? (static_cast<uint32_t>((*bytes)[pitmIdOffset]) << 8) | (*bytes)[pitmIdOffset + 1]
      : ((static_cast<uint32_t>((*bytes)[pitmIdOffset]) << 24) | (static_cast<uint32_t>((*bytes)[pitmIdOffset + 1]) << 16)
         | (static_cast<uint32_t>((*bytes)[pitmIdOffset + 2]) << 8) | (*bytes)[pitmIdOffset + 3]);

  const size_t iprpBegin = iprp.start + iprp.header;
  const size_t iprpEnd = iprp.start + iprp.size;
  BoxView ipco{}, ipma{};
  if (!FindBox(*bytes, iprpBegin, iprpEnd, "ipco", &ipco) || !FindBox(*bytes, iprpBegin, iprpEnd, "ipma", &ipma)) return false;

  std::vector<BoxView> properties;
  for (size_t offset = ipco.start + ipco.header; offset < ipco.start + ipco.size;) {
    if (offset + 8 > ipco.start + ipco.size) return false;
    BoxView property{};
    if (!FindBox(*bytes, offset, ipco.start + ipco.size, "irot", &property)) {
      // FindBox searches forward; parse and retain this non-irot box directly.
      uint64_t size = ReadU32(*bytes, offset);
      size_t header = 8;
      if (size == 1) { if (offset + 16 > ipco.start + ipco.size) return false; size = (static_cast<uint64_t>(ReadU32(*bytes, offset + 8)) << 32) | ReadU32(*bytes, offset + 12); header = 16; }
      else if (size == 0) size = ipco.start + ipco.size - offset;
      if (size < header || size > ipco.start + ipco.size - offset) return false;
      properties.push_back({offset, static_cast<size_t>(size), header});
      if (properties.size() > 0x7fffu) return false;
      offset += static_cast<size_t>(size);
      continue;
    }
    if (property.start != offset) {
      uint64_t size = ReadU32(*bytes, offset);
      size_t header = size == 1 ? 16 : 8;
      if (size == 0) size = ipco.start + ipco.size - offset;
      if (size < header || size > ipco.start + ipco.size - offset) return false;
      properties.push_back({offset, static_cast<size_t>(size), header});
      if (properties.size() > 0x7fffu) return false;
      offset += static_cast<size_t>(size);
      continue;
    }
    if (property.size != 9 || property.header != 8) return false;
    properties.push_back(property);
    if (properties.size() > 0x7fffu) return false;
    offset += property.size;
  }
  bool hasIrot = false;
  for (size_t index = 0; index < properties.size(); ++index) {
    const BoxView property = properties[index];
    if (memcmp(bytes->data() + property.start + 4, "irot", 4) == 0) hasIrot = true;
  }
  if (ipma.size < ipma.header + 8) return false;
  const BYTE ipmaVersion = (*bytes)[ipma.start + ipma.header];
  if (ipmaVersion > 1) return false;
  const uint32_t ipmaFlags = (static_cast<uint32_t>((*bytes)[ipma.start + ipma.header + 1]) << 16)
      | (static_cast<uint32_t>((*bytes)[ipma.start + ipma.header + 2]) << 8)
      | (*bytes)[ipma.start + ipma.header + 3];
  const bool wideAssociations = (ipmaFlags & 1u) != 0;
  size_t cursor = ipma.start + ipma.header + 4;
  if (cursor + 4 > ipma.start + ipma.size) return false;
  const uint32_t entryCount = ReadU32(*bytes, cursor); cursor += 4;
  std::vector<BYTE> newIpmaBody(bytes->begin() + static_cast<std::ptrdiff_t>(ipma.start + ipma.header), bytes->begin() + static_cast<std::ptrdiff_t>(ipma.start + ipma.header + 4));
  AppendU32(&newIpmaBody, entryCount);
  std::vector<bool> removeProperty(properties.size(), false);
  for (size_t index = 0; index < properties.size(); ++index) {
    const BoxView property = properties[index];
    if (memcmp(bytes->data() + property.start + 4, "irot", 4) == 0) removeProperty[index] = true;
  }
  bool primaryHasRotation = false;
  bool primaryHasImageSize = false;
  for (uint32_t entry = 0; entry < entryCount; ++entry) {
    const size_t idBytes = ipmaVersion < 1 ? 2 : 4;
    const size_t entryStart = cursor;
    if (cursor + idBytes + 1 > ipma.start + ipma.size) return false;
    uint32_t itemId = idBytes == 2 ? (static_cast<uint32_t>((*bytes)[cursor]) << 8) | (*bytes)[cursor + 1] : ReadU32(*bytes, cursor);
    cursor += idBytes;
    const BYTE associationCount = (*bytes)[cursor++];
    const size_t assocBytes = wideAssociations ? 2 : 1;
    if (cursor + static_cast<size_t>(associationCount) * assocBytes > ipma.start + ipma.size) return false;
    std::vector<uint16_t> associations;
    for (BYTE item = 0; item < associationCount; ++item) {
      const uint16_t association = wideAssociations
          ? static_cast<uint16_t>(((*bytes)[cursor] << 8) | (*bytes)[cursor + 1]) : (*bytes)[cursor];
      cursor += assocBytes;
      const uint16_t propertyIndex = wideAssociations ? (association & 0x7fffu) : (association & 0x7fu);
      const uint16_t essential = wideAssociations ? (association & 0x8000u) : (association & 0x80u);
      if (propertyIndex == 0 || propertyIndex > properties.size()) return false;
      const size_t propertyOffset = propertyIndex - 1;
      const BoxView associatedProperty = properties[propertyOffset];
      if (itemId == primaryId && memcmp(bytes->data() + associatedProperty.start + 4, "ispe", 4) == 0) {
        if (primaryHasImageSize || associatedProperty.header != 8 || associatedProperty.size != 20) return false;
        *primaryWidth = ReadU32(*bytes, associatedProperty.start + 12);
        *primaryHeight = ReadU32(*bytes, associatedProperty.start + 16);
        if (*primaryWidth == 0 || *primaryHeight == 0) return false;
        primaryHasImageSize = true;
      }
      if (removeProperty[propertyOffset]) {
        if (itemId == primaryId) {
          if (primaryHasRotation) return false;
          const BoxView rotationBox = properties[propertyOffset];
          const BYTE encodedRotation = (*bytes)[rotationBox.start + rotationBox.header];
          if ((encodedRotation & 0xfcu) != 0) return false;
          *rotation = encodedRotation & 0x03u;
          primaryHasRotation = true;
        }
        continue;
      }
      uint16_t adjusted = propertyIndex;
      for (size_t removed = 0; removed < propertyOffset; ++removed) if (removeProperty[removed]) --adjusted;
      associations.push_back(static_cast<uint16_t>(essential | adjusted));
    }
    newIpmaBody.insert(newIpmaBody.end(), bytes->begin() + static_cast<std::ptrdiff_t>(entryStart), bytes->begin() + static_cast<std::ptrdiff_t>(entryStart + idBytes));
    newIpmaBody.push_back(static_cast<BYTE>(associations.size()));
    for (uint16_t association : associations) {
      if (wideAssociations) { newIpmaBody.push_back(static_cast<BYTE>(association >> 8)); newIpmaBody.push_back(static_cast<BYTE>(association)); }
      else newIpmaBody.push_back(static_cast<BYTE>(association));
    }
  }
  if (cursor != ipma.start + ipma.size) return false;
  if (!hasIrot) return true;

  std::vector<BYTE> newIpcoBody;
  for (size_t index = 0; index < properties.size(); ++index) {
    if (!removeProperty[index]) {
      const BoxView property = properties[index];
      newIpcoBody.insert(newIpcoBody.end(), bytes->begin() + static_cast<std::ptrdiff_t>(property.start), bytes->begin() + static_cast<std::ptrdiff_t>(property.start + property.size));
    }
  }
  const auto newIpco = MakeBox("ipco", newIpcoBody);
  const auto newIpma = MakeBox("ipma", newIpmaBody);
  std::vector<BYTE> newIprpBody;
  for (size_t offset = iprpBegin; offset < iprpEnd;) {
    if (offset + 8 > iprpEnd) return false;
    BoxView child{};
    if (!FindBox(*bytes, offset, iprpEnd, "ipco", &child) || child.start != offset) {
      if (memcmp(bytes->data() + offset + 4, "ipma", 4) == 0) child = ipma;
      else {
        uint64_t size = ReadU32(*bytes, offset);
        size_t header = size == 1 ? 16 : 8;
        if (size == 0) size = iprpEnd - offset;
        if (size < header || size > iprpEnd - offset) return false;
        child = {offset, static_cast<size_t>(size), header};
      }
    }
    if (child.start == ipco.start) newIprpBody.insert(newIprpBody.end(), newIpco.begin(), newIpco.end());
    else if (child.start == ipma.start) newIprpBody.insert(newIprpBody.end(), newIpma.begin(), newIpma.end());
    else newIprpBody.insert(newIprpBody.end(), bytes->begin() + static_cast<std::ptrdiff_t>(child.start), bytes->begin() + static_cast<std::ptrdiff_t>(child.start + child.size));
    offset += child.size;
  }
  const auto newIprp = MakeBox("iprp", newIprpBody);
  std::vector<BYTE> newMetaBody(bytes->begin() + static_cast<std::ptrdiff_t>(meta.start + meta.header), bytes->begin() + static_cast<std::ptrdiff_t>(iprp.start));
  newMetaBody.insert(newMetaBody.end(), newIprp.begin(), newIprp.end());
  newMetaBody.insert(newMetaBody.end(), bytes->begin() + static_cast<std::ptrdiff_t>(iprpEnd), bytes->begin() + static_cast<std::ptrdiff_t>(metaEnd));
  const auto newMeta = MakeBox("meta", newMetaBody);
  std::vector<BYTE> rewritten;
  rewritten.insert(rewritten.end(), bytes->begin(), bytes->begin() + static_cast<std::ptrdiff_t>(meta.start));
  rewritten.insert(rewritten.end(), newMeta.begin(), newMeta.end());
  rewritten.insert(rewritten.end(), bytes->begin() + static_cast<std::ptrdiff_t>(metaEnd), bytes->end());
  *bytes = std::move(rewritten);
  return true;
}

HRESULT CreateSrgbSource(IWICImagingFactory* factory, IWICBitmapFrameDecode* frame,
                         ComPtr<IWICBitmapSource>* source) {
  UINT contextCount = 0;
  HRESULT result = frame->GetColorContexts(0, nullptr, &contextCount);
  if (FAILED(result)) return result;
  if (contextCount == 0) {
    *source = frame; // HEIF without an embedded profile uses the sRGB default.
    return S_OK;
  }

  std::vector<ComPtr<IWICColorContext>> contexts(contextCount);
  std::vector<IWICColorContext*> rawContexts;
  rawContexts.reserve(contextCount);
  for (auto& context : contexts) {
    result = factory->CreateColorContext(&context);
    if (FAILED(result)) return result;
    rawContexts.push_back(context.Get());
  }
  UINT actualCount = 0;
  result = frame->GetColorContexts(contextCount, rawContexts.data(), &actualCount);
  if (FAILED(result) || actualCount == 0) return FAILED(result) ? result : WINCODEC_ERR_BADMETADATAHEADER;

  ComPtr<IWICColorContext> destination;
  result = factory->CreateColorContext(&destination);
  if (SUCCEEDED(result)) result = destination->InitializeFromExifColorSpace(1); // sRGB
  ComPtr<IWICColorTransform> transform;
  if (SUCCEEDED(result)) result = factory->CreateColorTransformer(&transform);
  if (SUCCEEDED(result)) result = transform->Initialize(frame, contexts[0].Get(), destination.Get(), GUID_WICPixelFormat32bppBGRA);
  if (SUCCEEDED(result)) *source = transform;
  return result;
}

HRESULT CreateRotatedSource(IWICImagingFactory* factory, IWICBitmapSource* frame, UINT rotation,
                            ComPtr<IWICBitmapSource>* source, UINT* width, UINT* height) {
  UINT sourceWidth = 0, sourceHeight = 0;
  HRESULT result = frame->GetSize(&sourceWidth, &sourceHeight);
  if (FAILED(result) || sourceWidth == 0 || sourceHeight == 0) return FAILED(result) ? result : E_INVALIDARG;
  *width = rotation % 2 == 0 ? sourceWidth : sourceHeight;
  *height = rotation % 2 == 0 ? sourceHeight : sourceWidth;

  ComPtr<IWICFormatConverter> converter;
  result = factory->CreateFormatConverter(&converter);
  if (SUCCEEDED(result)) result = converter->Initialize(frame, GUID_WICPixelFormat32bppBGRA,
      WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom);
  if (FAILED(result)) return result;
  const UINT sourceStride = sourceWidth * 4;
  std::vector<BYTE> sourcePixels(static_cast<size_t>(sourceStride) * sourceHeight);
  result = converter->CopyPixels(nullptr, sourceStride, static_cast<UINT>(sourcePixels.size()), sourcePixels.data());
  if (FAILED(result)) return result;

  const UINT outputStride = *width * 4;
  std::vector<BYTE> outputPixels(static_cast<size_t>(outputStride) * *height);
  for (UINT y = 0; y < sourceHeight; ++y) {
    for (UINT x = 0; x < sourceWidth; ++x) {
      UINT targetX = x, targetY = y;
      if (rotation == 1) { targetX = y; targetY = sourceWidth - 1 - x; } // 90 degrees counterclockwise.
      else if (rotation == 2) { targetX = sourceWidth - 1 - x; targetY = sourceHeight - 1 - y; }
      else if (rotation == 3) { targetX = sourceHeight - 1 - y; targetY = x; }
      const size_t sourceOffset = (static_cast<size_t>(y) * sourceWidth + x) * 4;
      const size_t targetOffset = static_cast<size_t>(targetY) * outputStride + static_cast<size_t>(targetX) * 4;
      memcpy(outputPixels.data() + targetOffset, sourcePixels.data() + sourceOffset, 4);
    }
  }
  ComPtr<IWICBitmap> bitmap;
  result = factory->CreateBitmapFromMemory(*width, *height, GUID_WICPixelFormat32bppBGRA,
      outputStride, static_cast<UINT>(outputPixels.size()), outputPixels.data(), &bitmap);
  if (SUCCEEDED(result)) *source = bitmap;
  return result;
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

class TempInputFile {
 public:
  TempInputFile() = default;
  TempInputFile(const TempInputFile&) = delete;
  TempInputFile& operator=(const TempInputFile&) = delete;
  ~TempInputFile() { if (path_[0] != L'\0') DeleteFileW(path_); }

  bool Write(const std::vector<BYTE>& bytes) {
    wchar_t directory[MAX_PATH + 1] = {};
    const DWORD length = GetTempPathW(static_cast<DWORD>(std::size(directory)), directory);
    if (length == 0 || length >= std::size(directory)) return false;
    if (GetTempFileNameW(directory, L"oihe", 0, path_) == 0) return false;

    HANDLE file = CreateFileW(path_, GENERIC_WRITE, 0, nullptr, TRUNCATE_EXISTING,
                              FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    size_t offset = 0;
    bool ok = true;
    while (offset < bytes.size()) {
      DWORD written = 0;
      const DWORD count = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, MAXDWORD));
      if (!WriteFile(file, bytes.data() + offset, count, &written, nullptr) || written == 0) {
        ok = false;
        break;
      }
      offset += written;
    }
    if (!CloseHandle(file)) ok = false;
    if (!ok) DeleteFileW(path_);
    return ok;
  }

  const wchar_t* path() const { return path_; }

 private:
  wchar_t path_[MAX_PATH + 1] = {};
};
} // namespace

int wmain(int argc, wchar_t** argv) {
  UINT maxLongEdge = 0, keepOriginalMaxBytes = 0;
  bool keepOriginal = false;
  if (!ReadOptions(argc, argv, &maxLongEdge, &keepOriginalMaxBytes, &keepOriginal)) return kExitUnsupported;
  std::vector<BYTE> input;
  if (!ReadInput(&input)) return kExitUnsupported;
  if (!IsSupportedHeif(input)) return kExitUnsupported;
  UINT rotation = 0, primaryWidth = 0, primaryHeight = 0;
  if (!StripPrimaryIrot(&input, &rotation, &primaryWidth, &primaryHeight)) return kExitCorrupt;
  if (primaryWidth != 0 && primaryHeight != 0
      && static_cast<uint64_t>(primaryWidth) * static_cast<uint64_t>(primaryHeight) > kMaxPixels) return kExitTooLarge;

  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(result)) return kExitCorrupt;
  TempInputFile inputFile;
  if (!inputFile.Write(input)) { CoUninitialize(); return kExitCorrupt; }
  ComPtr<IWICImagingFactory> factory;
  result = MakeFactory(&factory);
  ComPtr<IWICBitmapDecoder> decoder;
  if (SUCCEEDED(result)) result = factory->CreateDecoderFromFilename(inputFile.path(), nullptr, GENERIC_READ,
      WICDecodeMetadataCacheOnLoad, &decoder);
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

  ComPtr<IWICBitmapSource> colorManagedSource;
  result = CreateSrgbSource(factory.Get(), frame.Get(), &colorManagedSource);
  if (FAILED(result)) { CoUninitialize(); return ClassifyCodecError(result); }

  ComPtr<IWICBitmapSource> orientedSource = colorManagedSource;
  if (rotation != 0) {
    result = CreateRotatedSource(factory.Get(), colorManagedSource.Get(), rotation, &orientedSource, &width, &height);
    if (FAILED(result)) { CoUninitialize(); return ClassifyCodecError(result); }
  }
  ComPtr<IWICBitmapSource> bitmap;
  UINT outputWidth = 0, outputHeight = 0;
  result = CreateBitmap(factory.Get(), orientedSource.Get(), width, height, maxLongEdge, keepOriginal, &bitmap, &outputWidth, &outputHeight);
  if (FAILED(result)) { CoUninitialize(); return ClassifyCodecError(result); }
  std::vector<BYTE> jpeg;
  const float qualities[] = {0.98f, 0.92f, 0.85f};
  const size_t qualityCount = keepOriginal ? std::size(qualities) : 2;
  for (size_t index = keepOriginal ? 0 : 1; index < qualityCount; ++index) {
    jpeg.clear();
    result = EncodeJpeg(factory.Get(), bitmap.Get(), qualities[index], &jpeg);
    if (FAILED(result)) {
      CoUninitialize();
      return result == HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE) ? kExitTooLargeBytes : ClassifyCodecError(result);
    }
    const size_t ceiling = keepOriginal ? keepOriginalMaxBytes : kMaxOutputBytes;
    if (jpeg.size() <= ceiling) break;
    if (index + 1 == qualityCount) { CoUninitialize(); return kExitTooLargeBytes; }
  }
  if (jpeg.size() < 4 || jpeg[0] != 0xff || jpeg[1] != 0xd8 || jpeg[2] != 0xff || jpeg[jpeg.size() - 2] != 0xff || jpeg.back() != 0xd9) {
    CoUninitialize();
    return kExitCorrupt;
  }
  const bool written = WriteOutput(jpeg);
  CoUninitialize();
  return written ? kExitSuccess : kExitCorrupt;
}
