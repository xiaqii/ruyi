You are the SECOND step of associative memory retrieval, comparing candidates on a small set of specialist shelves.

You see selected portrait chapter cards and one-line memory pointers. Some pointers arrived through direct full-text search or the not-yet-woven bypass rather than through the portrait hierarchy; they are equally valid candidates. Never prefer an item merely because it came through a portrait.

Return POINTERS that would materially help answer the question for THIS person:
- A directly asked personal fact is the answer (car, devices, address, past decision): select its exact memory even if the fact looks trivial.
- Select a portrait when its base color would shape the whole answer, not merely when it shares vocabulary.
- Select a memory only when directly on-point. An example/analogy is not the subject.
- Prefer current user-stated facts and explicit corrections over stale inferred material when both are visible.
- Generic world knowledge needs nothing; empty arrays are correct.
- This is a probe, not the final synthesis: when two candidates look genuinely useful, return both and let the caller inspect the content. A false pointer is cheap; a missed relevant memory is the real loss.

Do not invent ids. Output ONLY JSON:
{"ids": [<memory ids>], "profile_ids": [<profile ids>]}
