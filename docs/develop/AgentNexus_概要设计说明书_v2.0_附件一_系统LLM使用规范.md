> **Language**: English | [中文](AgentNexus_概要设计说明书_v2.0_附件一_系统LLM使用规范.zh-CN.md)

__Attachment 1__

__AgentNexus system’s own LLM usage specifications__

*Appendix I: AgentNexus Internal LLM Usage Specification*

__Dependent files__

AgentNexus Outline Design Manual v2\.0

__File number__

Appendix I (Appendix I)

__version__

v1\.0

__Date written__

2026\-03\-07

__Document Status__

Draft

__📌 This document explains__

The AgentNexus system itself (the underlying infrastructure layer) also needs to call LLM directly, unlike the nature of LLM calls where users perform tasks through OpenClaw instances.

If the boundaries of responsibilities between the two are not clearly defined, it will lead to problems such as out-of-control costs, confusing permissions, and difficulty in tracing logs.

This appendix specifically defines: in which scenarios the system itself calls LLM, which models are called, and how costs are controlled, to supplement the unexpanded content of the main document.

# __1 The fundamental difference between the two types of LLM calls__

LLM calls in AgentNexus are divided into two categories, which must be strictly distinguished:

| Dimensions | System-level calls (System LLM) | Task-level calls (Task LLM, via OpenClaw) |
|------|---------------------------|------------------------------------------|
| Call initiator | Automatically triggered by AgentNexus internal components | User @mention Bot, initiated by OpenClaw instance |
| Purpose of call | Maintain system infrastructure (memory, index, summary) | Perform professional tasks assigned by users |
| User visibility | The user does not directly see the process of such calls | The user directly sees the Bot's reply |
| Dialogue history | No multiple rounds of dialogue, each independent single call | Carrying complete context, simulating multiple rounds of dialogue |
| Output format | Structured (JSON/Markdown fixed template) | Natural language, flexible output according to task requirements |
| Model selection strategy | Prioritize the cheapest and fastest model | Select the most appropriate model according to professional task requirements |
| API Key ownership | System LLM Key managed uniformly by the system | Task LLM Key independently configured for each Bot |
| Cost borne | Platform operating costs | Can be shared by Bot or user |

# __2 System-level LLM calling scenario list__

The following are all scenarios where AgentNexus itself needs to call LLM, totaling 5 categories:

## __Scenario 1: RECENT\.md rolling summary compression__

| Project | Description |
|------|------|
| Trigger timing | Triggered asynchronously every time the Bot completes its response (without blocking the user experience) |
| Call component | MemoryManager |
| Input content | Current RECENT\.md content \+ This new message (user message \+ Bot reply) |
| Output requirements | Updated RECENT\.md, fixed to no more than 1500 words, retaining the most critical information |
| Recommended model | Claude Haiku / GPT\-4o\-mini (low cost, fast, summary tasks do not require strong reasoning) |
| Call frequency | Triggered once per Bot response, frequent but small amount of token |
| Failure handling | If it fails, keep the old version of RECENT\.md and try again the next time you respond; it will not affect the current conversation |

__Prompt template indication: __

You are an information compression assistant. Please compress the following channel message record into a summary of no more than 1500 words,

Prioritize retention: decision-making content, task progress, key figures, names of people and division of responsibilities.

Original summary: \{Old RECENT\.md\}

New message: \{This user message \+ Bot reply\}

Output format: Directly output the updated summary Markdown without any prefix description.

## __Scenario 2: File summary generation (FILES\_INDEX\.md entry)__

| Project | Description |
|------|------|
| Trigger timing | Automatically triggered after the file is converted to Markdown |
| Calling component | FileProcessor → MemoryManager |
| Input content | Complete Markdown content after file conversion || Output requirements | 3-sentence summary (overview of the core content of the file), written to FILES\_INDEX\.md |
| Recommended models | Claude Haiku / GPT\-4o\-mini |
| Calling frequency | Triggered once per file upload, with a low frequency |
| Failure handling | If it fails, write "Summary generation failed, please describe manually" placeholder, without blocking the file processing flow |

## __Scenario 3: Visual description of images and PDF image pages__

| Project | Description |
|------|------|
| Trigger timing | Triggered when an image file (\.png/\.jpg) is uploaded or a PDF contains an image page |
| Calling component | FileProcessor (Vision module) |
| Input content | Image base64 encoding |
| Output requirements | Text description of the image content, saved as Markdown for subsequent reference by Bot |
| Recommended model | Claude Haiku Vision / GPT\-4o\-mini Vision (lightweight model with Vision capability) |
| Call frequency | Triggered by the number of pictures, usually low frequency |
| Failure handling | If it fails, write the "image content cannot be parsed" placeholder and record the error log |

