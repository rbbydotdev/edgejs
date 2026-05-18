# `napi_allocator__`

Status: Current as of 2026-05-15.

`napi_allocator__` is the shared allocator used by the QuickJS N-API backend for
small pointer-shaped helper objects.

It lives in `napi/lib/src/napi_allocator.h`, with the intrusive link primitive
implemented header-only in `napi/lib/src/napi_intrinsic_link.h`. The allocator
is a blazing-fast free list implemented as linked slabs, perfect for small
JavaScript N-API wrapper objects that fly around. Each slab stores a fixed
number of slots, and allocation/deallocation are O(1) operations in Release
mode. The hot `allocate(...)` and `destroy(T *)` paths do not walk lists.

The allocator exposes only `T *` payload pointers. It has no public Handle type.
Ownership is recovered from a payload pointer by deriving the containing slot
and aligned block, then reading the block owner through `unsafe_owner(T *)`.
`owns(T *)` compares that owner with the allocator owner.

The allocator keeps three intrusive circular lists:

- `first_free_`: blocks where all slots are free.
- `first_partial_`: blocks with at least one free slot and at least one live
  slot.
- `first_used_`: blocks with all slots used.

Each block has exactly one allocator-list `link_`, and that link is present in
exactly one of those lists, except while `destroy(T *)` has put the block in
vacuum before running the payload destructor. Each block also has
`first_free_slot_` and `first_used_slot_` sentinels for its slot-local free and
used chains. Each slot has `free_link_` and `used_link_` intrusive links.

`allocate(...)` tries `first_partial_` first, then
`first_free_`, creating a new fixed-size block only when both are empty.
`destroy(T *)` remembers whether the block was linked when the call began,
unlinks the slot from the used chain, and unlinks a linked block before running
the payload destructor. It then records release, runs the destructor, and links
the slot back to the block free chain. If the call entered with the block
already in vacuum, it leaves the block in vacuum; the outer destroy that put the
block there owns the final relink. If this call put a linked block in vacuum, it
relinks the block to `first_free_`, `first_partial_`, or `first_used_` based on
the final slot state.

`take_used()` removes one live slot from `first_used_` or `first_partial_` and
returns the still-constructed payload pointer to the caller. Env teardown uses
`take_next_used()` for ref cleanup so finalizers can delete refs without
invalidating an iterator.

`begin()` / `end()` iterate active payloads by walking full blocks and partial
blocks, then following each block's `first_used_slot_` chain through slot
`used_link_` links. Aggregate queries such as `count_active()` and
`storage_slot_count()` intentionally walk lists; the hot allocate/destroy path
stays constant time.
