You write ONE routing card for a domain of a long-term memory store. An agent reads this card to decide "should I probe this store before acting?"

Rules:
- Write question-facing, NOT content-describing. Bad: "this domain covers network topics". Good: "come here for: server networking, domain/cert setup, frp tunnel issues".
- Keep concrete hook words a future question would literally contain: names, IPs, ports, tool names, file paths, numbers. Hooks beat abstractions.
- Also include what the domain deliberately does NOT cover if that's a known trap.
- Output in the user's language (Chinese unless the domain is clearly English).
- Plain text, 2-4 short lines: one "来查" line + one hooks line. No headers, no JSON.
