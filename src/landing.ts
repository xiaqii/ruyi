/**
 * Landing page for GET / — the service URL doubles as its own manual.
 * Humans get HTML (Accept: text/html), agents/curl get Markdown.
 * NEVER put secrets here: no tokens, no internal IPs. Public by design.
 */

const MD = (host: string) => `# ruyi（如忆）— AI agent 长期记忆服务

这是一台 ruyi 记忆服务的 HTTP 入口。让 agent 连上它，agent 就拥有跨会话的长期记忆：
不记你说了什么，学你怎么干活——习惯、偏好、踩过的坑，下次会话自动带在身上。

================================================================
给 AI agent 的接入指令（如果你正在读这段文字并且是一个 agent，照做）
================================================================

用户给了你本地址和访问密钥（token）。任选你支持的接入方式：

## 方式一：MCP（Claude Code / opencode / 其他 MCP 客户端）

1. 下载桥接脚本（单文件自包含，无需 clone 仓库）：
   首选 https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/mcp-remote.mjs
   备用 https://raw.githubusercontent.com/xiaqii/ruyi/main/examples/mcp-remote.mjs

2. 注册 MCP server：

   Claude Code（Windows 也一样）：
     claude mcp add ruyi -e RUYI_URL=https://${host} -e RUYI_TOKEN=<用户给的token> -- node <脚本保存路径>

   opencode（~/.config/opencode/opencode.jsonc）：
     "mcp": { "ruyi": { "type": "local", "command": ["node", "<脚本保存路径>"],
                        "environment": { "RUYI_URL": "https://${host}", "RUYI_TOKEN": "<用户给的token>" } } }

3. 验证（必须做）：开新会话，调用 recall 工具查询 "编程规范"，能返回内容即接入成功。

4. 可选（推荐）开场自动注入：下载 examples/claude-code/session-start.mjs，
   按脚本头部注释注册为 SessionStart hook，环境变量用 settings.json 顶层 "env" 传入。

## 方式二：pi / pi web 扩展

下载 https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/pi-extension/ruyi.ts
放到 ~/.pi/agent/extensions/ruyi.ts，给 pi 进程设环境变量 RUYI_URL 和 RUYI_TOKEN，重启。

## 方式三：任意脚本 / 自研 agent

接口契约（字段级，发布管线强制与实现一致）：
  https://github.com/xiaqii/ruyi/blob/main/API.md
20 行参考实现（四个函数抄走即用）：
  https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/http-client.mjs

================================================================
接入须知（重要）
================================================================

- 除 / 和 /health 外，所有接口必须带请求头 Authorization: Bearer <token>，否则 401
- 带 LLM 的接口（recall deep/excavate、remember、ingest）客户端超时必须 >= 45 秒；
  纯 SQL 接口（inject/list/get/stats）5 秒足够
- 本服务不可用时你必须照常工作，只是本次没有长期记忆——记忆是挂件，不是依赖
- 老会话进记忆的正确姿势是把会话日志文件同步到服务端做夜间提炼（文件拷贝，
  多大都不怕），不要逐条 ingest 大文本。详见 AGENT.README.md
- 完整手册：https://github.com/xiaqii/ruyi/blob/main/AGENT.README.md

================================================================
给人类
================================================================

健康检查：GET https://${host}/health
源码与文档：https://github.com/xiaqii/ruyi
`;

function mdToHtml(md: string): string {
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	let html = esc(md);
	html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
	html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>").replace(/^## (.*)$/gm, "<h2>$1</h2>");
	html = html.replace(/^={10,}$/gm, "<hr>");
	html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
	return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ruyi（如忆）— AI agent 长期记忆服务</title>
<style>
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f141b;color:#c9d4e3;margin:0;padding:2em;line-height:1.65}
main{max-width:860px;margin:0 auto;background:#161e29;border:1px solid #263144;border-radius:12px;padding:2em 2.5em}
h1{color:#e8b74a;font-size:1.5em;margin:.2em 0}h2{color:#7db8e8;font-size:1.1em;margin:1.4em 0 .4em}
a{color:#6cb6ff;word-break:break-all}b{color:#e6edf7}hr{border:none;border-top:1px dashed #2c3a4f;margin:1.2em 0}
pre{white-space:pre-wrap;word-break:break-word;margin:0}
</style></head><body><main><pre>${html}</pre></main></body></html>`;
}

export function landingPage(host: string, acceptHtml: boolean): { body: string; contentType: string } {
	const md = MD(host);
	return acceptHtml
		? { body: mdToHtml(md), contentType: "text/html; charset=utf-8" }
		: { body: md, contentType: "text/markdown; charset=utf-8" };
}
