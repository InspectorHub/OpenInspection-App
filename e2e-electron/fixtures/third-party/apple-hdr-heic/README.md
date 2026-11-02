# Apple HDR HEIC sample

`hdr-sample.heic` is a real iPhone HDR photograph (1512 x 850) that carries Apple's `hdrgainmap` auxiliary image. It comes from the MIT-licensed repository https://github.com/johncf/apple-hdr-heic, Copyright (c) 2024 John Charankattu. The licence text is in `LICENSE` next to this file.

It is a regression fixture for the Windows HEIC helper. The primary item is a grid of six tiles whose `irot` property is shared with the gain-map item, and the `iloc` extents are absolute file offsets. The synthetic fixtures under `src/media/heic/fixtures` do not have that layout.
