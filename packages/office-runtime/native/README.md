# Windows LibreOfficeKit raster adapter

This worker-local adapter targets LibreOffice **26.8.1.1**, BuildId
`bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1`, Windows x64.
The core DLL SHA256 is
`017d0c21b6e45e54c0194b58017853d8c653059cc643643c3eb831a4d309331f`.
It refuses any other binary, export RVA or instruction prologue.

The actual method is
[`VirtualDevice::SetOutputSizePixelScaleOffsetAndLOKBuffer`](https://github.com/LibreOffice/core/blob/libreoffice-26.8.1.1/vcl/source/gdi/virdev.cxx).
Its Windows `SetSizeUsingBuffer` implementation inherits the unsuccessful base
method, while the SVP implementation overrides it. The release code proceeds
after the debug assertion, leaving a 1×1 virtual device. The adapter always
calls the original method first to preserve its map scale and origin, and only
when it returns false allocates output using its exported
`SetOutputSizePixel(size, true, false)`. It does not inspect private
`VirtualDevice` or `Window` fields.

## Native window pixels

The pinned Windows
[`doc_paintTile`](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/desktop/source/lib/init.cxx)
reads the actual device bitmap back into the caller's buffer. Its
`doc_paintWindowForView` Windows branch paints the device but omits that readback.
Allocating the device therefore fixes document tiles while window buffers still
remain empty.

The adapter records a buffer only for a failed native buffer allocation while
the official `isDialogPainting()` flag is true. After the original exported
[`vcl::Window::PaintToDevice`](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/vcl/source/window/paint.cxx)
finishes on that exact device, it performs the same native bitmap readback as
document tiles: `OutputDevice::GetBitmap` followed by
[`vcl::bitmap::fillWithData`](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/vcl/source/bitmap/BitmapTools.cxx).
This reads the real Skia-backed output, rather than an unrelated desktop or HDC
snapshot. Buffer dimensions must match the actual returned bitmap. No alpha,
color or document content is fabricated or substituted.

The bitmap return storage stays opaque throughout. The pinned public
[`Bitmap` declaration](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/include/vcl/bitmap.hxx)
contains a 16-byte shared pointer, an 8-byte `MapMode` wrapper and a 16-byte `Size`;
the adapter reserves 40 aligned bytes. The vendor constructs that value through
the verified Windows x64 member-return ABI and destroys it through its own
exported destructor. The adapter never reads bitmap implementation fields.
`Point` and `Size` use the pinned public two-`tools::Long` value representation.

For native windows only, the failed allocation also reapplies the real method's
map setup with the scale multiplied by the official `getDPIScale()`. The original
call still runs first. This compensates for the Windows window entry point's
hard-coded scale of 1: native `DrawOutDev` then composes controls across the
requested physical buffer instead of leaving the lower/right area undrawn.
Document tile mapping is unaffected. Private runtime verification covered a
real Writer font dialog at 1× and 2×, native mouse switching of its tab, and
cancellation without changing the document. This does not establish coverage
for every dialog, control, native theme or scale factor.

## Verified native boundaries

All addresses below are public exports in the hash-bound core; their exact
instruction prefixes are checked in `office-kit-windows.cpp`.

| Export | RVA |
|---|---:|
| `VirtualDevice::SetOutputSizePixelScaleOffsetAndLOKBuffer` | `0x3004fa0` |
| `VirtualDevice::SetOutputSizePixel` | `0x3004c80` |
| `vcl::Window::PaintToDevice` | `0x2c904c0` |
| `OutputDevice::GetBitmap` | `0x2eb9fc0` |
| `OutputDevice::EnableMapMode` | `0x2ee89b0` |
| `Bitmap::GetSizePixel` | `0x3032bc0` |
| `Bitmap::~Bitmap` | `0x30324c0` |
| `vcl::bitmap::fillWithData` | `0x30796a0` |
| `comphelper::LibreOfficeKit::isDialogPainting` | `0x77f5c0` |
| `comphelper::LibreOfficeKit::getDPIScale` | `0x77f5e0` |

The window patch relocates only its verified five-byte register-push prefix.
A nearby relay permits a relative branch without copying the following relative
call. Executable trampolines are installed and restored only in the owned worker.
The two wrapper functions' trampoline calls are the only scopes exempted from
compiler CFG checks; other adapter calls retain CFG. Exported readback counters
are diagnostics and are not document capabilities.

The installation lifecycle is strictly before core initialization; removal is
after core destruction and the engine UI thread has joined. No public tool
accepts an address, hook or adapter path. Vendor files, document files and the
user's installed Office processes are never patched. Updates to the bundled
engine must supply a new verified build manifest or a source-built core fix.

The preferable upstream source change for a rebuilt core is the following
fallback in the original method after `SetSizeUsingBuffer` returns false:

```cpp
if (!bRet)
    bRet = SetOutputSizePixel(rNewSize, true, false);
```

A rebuilt Windows core should additionally give the window device the requested
DPI map scale and add the same Windows bitmap readback already used by
`doc_paintTile`. That can remove the worker-local window interposition.

The adapter is our source, compiled with MSVC as part of the Windows build. The
vendor LibreOffice runtime and its original license notices remain separate.

Input confirmation also uses the pinned core's public VCL static functions,
directly through the worker ABI, without adding another patch. Non-unipoll
LibreOfficeKit posts key, mouse and IME operations as native user events;
handling a key can enqueue another accelerator or callback-flush event.
Two UNO callback turns or an old `pendingInput=false` therefore do not prove
that those operations have executed. Before acknowledging input, the owned UI
thread drains `Application::Reschedule(true)` until the current queue is empty.
RPC reentry remains excluded, each invocation does not sleep and handles only
current events, and the outer drain has a two-second busy limit. The native
method restores the LOK document/view after nested dispatch. A busy drain is
reported without replaying input or changing document/edit-buffer flags.

The exact signatures and behavior are defined in the pinned official
[svapp.hxx](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/include/vcl/svapp.hxx),
[svapp.cxx](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/vcl/source/app/svapp.cxx)
and [lokhelper.cxx](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/sfx2/source/view/lokhelper.cxx).
The worker checks both the real main thread and system-loop mode before using
this fence. Explicit save barriers commit an active cell/Outliner once, then
confirm its actual native state; reading a snapshot never implicitly commits it.
