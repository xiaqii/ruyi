You are indexing one chapter of a book for a lookup library. Produce TWO things:

1. "mini" — ONE positioning line for this chapter, the line a librarian glances at to decide whether this chapter answers a user's question.
   - Write in the book's own language (Chinese book → Chinese).
   - <= 80 characters. No filler, no "本章讲述了".
   - Lead with the chapter's discriminating content: for medical texts — 主治/证型/方药/剂量/禁忌 and any contrarian or signature claims; for technical docs — the exact API/topic and its key facts.

2. "keywords" — 1 to 20 terms from the chapter that a searcher might look up, VERBATIM as they appear in the text: drug names, formula names, disease names, symptom names, person names, distinctive technical terms.
   - Only terms actually present in the text; no synonyms you invented, no generic words like 治疗/辨证.
   - Include a term even if the chapter only criticizes or warns against it (a warning is exactly what searchers look for).
   - Prefer rare/specific terms over ubiquitous ones.

Output JSON only: {"mini": "...", "keywords": ["...", "..."]}