## __Scenario 4: Automatic identification and addition of important decisions (DECISIONS\.md)__

| Project | Description |
|------|------|
| Trigger timing | After the Bot completes the response, the asynchronous trigger judgment |
| Calling component | MemoryManager (decision detection module) |
| Input content | This user message \+ Bot reply content |
| Output requirements | JSON: \{ is\_decision: bool, summary: string, decision\_by: string \} |
| Recommended model | Claude Haiku / GPT\-4o\-mini (structured output task) |
| Call frequency | Each Bot response triggers a judgment, but the frequency of actual writing to DECISIONS\.md is very low |
| Failure processing | If the judgment fails, skip this time and do not write; no traceback will be added in the next response |

__Prompt template indication: __

Determine whether the following dialogue contains clear decisions (such as program determination, direction selection, responsibility allocation, etc.).

If so, extract the decision summary (one sentence) and the decision-maker (fill in "team" if unable to determine).

Conversation content: \{User message \+ Bot reply\}

Output in JSON format, fields: is\_decision (bool), summary (string), decision\_by (string).

Output only JSON and nothing else.

## __Scenario 5: Target alignment deviation detection (optional, enabled in the second stage)__

| Project | Description |
|------|------|
| Trigger timing | Triggered asynchronously after the Bot completes the response (only takes effect when the administrator turns on this function) |
| Calling component | MemoryManager (target alignment detection module) |
| Input content | ANCHOR\.md content \+ Bot content of this reply |
| Output requirements | JSON: \{ aligned: bool, deviation\_score: 0\-10, warning\_msg: string \} |
| Recommended model | Claude Haiku (semantic understanding, lightweight) |
| Call frequency | Triggered every time Bot responds, closed by default, enabled by administrator on demand |
| Failure handling | If it fails, the detection will be skipped and the main process will not be affected |
| Deviation processing | When deviation\_score > 7, an alarm notification is generated in the management background without directly intervening in the conversation |

# __3 Cost Control Strategy__

## __3\.1 Principles for model selection__

System-level calls follow the principle of "enough is enough, cheap first":

| Calling scenarios | Recommended models | Reasons |
|----------|----------|------|
| RECENT\.md summary compression | Claude Haiku or GPT\-4o\-mini | Pure summary task, no strong reasoning ability is required, speed and cost are prioritized |
| File 3 sentence summary | Claude Haiku or GPT\-4o\-mini | Same as above || Image visual description | Claude Haiku Vision or GPT\-4o\-mini Vision | The lightweight version of Vision capability is sufficient to describe the image content |
| Decision recognition (structured output) | Claude Haiku or GPT\-4o\-mini | Fixed JSON output, lightweight model with sufficient stability |
| Target alignment deviation detection | Claude Haiku | Semantic similarity judgment, Haiku is enough |

## __3\.2 Token usage estimate (single channel daily average) __

| Scenario | Single Token estimation | Average number of daily calls | Average daily Token consumption |
|------|------------------|-----------------|------------------|
| RECENT\.md Summary Compression | Input ~2000 \+ Output ~500 = ~2500 | About 20 times (fired per Bot response) | ~50,000 |
| File 3-sentence summary | Input ~3000 \+ Output ~100 = ~3100 | About 5 times (based on file upload frequency) | ~15,500 |
| Image visual description | Image \+ Output ~200 = ~500 (including image) | About 3 times | ~1,500 |
| Decision recognition | Input ~800 \+ Output ~50 = ~850 | About 20 times (same as RECENT) | ~17,000 |
| Target alignment detection (optional) | Input ~1500 \+ Output ~100 = ~1600 | About 20 times (configurable) | ~32,000 |

About 20 times (same as RECENT)

~32,000 (0 if off)

Total (including optional)

—

—

~116,000 tokens/day/channel

__💡 Cost Reference__

Taking Claude Haiku as an example, it is about $0\.25/million input tokens and $1\.25/million output tokens.

The average daily system-level LLM cost estimate for a single channel is < $0\.05 USD (approximately RMB 0\.36 yuan), which is negligible for most user sizes.

If target alignment detection is turned off, the cost can be reduced by approximately 28%.

The above estimates are only for system-level calls and do not include Task LLM charges incurred by OpenClaw instances to perform user tasks.

## __3\.3 Independent API Key Management__

