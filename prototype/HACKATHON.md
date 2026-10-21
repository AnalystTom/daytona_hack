# Daytona HackSprint w/ Arize AI — NYC, 16 Oct 2026

Sources: Luma https://luma.com/hacksprint-nyc · Notion hacker resources · Devpost https://daytona-hacksprint-nyc.devpost.com/

## Task
Build **AI agents** with sharp reasoning, independent decision-making and **safe** integration with industry-relevant tools.
Solo or a team of up to 4.

## Schedule (today, Fri 16 Oct; venue: AWS JFK27 Basement, 12 W 39th St, bring a physical ID)
- 10:00 hacking starts · 12:30 lunch
- **15:30 EDT: Devpost submission deadline (hard)**
- 16:00 finalists pitch (top 8): 3 min pitch + 2 min Q&A
- 16:45 awards

## Devpost submission (by 15:30)
- Team name (unique), all members with emails and socials
- **Public GitHub repo URL**
- Demo video under 2 min (strongly recommended, and round 1 is judged on Devpost alone)
- Description:
  - 2–3 sentence summary
  - Problem + impact
  - Technical architecture and components
  - **List of every sponsor tool and how it's integrated**

## Pitch (if we make the top 8)
- Slides: idea, advantages, **safeguards**
- Live demo: show that the agent works **safely** and delivers a real result

## Judging
- Impact 25% · Technical execution 25% · Creativity 25% · Presentation 25%
- Bonus: meaningful use of sponsor tools
- Round 1 = Devpost submissions → top 8 → round 2 = on stage → top 3
- Best Use prizes are picked by partners from **all** teams, not just finalists

## Prizes
- 1st: $3,000 + $10k Daytona + ElevenLabs Pro 3 mo/person + Arize AX Pro 1 yr + $10k Anchor
- 2nd: $1,000 + $5k Daytona + $5k Anchor · 3rd: $500 + $3k Daytona + $3k Anchor
- Best Daytona $1,000 + $10k credits · Best Arize $500 + AX Pro 1 yr · Best Anchor $500 + $5k
- Best SurrealDB $500 + $1k credits + swag · Best ElevenLabs: Scale 3 mo/person · AWS: 20 × $75

## Credits / access (redeem them NOW)
| Tool | How | Code |
|---|---|---|
| Daytona ($100) | app.daytona.io → Billing → Wallet → Redeem | `DAYTONA_NYC_HACK_RDPTPZ4U` |
| Arize AX Pro (3 mo) | app.arize.com → Settings → Billing → Pro → checkout | `HackSprintNYC26` |
| Anchor Browser ($200) | app.anchorbrowser.io → Billing → Starter → checkout (**card required**, total $0, redeem by 19 Oct) → API Keys | `ANCHOR_HACKSPRINT_10_16_26` |
| SurrealDB Agent Memory ($50) | studio.surrealdb.com → Billing → Redeem; then Agent Memory → Deploy new context | `HACKSPRINTNYC50` |
| ElevenLabs Creator (1 mo) | Discord https://discord.com/invite/VnBvbbcdEC → #coupon-codes → Start Redemption (use your registration email) | from the bot |
| AWS lab account | https://catalog.us-east-1.prod.workshops.aws/sign-in?redirect=%2Fjoin%3Faccess-code%3Deefd-0b40c3-db (OTP sent by email) | — |

Comms: Daytona Slack https://go.daytona.io/slack, channel #hacksprint-nyc-oct. Contact: marijan@daytona.io, 212-837-8024.

## Tech notes per sponsor
**Daytona**: sandboxes for running agent code. LLM docs: https://www.daytona.io/docs/llms-full.txt

**Anchor Browser**: cloud browser for agents. Recommended setup: the agent runs in a Daytona sandbox, Anchor runs the browser.
- `npm i anchorbrowser playwright-core` / `pip install anchorbrowser playwright`, env `ANCHORBROWSER_API_KEY`
- Natural-language task: `POST /v1/tools/perform-web-task {prompt,url}` (`client.agent.task`)
- Your own Playwright: `POST /v1/sessions` → `connectOverCDP(cdp_url)`
- HTML only: `POST /v1/tools/fetch/webpage` · repeatable workflows: `/v2/tasks/generate` → `/run`
- Don't log `cdp_url` (it contains the key); show `live_view_url` in the demo. Use one session per run and `DELETE /v1/sessions/{id}` when done
- captcha_solver/extra_stealth need `proxy.active: true`
- Guide: https://docs.anchorbrowser.io/integrations/sandboxes/daytona · MCP: https://docs.anchorbrowser.io/advanced/mcp

**Arize AX**: tracing, evals, experiments.
- Quickest: `npx evals` in the project directory (installs the CLI and skills, sets up tracing)
- Manual: `uv tool install arize-ax-cli`; `npx skills add Arize-ai/arize-skills --skill "*" --yes`
- env: `ARIZE_API_KEY`, `ARIZE_SPACE`, `ARIZE_SPACE_ID`, `ARIZE_DEFAULT_PROJECT`
- Loop: tracing → LLM-judge evaluator (e.g. completeness) → investigate failures → fix → baseline-vs-candidate experiment on a dataset
- Docs MCP: `claude mcp add arize-ax-docs --transport http https://arize.com/docs/mcp`

**SurrealDB Agent Memory**: they want typed, time-aware memory: facts that supersede old ones instead of overwriting them, retrieval traceable to its source, memory shared across several agents.
- Skill: sdb.li/skills · SDK: surrealdb.com/docs/agent-memory/reference · REST: surrealdb.com/docs/agent-memory/quickstarts/hosted
- Drop-in packages for Vercel AI SDK, LangGraph, OpenAI Agents SDK, Mastra and more: surrealdb.com/docs/agent-memory/integrations

**ElevenLabs**: voice (TTS/agents). Its only prize is Best Use.
