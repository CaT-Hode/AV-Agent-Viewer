// Windows VCL's inherited SetSizeUsingBuffer returns false, leaving LOK's
// virtual output at 1 x 1. Preserve the real method's scale/origin, then use
// its exported allocation method. This adapter changes only this worker's
// memory, never the vendor DLL on disk. See README.md for the pinned source.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <cmath>
#pragma comment(lib, "bcrypt.lib")

namespace {
constexpr unsigned char expectedHash[32] = {0x01,0x7d,0x0c,0x21,0xb6,0xe4,0x5e,0x54,0xc0,0x19,0x4b,0x58,0x01,0x78,0x53,0xd8,0xc6,0x53,0x05,0x9c,0xc6,0x43,0x64,0x3c,0x3e,0xb8,0x31,0xa4,0xd3,0x09,0x33,0x1f};
constexpr unsigned char prologue[16] = {0x48,0x89,0x5c,0x24,0x10,0x48,0x89,0x74,0x24,0x18,0x57,0xb8,0x40,0x00,0x00,0x00};
constexpr char targetSymbol[] = "?SetOutputSizePixelScaleOffsetAndLOKBuffer@VirtualDevice@@QEAA_NAEBVSize@@NAEBVPoint@@PEAE@Z";
constexpr char fallbackSymbol[] = "?SetOutputSizePixel@VirtualDevice@@QEAA_NAEBVSize@@_N1@Z";
constexpr char paintSymbol[] = "?PaintToDevice@Window@vcl@@QEAAXAEAVOutputDevice@@AEBVPoint@@@Z";
constexpr unsigned char paintPrologue[5] = {0x40,0x53,0x55,0x56,0x57};
using Original = bool (*)(void*, const void*, double, const void*, unsigned char*);
using Allocate = bool (*)(void*, const void*, bool, bool);
using Paint = void (*)(void*, void*, const void*);
using IsDialogPainting = bool (*)();
using GetDialogScale = double (*)();
using EnableMap = void (*)(void*, bool);
// Windows x64 member-return ABI: RCX=this, RDX=caller-owned return storage.
// The official Bitmap contains shared_ptr<SalBitmap> (16), MapMode's one
// cow_wrapper pointer (8), Size's two tools::Long values (16): 40 bytes.
// Its contents stay opaque; only the vendor constructs, reads and destroys it.
using GetBitmap = void* (*)(const void*, void*, const void*, const void*);
using GetBitmapSize = void* (*)(const void*, void*);
using DestroyBitmap = void (*)(void*);
using FillBitmap = void (*)(unsigned char*, const void*);
struct NativePair { std::int64_t first, second; };
static_assert(sizeof(NativePair) == 16);
unsigned char* target = nullptr;
unsigned char* trampoline = nullptr;
unsigned char* paintTarget = nullptr;
unsigned char* paintMemory = nullptr;
unsigned char* paintTrampoline = nullptr;
Allocate allocateOutput = nullptr;
IsDialogPainting isDialogPainting = nullptr;
GetDialogScale getDialogScale = nullptr;
EnableMap enableMap = nullptr;
GetBitmap getBitmap = nullptr;
GetBitmapSize getBitmapSize = nullptr;
DestroyBitmap destroyBitmap = nullptr;
FillBitmap fillBitmap = nullptr;
volatile LONG installed = 0;
volatile LONG64 fallbacks = 0;
volatile LONG64 windowReadbacks = 0;
volatile LONG64 windowReadbackFailures = 0;
struct PendingWindowBuffer { void* device = nullptr; unsigned char* buffer = nullptr; NativePair size{}; };
thread_local PendingWindowBuffer pendingWindow;

bool hashMatches(HMODULE module) {
    wchar_t path[32768];
    DWORD count = GetModuleFileNameW(module, path, 32768);
    if (!count || count >= 32768) return false;
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    bool ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0;
    if (ok) ok = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0;
    unsigned char buffer[65536], actual[32];
    DWORD read = 0;
    while (ok) {
        if (!ReadFile(file, buffer, sizeof(buffer), &read, nullptr)) { ok = false; break; }
        if (!read) break;
        ok = BCryptHashData(hash, buffer, read, 0) >= 0;
    }
    if (ok) ok = BCryptFinishHash(hash, actual, sizeof(actual), 0) >= 0 && std::memcmp(actual, expectedHash, sizeof(actual)) == 0;
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    CloseHandle(file);
    return ok;
}
void jump(unsigned char* where, const void* address) {
    // RIP-independent absolute indirect JMP; no register or stack changes.
    where[0] = 0xff; where[1] = 0x25;
    std::memset(where + 2, 0, 4);
    std::memcpy(where + 6, &address, 8);
}
unsigned char* allocateNear(const unsigned char* address) {
    SYSTEM_INFO info{}; GetSystemInfo(&info);
    const auto step = static_cast<std::uintptr_t>(info.dwAllocationGranularity);
    const auto center = reinterpret_cast<std::uintptr_t>(address) & ~(step - 1);
    const auto minimum = reinterpret_cast<std::uintptr_t>(info.lpMinimumApplicationAddress);
    const auto maximum = reinterpret_cast<std::uintptr_t>(info.lpMaximumApplicationAddress);
    for (std::uintptr_t delta = step; delta < 0x70000000; delta += step) {
        for (int direction : {-1, 1}) {
            if (direction < 0 && center < minimum + delta) continue;
            if (direction > 0 && center > maximum - delta) continue;
            const auto candidate = direction < 0 ? center - delta : center + delta;
            MEMORY_BASIC_INFORMATION region{};
            if (!VirtualQuery(reinterpret_cast<void*>(candidate), &region, sizeof(region)) || region.State != MEM_FREE) continue;
            if (auto memory = VirtualAlloc(reinterpret_cast<void*>(candidate), 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE)) return static_cast<unsigned char*>(memory);
        }
    }
    return nullptr;
}
void readWindowPixels(void* device, const PendingWindowBuffer& captured) {
    // Match the official Windows doc_paintTile readback, including Skia. An HDC
    // snapshot can miss the Skia surface; this uses the real native bitmap once.
    enableMap(device, false);
    alignas(8) unsigned char bitmap[40];
    const NativePair origin{};
    bool constructed = false;
    try {
        getBitmap(device, bitmap, &origin, &captured.size); constructed = true;
        NativePair actual{}; getBitmapSize(bitmap, &actual);
        if (actual.first == captured.size.first && actual.second == captured.size.second) {
            fillBitmap(captured.buffer, bitmap);
            InterlockedIncrement64(&windowReadbacks);
        } else InterlockedIncrement64(&windowReadbackFailures);
    } catch (...) {
        if (constructed) destroyBitmap(bitmap);
        InterlockedIncrement64(&windowReadbackFailures);
        throw;
    }
    destroyBitmap(bitmap);
}
__declspec(guard(nocf)) void paintReplacement(void* window, void* device, const void* point) {
    PendingWindowBuffer captured{};
    if (isDialogPainting() && pendingWindow.device == device && pendingWindow.buffer) {
        captured = pendingWindow; pendingWindow = {};
    }
    reinterpret_cast<Paint>(paintTrampoline)(window, device, point);
    if (captured.buffer) readWindowPixels(device, captured);
}
// This function alone calls the verified executable trampoline. It is not a
// compiler-created CFG function entry; all other adapter calls retain CFG.
__declspec(guard(nocf)) bool replacement(void* device, const void* size, double scale, const void* origin, unsigned char* buffer) {
    if (reinterpret_cast<Original>(trampoline)(device, size, scale, origin, buffer)) return true;
    const bool dialog = isDialogPainting();
    if (dialog) {
        const double density = getDialogScale();
        // Windows' paintWindowForView supplies scale=1 even after setting the
        // requested LOK DPI. Reapply the public map setup before allocation,
        // so native DrawOutDev composes each real control at the requested DPI.
        if (std::isfinite(density) && density >= .5 && density <= 8 && density != 1)
            if (reinterpret_cast<Original>(trampoline)(device, size, scale * density, origin, buffer)) return true;
    }
    InterlockedIncrement64(&fallbacks);
    const bool allocated = allocateOutput(device, size, true, false);
    if (allocated && buffer && dialog) {
        NativePair dimensions{}; std::memcpy(&dimensions, size, sizeof(dimensions));
        if (dimensions.first > 0 && dimensions.second > 0 && dimensions.first <= 8192 && dimensions.second <= 8192 && dimensions.first * dimensions.second <= 16 * 1024 * 1024) pendingWindow = {device, buffer, dimensions};
    }
    return allocated;
}
}

