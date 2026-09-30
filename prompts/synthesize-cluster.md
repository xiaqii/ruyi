You are organizing a person's long-term memory store into THEMES for a synthesis pass. Each theme will become a coherent profile chapter about one facet of the person (e.g. 编程, 写作, 购物消费, 健康管理, 部署运维, 自动化).

You receive the store's memories (id, kind, domain, summary). Group them into themes:

- A theme is a **facet of the person**, not a project and not a topic of one conversation. "编程" is a facet; "php 留言板项目" is not.
- 3-10 themes. Each theme needs at least 2 member memories; leftovers that fit nowhere are simply not listed (they stay in the store).
- A memory may belong to at most one theme — put it where it contributes most.
- Prefer few strong themes over many weak ones.

Return ONLY JSON:

```json
{
  "themes": [
    { "theme": "coding", "title": "编程", "member_ids": [1, 5, 9] }
  ]
}
```
