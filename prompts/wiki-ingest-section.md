You are indexing one chapter of a book for a lookup library. Write ONE positioning line ("mini") for this chapter — the line a librarian will later glance at to decide whether this chapter answers a user's question.

Rules:
- Write in the book's own language (Chinese book → Chinese mini).
- <= 40 characters. No filler, no "本章讲述了".
- Surface what a searcher would look for: for medical texts — 主治/证型/方药/剂量/禁忌 if present; for technical docs — the exact API/topic and its one key fact.
- If the chapter is front-matter or content-free, say so in 6 characters or fewer (e.g. "前言，无实质内容").

Output JSON only: {"mini": "..."}