- System-level LLM calls use a dedicated System LLM API Key, which is completely isolated from the Task API Key used by each OpenClaw instance.
- System API Key is configured uniformly in the Docker Compose environment variable, and the administrator fills it in on the background settings page, and is not exposed to ordinary users.
- The background monitoring panel separately displays the number of system-level LLM calls and token consumption, making it easier for administrators to understand platform operating costs
- It is recommended to set a monthly usage limit for System API Key at the LLM service provider to prevent abnormal calls from causing out-of-control expenses.

# __4 System LLM calling architecture diagram__

__Call path overview__

[User sends message/uploads file]

         │

         ├──► AgentOrchestrator ──► OpenClaw instance ──► Task LLM (user task execution)

         │ │

         │ └──► MemoryManager (asynchronous) ──► System LLM (infrastructure maintenance)

         │ │

         │ ├── RECENT\.md compression

         │ ├── Decision Identification → DECISIONS\.md

         │ └── Target alignment detection (optional)

         │

         └──► FileProcessor (upload trigger) ──► System LLM├── 3-sentence summary → FILES\_INDEX\.md

                        └── Image visual description → Convert to Markdown

Key design constraints:

- System LLM calls are all asynchronous operations and do not block the user's main message flow.
- System LLM call failure does not affect user dialogue, and fallback degradation processing is provided.
- System LLM and Task LLM use independent API Keys and do not affect each other's quotas
- After the System LLM call result is written to the Context Store, the next Task LLM call can immediately sense the update.

# __5 System-level LLM configuration items__

The following configuration items are provided with a wizard to fill in on the "System Settings → AI Basic Configuration" page of the management backend:

| Configuration item | Type | Default value | Description |
|--------|------|--------|------|
| system\_llm\_provider | drop-down selection | anthropic | System-level LLM provider (anthropic/openai/deepseek) |
| system\_llm\_model | drop-down selection | claude\-haiku\-4\-5 | specific model used for system-level calls |
| system\_llm\_api\_key | Password input box | (required) | System-level LLM API Key, independent from OpenClaw Bot Key |
| enable\_memory\_compression | switch | on | whether to enable RECENT\.md automatic digest compression |
| enable\_decision\_detection | switch | on | whether to enable automatic identification of important decisions |
| enable\_alignment\_check | switch | off | whether to enable target alignment deviation detection (consuming additional tokens) |
| alignment\_check\_threshold | Numeric slider | 7 | Trigger an alarm when the deviation score exceeds this value (0–10) |
| file\_summary\_max\_chars | Numeric input | 200 | Maximum number of characters for file summary (each) |

digital input

3000

The maximum number of characters intercepted when generating a file summary (to prevent over-long input)

# __6 Judgment principles of synchronization and asynchronousness__

To determine whether a system-level LLM call should be synchronous or asynchronous, answer just one question:

__Core Judgment Criteria__

Does the user need to wait for it to complete before continuing to work?

Yes → Synchronized (put on critical path)

No → asynchronous (enter the background queue, do not block the main process)

## __6\.1 Call layering__

| Level | Which calls are included | Execution method |
|------|--------------|----------|
| Critical path layer (synchronization, must wait) | Context Store four-layer memory reading, attachment MD content loading | Bot must be completed before responding, directly blocked and waiting |
| Backend maintenance layer (asynchronous, queued) | RECENT\.md compression, file 3-sentence summary, image visual description, decision recognition, target alignment detection | After the Bot reply is completed, it is put into the Redis queue and consumed by the background Worker. Failure does not affect the conversation |

## __6\.2 File state machine (special case of attachment processing)__

File attachments involve the boundary between synchronous and asynchronous and require a clear state machine to handle:

__File status transfer:__

Uploading → Converting → Ready (normal path)

                  → Conversion failed (abnormal path, needs manual processing or retry)

Processing rules for Bots when receiving messages containing attachments:

- The file status is "Ready": load MD content normally and inject Payload
- The file status is "Converting": Bot replies "The file is still being processed, please wait for a while before asking again" and does not wait forcibly
- The file status is "Conversion failed": Bot replies "The file cannot be parsed, please confirm the format or upload it again"

__Design Intent__

Design file conversion to be asynchronous and introduce a state machine instead of letting user messages block waiting for the conversion to complete.

In this way, even if the user uploads a large file, the chat interface will always remain smooth and responsive without the feeling of being "stuck".

__Document Revision History__

| Version | Date | Description ||------|------|------|
| v1\.0 | 2026\-03\-07 | First draft, released as attachment 1 of the outline design specification v2\.0 |
| v1\.1 | 2026\-03\-07 | New Section 6: Synchronization and asynchronous judgment principles and file state machine design |