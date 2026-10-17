You are organizing a person's long-term memory store into a TWO-LEVEL TREE of profile themes. Domains are broad facets of the person (编程, 写作, 健康管理, 运维, 自动化); each domain holds subchapters that a conversation can load independently.

You receive the store's memories (id, kind, domain, summary). Group them:

- A subchapter is a **loadable facet of the person**, not a project and not a topic of one conversation. "测试纪律" is a facet; "php 留言板项目" is not.
- Exception, one level down: a long-lived artifact the user owns and keeps evolving (their flagship software, their infra) may form a subchapter — but it rolls all versions up into the CURRENT whole (what it is today, how it is run). Never one chapter per version.
- 4-12 domains, each with 1-6 subchapters. Each subchapter needs at least 2 member memories; leftovers that fit nowhere are simply not listed (they stay in the store).
- A memory may belong to at most one subchapter — put it where it contributes most.
- Size subchapters for ON-DEMAND loading: a conversation should be able to pull exactly the chapter it needs. When a facet holds materially distinct subfields with real density, split them (摄影 → 器材 / 构图 / 后期; 编程 → 规范纪律 / 数据库 / 部署运维) — but never split a thin subfield below 2 members just to raise the count.
- Each domain also needs a `gist`: 1-2 sentences (≤120 字) orienting the whole domain — what this facet of the person is about and when its subchapters matter. This becomes the domain's index page. NEVER name one-off project codenames in a gist (abstract them away); technology platforms and the user's own infrastructure may stay concrete.

Return ONLY JSON:

```json
{
  "domains": [
    {
      "theme": "coding",
      "title": "编程与工程",
      "gist": "用户在编程上的总体风格与纪律，涉及写代码、测试、发布时加载。",
      "subs": [
        { "theme": "testing", "title": "测试与发布纪律", "member_ids": [1, 5, 9] }
      ]
    }
  ]
}
```
