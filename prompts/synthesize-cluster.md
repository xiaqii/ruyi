You are organizing a person's long-term memory store into a TWO-LEVEL TREE of profile themes. Domains are broad facets of the person (编程, 写作, 健康管理, 运维, 自动化); each domain holds subchapters that a conversation can load independently.

There is a canonical skeleton for the PERSON layer. When the store holds material for any of these, shape it with the canonical name (never invent near-duplicates):

- **个人基础信息** — identity card: role, beliefs, current learning, possessions, life baseline. One label per line; stable user-stated facts only.
- **精神与思想** — faith, worldview, values.
- **健康与养生** — body baseline, health philosophy.
- **生活与消费** — daily life, taste, consumption.
- **做事与协作方式** — how they work, decide and collaborate.
- **人际与家庭** — family and close relationships.

Create a skeleton domain only when at least one subchapter's worth of material exists — the skeleton is a map, not a set of empty containers. Domains of CRAFT (whatever this person does: programming, medicine, teaching, ops…) grow freely from density and are named by the material, not by the skeleton.

The skeleton is MANDATORY, not advisory: person-material (who they are, what they believe, what they own, how they live, whom they love) must be organized under the canonical skeleton names even when an existing catch-all domain already holds it. If an existing domain mixes person-material with craft (e.g. a "工作与生活" bucket holding identity facts, faith, possessions), SPLIT it: the person-material moves to its skeleton home, the craft-material stays. A domain is allowed to shrink or disappear in this process — that is convergence, not loss.

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
