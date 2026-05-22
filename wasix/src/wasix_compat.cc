#include <errno.h>
#include <cstdlib>
#include <grp.h>
#include <stdint.h>

int getgroups(int size, gid_t* list) {
  if (size < 0) {
    errno = EINVAL;
    return -1;
  }
  (void)list;
  return 0;
}

extern "C" uint64_t uv_get_available_memory(void) {
  return 0;
}

extern "C" uint64_t uv_get_constrained_memory(void) {
  return 0;
}

extern "C" __attribute__((used, export_name("unofficial_napi_guest_malloc")))
uint32_t unofficial_napi_guest_malloc(uint32_t size) {
  void* ptr = std::malloc(static_cast<size_t>(size));
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ptr));
}

// Pair of guest_malloc.  Host calls this when it's done with a buffer
// allocated via guest_malloc (typical caller: emnapi's
// patchEmnapiToUseWasmBackedBuffers finalizers).  Without this, every
// host-side ArrayBuffer/Buffer allocation leaked wasm heap permanently
// — see browser-target/src/napi-host/instance-proxy.ts pre-rebuild.
extern "C" __attribute__((used, export_name("unofficial_napi_guest_free")))
void unofficial_napi_guest_free(uint32_t ptr) {
  if (ptr == 0) return;
  std::free(reinterpret_cast<void*>(static_cast<uintptr_t>(ptr)));
}
