#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")

using Microsoft::WRL::ComPtr;

int wmain(int argc, wchar_t** argv) {
  if (argc != 3) { std::wcerr << L"usage: encode-p3-heif-fixture <profile.icc> <output.heic>\n"; return 2; }
  std::ifstream profileFile(argv[1], std::ios::binary);
  std::vector<BYTE> profile((std::istreambuf_iterator<char>(profileFile)), {});
  if (profile.size() < 128 || profile.size() > UINT_MAX) return 3;

  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  ComPtr<IWICImagingFactory> factory;
  if (SUCCEEDED(hr)) hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  ComPtr<IWICColorContext> context;
  if (SUCCEEDED(hr)) hr = factory->CreateColorContext(&context);
  if (SUCCEEDED(hr)) hr = context->InitializeFromMemory(profile.data(), static_cast<UINT>(profile.size()));

  constexpr UINT width = 64, height = 48;
  std::vector<BYTE> pixels(static_cast<size_t>(width) * height * 4);
  for (size_t offset = 0; offset < pixels.size(); offset += 4) {
    pixels[offset] = 30; pixels[offset + 1] = 80; pixels[offset + 2] = 230; pixels[offset + 3] = 255;
  }
  ComPtr<IWICBitmap> bitmap;
  if (SUCCEEDED(hr)) hr = factory->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppBGRA,
      width * 4, static_cast<UINT>(pixels.size()), pixels.data(), &bitmap);
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> options;
  if (SUCCEEDED(hr)) hr = factory->CreateStream(&stream);
  if (SUCCEEDED(hr)) hr = stream->InitializeFromFilename(argv[2], GENERIC_WRITE);
  if (SUCCEEDED(hr)) hr = factory->CreateEncoder(GUID_ContainerFormatHeif, nullptr, &encoder);
  if (SUCCEEDED(hr)) hr = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
  if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(&frame, &options);
  if (SUCCEEDED(hr) && options) {
    PROPBAG2 option{};
    option.pstrName = const_cast<wchar_t*>(L"HeifCompressionMethod");
    VARIANT value{};
    VariantInit(&value);
    value.vt = VT_UI1;
    value.bVal = static_cast<BYTE>(WICHeifCompressionHEVC);
    hr = options->Write(1, &option, &value);
    VariantClear(&value);
  }
  if (SUCCEEDED(hr)) hr = frame->Initialize(options.Get());
  if (SUCCEEDED(hr)) hr = frame->SetSize(width, height);
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  if (SUCCEEDED(hr)) hr = frame->SetPixelFormat(&format);
  IWICColorContext* contexts[] = { context.Get() };
  if (SUCCEEDED(hr)) hr = frame->SetColorContexts(1, contexts);
  if (SUCCEEDED(hr)) hr = frame->WriteSource(bitmap.Get(), nullptr);
  if (SUCCEEDED(hr)) hr = frame->Commit();
  if (SUCCEEDED(hr)) hr = encoder->Commit();
  if (FAILED(hr)) std::wcerr << L"HEIF fixture encode failed: 0x" << std::hex << hr << L"\n";
  CoUninitialize();
  return FAILED(hr) ? 1 : 0;
}
