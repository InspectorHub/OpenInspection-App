# Synthetic HEIC fixtures

These fixtures are generated from synthetic pixel buffers and contain no user photos. They are dedicated to test use and released into the public domain under CC0 1.0.

`fixture-64x48.heic` is a 64 × 48 baseline HEIC encoded by Windows WIC `WriteSource`; it has no orientation, P3, HDR, grid, EXIF, or GPS metadata. It exercises only the basic decode path.

`fixture-rot90.heic` is the same synthetic image with a primary-item `irot` property for a 90-degree counterclockwise turn. Its item-property association is added to the WIC output for this application-level regression test; its `iloc` extent offset was corrected to the real `mdat` payload position (the helper keeps `meta` the same size when it removes `irot`, so offsets must be true); it contains no user photo data. The Electron local test also creates 180-degree and 270-degree variants in memory by changing only the `irot` value. It compares each imported JPEG's pixels against the baseline after the corresponding turn, checking both orientation direction and dimensions.

`fixture-bomb-ispe.heic` has a primary-item `ispe` declaration above the 64 MP limit while its encoded HEVC payload remains the tiny baseline image. It verifies that the helper rejects the declared dimensions before asking WIC to decode. `corrupt.heic` is a deliberately truncated copy of the synthetic baseline; it verifies the damaged-input path. Both contain no user photo data.

`fixture-p3.heic` is a synthetic 64 × 48 orange patch encoded with a generated Display P3 ICC v4 profile. The profile is assembled from the public Display P3 primaries, D65 white point, and sRGB transfer curve, and is marked CC0; it is not Apple's copyrighted ICC binary. `scripts/gen-p3-heic-fixture.ps1` regenerates the profile and WIC HEIC fixture on Windows with MSVC plus the Microsoft HEIF/HEVC extensions. The local Electron helper test compares the converted center pixel with the profile-to-sRGB reference and verifies that the output JPEG carries no ICC profile.

`fixture-10bit.heic` is a 64 × 48 RGB Main10 image made from a generated 16-bit PNG gradient. `fixture-grid.heic` is a 128 × 96 RGB Main10 image encoded as a 2 × 2 grid of 64 × 64 tiles, with a different synthetic color in each quadrant. `fixture-gps.heic` is a 64 × 48 RGB Main10 image carrying synthetic GPS EXIF (`N 37°46′03″, W 122°25′09″`) and an identifying description. The local Electron tests confirm that 10-bit and grid images decode to the expected dimensions and that GPS EXIF is not written into the output JPEG.

`scripts/gen-heic-fixtures.py` regenerates these three fixtures from synthetic RGB16 buffers. It is a developer-only script (not run by CI) and requires Pillow plus a libheif `heif-enc` build linked with the x265 Main10 encoder; no user photos are used.