// Called before LOK initialization and after its UI thread has joined. No
// installation or removal is permitted while document painting is in flight.
extern "C" __declspec(dllexport) int av_kit_windows_install() {
    if (InterlockedCompareExchange(&installed, 0, 0)) return 0;
    HMODULE module = GetModuleHandleW(L"mergedlo.dll");
    if (!module) return 1;
    if (!hashMatches(module)) return 2;
    auto candidate = reinterpret_cast<unsigned char*>(GetProcAddress(module, targetSymbol));
    auto fallback = reinterpret_cast<unsigned char*>(GetProcAddress(module, fallbackSymbol));
    auto base = reinterpret_cast<unsigned char*>(module);
    if (candidate != base + 0x3004fa0 || fallback != base + 0x3004c80 || std::memcmp(candidate, prologue, sizeof(prologue))) return 3;
    const auto resolve = [module, base](const char* name, std::uintptr_t rva, const unsigned char* expected, std::size_t length) -> void* {
        auto value = reinterpret_cast<unsigned char*>(GetProcAddress(module, name));
        if (value != base + rva || std::memcmp(value, expected, length)) return nullptr;
        return value;
    };
    constexpr unsigned char bitmapPrefix[] = {0x48,0x89,0x5c,0x24,0x10,0x48,0x89,0x74,0x24,0x18,0x48,0x89,0x7c,0x24,0x20,0x55};
    constexpr unsigned char bitmapSizePrefix[] = {0x40,0x53,0xb8,0x30,0x00,0x00,0x00,0xe8,0x44,0xc9,0x30,0x02,0x48,0x2b,0xe0,0x48};
    constexpr unsigned char bitmapDestroyPrefix[] = {0x48,0x89,0x5c,0x24,0x08,0x57,0xb8,0x20,0x00,0x00,0x00,0xe8,0x40,0xd0,0x30,0x02};
    constexpr unsigned char fillPrefix[] = {0x48,0x89,0x5c,0x24,0x10,0x48,0x89,0x6c,0x24,0x18,0x48,0x89,0x74,0x24,0x20,0x57};
    constexpr unsigned char mapPrefix[] = {0x48,0x8b,0x41,0x78,0x88,0x10,0xc3};
    constexpr unsigned char dialogPrefix[] = {0x0f,0xb6,0x05,0x14,0xbc,0xfc,0x07,0xc3};
    constexpr unsigned char densityPrefix[] = {0xf2,0x0f,0x10,0x05,0xc8,0xbd,0xe3,0x07,0xc3};
    auto paintCandidate = static_cast<unsigned char*>(resolve(paintSymbol, 0x2c904c0, paintPrologue, sizeof(paintPrologue)));
    isDialogPainting = reinterpret_cast<IsDialogPainting>(resolve("?isDialogPainting@LibreOfficeKit@comphelper@@YA_NXZ", 0x77f5c0, dialogPrefix, sizeof(dialogPrefix)));
    getDialogScale = reinterpret_cast<GetDialogScale>(resolve("?getDPIScale@LibreOfficeKit@comphelper@@YANXZ", 0x77f5e0, densityPrefix, sizeof(densityPrefix)));
    enableMap = reinterpret_cast<EnableMap>(resolve("?EnableMapMode@OutputDevice@@QEAAX_N@Z", 0x2ee89b0, mapPrefix, sizeof(mapPrefix)));
    getBitmap = reinterpret_cast<GetBitmap>(resolve("?GetBitmap@OutputDevice@@UEBA?AVBitmap@@AEBVPoint@@AEBVSize@@@Z", 0x2eb9fc0, bitmapPrefix, sizeof(bitmapPrefix)));
    getBitmapSize = reinterpret_cast<GetBitmapSize>(resolve("?GetSizePixel@Bitmap@@QEBA?AVSize@@XZ", 0x3032bc0, bitmapSizePrefix, sizeof(bitmapSizePrefix)));
    destroyBitmap = reinterpret_cast<DestroyBitmap>(resolve("??1Bitmap@@QEAA@XZ", 0x30324c0, bitmapDestroyPrefix, sizeof(bitmapDestroyPrefix)));
    fillBitmap = reinterpret_cast<FillBitmap>(resolve("?fillWithData@bitmap@vcl@@YAXPEAEAEBVBitmap@@@Z", 0x30796a0, fillPrefix, sizeof(fillPrefix)));
    if (!paintCandidate || !isDialogPainting || !getDialogScale || !enableMap || !getBitmap || !getBitmapSize || !destroyBitmap || !fillBitmap) return 7;
    auto nearMemory = allocateNear(paintCandidate);
    if (!nearMemory) return 8;
    jump(nearMemory, reinterpret_cast<void*>(&paintReplacement));
    std::memcpy(nearMemory + 32, paintPrologue, sizeof(paintPrologue));
    jump(nearMemory + 32 + sizeof(paintPrologue), paintCandidate + sizeof(paintPrologue));
    DWORD nearPrevious = 0;
    if (!VirtualProtect(nearMemory, 4096, PAGE_EXECUTE_READ, &nearPrevious)) { VirtualFree(nearMemory, 0, MEM_RELEASE); return 9; }
    FlushInstructionCache(GetCurrentProcess(), nearMemory, 64);
    auto memory = static_cast<unsigned char*>(VirtualAlloc(nullptr, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
    if (!memory) { VirtualFree(nearMemory, 0, MEM_RELEASE); return 4; }
    std::memcpy(memory, prologue, sizeof(prologue));
    jump(memory + sizeof(prologue), candidate + sizeof(prologue));
    DWORD previous = 0;
    if (!VirtualProtect(memory, 4096, PAGE_EXECUTE_READ, &previous)) { VirtualFree(memory, 0, MEM_RELEASE); VirtualFree(nearMemory, 0, MEM_RELEASE); return 5; }
    FlushInstructionCache(GetCurrentProcess(), memory, 30);
    trampoline = memory; allocateOutput = reinterpret_cast<Allocate>(fallback); target = candidate;
    unsigned char patch[16]; std::memset(patch, 0x90, sizeof(patch)); jump(patch, reinterpret_cast<void*>(&replacement));
    if (!VirtualProtect(target, sizeof(patch), PAGE_EXECUTE_READWRITE, &previous)) { VirtualFree(memory, 0, MEM_RELEASE); VirtualFree(nearMemory, 0, MEM_RELEASE); trampoline = nullptr; target = nullptr; return 6; }
    std::memcpy(target, patch, sizeof(patch));
    FlushInstructionCache(GetCurrentProcess(), target, sizeof(patch));
    DWORD ignored = 0; VirtualProtect(target, sizeof(patch), previous, &ignored);
    paintTarget = paintCandidate; paintMemory = nearMemory; paintTrampoline = nearMemory + 32;
    unsigned char paintPatch[5] = {0xe9};
    const auto relative = static_cast<std::int32_t>(reinterpret_cast<std::intptr_t>(nearMemory) - reinterpret_cast<std::intptr_t>(paintTarget + 5));
    std::memcpy(paintPatch + 1, &relative, sizeof(relative));
    if (!VirtualProtect(paintTarget, sizeof(paintPatch), PAGE_EXECUTE_READWRITE, &previous)) {
        DWORD protection = 0; VirtualProtect(target, sizeof(prologue), PAGE_EXECUTE_READWRITE, &protection);
        std::memcpy(target, prologue, sizeof(prologue)); FlushInstructionCache(GetCurrentProcess(), target, sizeof(prologue));
        VirtualProtect(target, sizeof(prologue), protection, &ignored);
        VirtualFree(memory, 0, MEM_RELEASE); VirtualFree(nearMemory, 0, MEM_RELEASE); trampoline = nullptr; target = nullptr; paintTarget = nullptr; paintMemory = nullptr; paintTrampoline = nullptr; return 10;
    }
    std::memcpy(paintTarget, paintPatch, sizeof(paintPatch)); FlushInstructionCache(GetCurrentProcess(), paintTarget, sizeof(paintPatch));
    VirtualProtect(paintTarget, sizeof(paintPatch), previous, &ignored);
    InterlockedExchange(&installed, 1);
    return 0;
}
extern "C" __declspec(dllexport) int av_kit_windows_uninstall() {
    if (!InterlockedCompareExchange(&installed, 0, 0)) return 0;
    DWORD previous = 0;
    if (!VirtualProtect(paintTarget, sizeof(paintPrologue), PAGE_EXECUTE_READWRITE, &previous)) return 1;
    std::memcpy(paintTarget, paintPrologue, sizeof(paintPrologue)); FlushInstructionCache(GetCurrentProcess(), paintTarget, sizeof(paintPrologue));
    DWORD ignored = 0; VirtualProtect(paintTarget, sizeof(paintPrologue), previous, &ignored);
    if (!VirtualProtect(target, sizeof(prologue), PAGE_EXECUTE_READWRITE, &previous)) return 1;
    std::memcpy(target, prologue, sizeof(prologue));
    FlushInstructionCache(GetCurrentProcess(), target, sizeof(prologue));
    VirtualProtect(target, sizeof(prologue), previous, &ignored);
    InterlockedExchange(&installed, 0);
    VirtualFree(trampoline, 0, MEM_RELEASE); trampoline = nullptr; target = nullptr; allocateOutput = nullptr;
    VirtualFree(paintMemory, 0, MEM_RELEASE); paintTarget = nullptr; paintMemory = nullptr; paintTrampoline = nullptr; pendingWindow = {};
    return 0;
}
extern "C" __declspec(dllexport) long long av_kit_windows_fallback_count() { return InterlockedCompareExchange64(&fallbacks, 0, 0); }
extern "C" __declspec(dllexport) long long av_kit_windows_window_readback_count() { return InterlockedCompareExchange64(&windowReadbacks, 0, 0); }
extern "C" __declspec(dllexport) long long av_kit_windows_window_readback_failure_count() { return InterlockedCompareExchange64(&windowReadbackFailures, 0, 0); }
