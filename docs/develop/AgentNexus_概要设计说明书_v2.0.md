> **Language**: English | [中文](AgentNexus_概要设计说明书_v2.0.zh-CN.md)

__AgentNexus__

__Zhishu Collaboration Platform__

*Preliminary Design Specification*

__Document version__

v2\.0

__Date written__

2026\-03\-07

__Document Status__

Draft

__System English name__

AgentNexus

__System Chinese name__

Zhishu human-machine collaboration platform

__Scope of application__

Product R&D Team/Technical Decision-Making Level

# __1 Project Overview__

## __1\.1 System naming and positioning__

This system is named AgentNexus (Intelligence Hub collaboration platform).

"AgentNexus" takes the meaning of the combination of "Agent (intelligent body)" and "Nexus (hub/connection core)", and the Chinese meaning is "Zhishu":

- Wisdom: the integration of artificial intelligence and human wisdom
- Hub: the core dispatch center where multiple agents and humans collaborate

The core value proposition of AgentNexus is to allow ordinary users with average technical skills to manage multiple AI expert Bots through the chat interface, just like managing a professional team, to jointly complete complex project tasks.

## __1\.2 Project background__

In the field of team collaboration, chat tools such as Slack and Mattermost have become work hubs. With the maturity of AI Agent technology (represented by OpenClaw and CrewAI), it has become technically feasible to seamlessly introduce multiple professional AI Agents into the chat collaboration process.

Existing pain points:

- The Bot access method of existing chat tools is single, multi-Bot collaboration lacks unified scheduling, and agents cannot sense each other's working status.
- AI Agent lacks item-level persistent memory, starts each conversation from scratch, and cannot maintain goal and context consistency.
- The system configuration threshold is high, making it difficult for administrators with non-technical backgrounds to independently deploy and manage AI Bots

OpenClaw is an open source autonomous AI Agent framework (released at the end of 2025) that can connect to mainstream large language models such as Claude, GPT, and DeepSeek, and perform autonomous tasks through the messaging platform interface. AgentNexus connects the OpenClaw instance to the chat channel as a Bot and builds a dedicated multi-Agent collaboration scheduling layer on top of it.

## __1\.3 Project Goals__

Core goals:

- Provides a Slack-like chat experience (channels, @mentions, file sharing), the bottom layer is self-developed with Python full stack, and does not rely on the Mattermost binary package
- Supports 2–15 specialized OpenClaw Agent instances to run concurrently, each Agent corresponding to a specific professional field
- Supports pulling multiple Bots into the same collaboration group (Channel), and Bots and human members collaborate to promote project tasks
- Design a four-layer memory system to ensure that all agents in the same project group share consistent context and target cognition
- For users with low computer capabilities: the front-end operation is extremely simple, and the administrator backend provides wizard-based configuration

Staged goals:

- The first stage: single Bot access, end-to-end link running, file reading available
- The second phase: multi-Bot collaboration, shared context, and task coordination mechanism online
- The third stage: automatic task scheduling of the main control Agent, structured communication between Bots

## __1\.4 Design Principles__

| Principles | Description |
|------|------|
| Refer to No Dependencies | Refer to Mattermost’s UX pattern and API design concepts to implement core functions from scratch in Python without introducing Go language dependencies |
| Minimum available subset | Only the chat functions (channels, messages, files, Bots) required to achieve the goals of this system, eliminating irrelevant modules such as video conferencing, billboards, and plug-in markets |
| Agent priority | The system architecture is designed around multi-Agent collaboration, and the chat platform is the stage for Agents to work, not ancillary functions |
| Memory persistence | All Agents share the structured memory of the same project group, and any Bot response is based on the project context |
| Ease of use first | The front-end UI is benchmarked against mainstream chat apps, and the management backend provides wizard-style guidance. The core functions can be used without reading the documentation |

# __2 Technology Selection__

## __2\.1 Core Technology Decision__

__Important Design Decision: Why not just build on Mattermost? __

Mattermost is a complete product written in Go and includes a large number of enterprise features (SAML, compliance archiving, Kanban boards, video conferencing, etc.) that are not related to the goals of this system.Forcing secondary development on its basis means maintaining a huge Go code base, the technology stack is fragmented (Go + Python), and the risk of destruction during upgrades is high.

This system refers to Mattermost's UX design pattern, WebSocket communication protocol format and REST API specification, and uses Python to re-implement a streamlined version of the chat core.

Focus on the three core capabilities of channel management, real-time messaging, and Bot access, and the rest will not be implemented.

## __2\.2 Technology stack summary__

| Components | Technology Selection | Reasons for Selection |
|------|----------|----------|
| Chat backend (self-developed) | Python \+ FastAPI \+ WebSocket | Unified with Agent framework language, good asynchronous performance, low maintenance cost |
| Front-end UI | React \+ Tailwind CSS | Refer to Mattermost/Slack interaction mode, component development, easy to customize |
| Agent framework | OpenClaw (\+ CrewAI collaboration concept) | OpenClaw is responsible for single-Agent execution, and CrewAI’s Crew/Task concept guides multi-Agent orchestration design |
| Agent orchestration layer | Python AgentOrchestrator (self-developed) | Refer to CrewAI’s role/task/process model to manage and control multi-Agent collaboration processes |
| Real-time communication | FastAPI WebSocket | Native support, no additional middleware required, sufficient target user scale |
| Message queue | Redis (lightweight deployment) | Bot response is asynchronous to prevent LLM waiting from blocking the user experience |
| Memory storage | PostgreSQL \+ structured MD file | Structured data is stored in PG, and context files use MD. The two work together to read and write efficiently |
| Vector retrieval (optional) | ChromaDB | On-demand block retrieval of very long documents, which does not need to be enabled initially |
| File conversion | mammoth \+ pymupdf \+ openpyxl | docx/pdf/xlsx to Markdown, the best combination of open source solutions |
| Container Orchestration | Docker Compose | One-click start and stop, suitable for the target user scale, with minimal complexity |
| Management backend | React Admin (self-developed wizard style) | For low-tech administrators, wizard-style configuration process |

# __3 Overall system architecture__

## __3\.1 Architecture level division__

AgentNexus is divided into six levels, from top to bottom:

| Hierarchy | Components | Core Responsibilities |
|------|------|----------|
| ① User interaction layer | React front-end (Web/mobile adaptive) | Message sending and receiving, file upload, Bot logo display, Markdown preview, @mention completion |
| ② Real-time communication layer | FastAPI WebSocket \+ REST API | Message broadcast, connection management, message persistence, file upload interface |
| ③ Agent orchestration layer | AgentOrchestrator (self-developed) | @Mentioned routing, task allocation, multi-Bot coordination, process control (sequential/parallel) |
| ④ Memory management layer | MemoryManager (self-developed) | Four-layer memory reading and writing, context splicing injection, memory summary compression |
| ⑤ Agent execution layer | OpenClaw instance × N | Connect to LLM, perform professional tasks, and return structured responses |
| ⑥ Data persistence layer | PostgreSQL \+ File storage \+ ChromaDB | Message history, file storage, Context Store, vector index |

## __3\.2 System data flow (text description)__

__Core message flow path__

① The user sends a message on the front end → WebSocket pushes it to the server

② ChatCore persists messages and broadcasts them to all online members of the channel

③ If the message contains @BotName, trigger AgentOrchestrator

④ Orchestrator loads the four-layer context of the channel from MemoryManager

⑤ Orchestrator constructs Payload (context \+ current message \+ attachment MD) and sends it to the corresponding OpenClaw instance

⑥ OpenClaw calls LLM to generate a response and returns it to Orchestrator⑦ Orchestrator broadcasts the response back to the channel through WebSocket as Bot

⑧ MemoryManager asynchronously updates the RECENT summary, and writes important decisions into DECISIONS

## __3\.3 Reference relationship with Mattermost__

AgentNexus refers to the following design concepts of Mattermost, but is completely self-developed and implemented in Python:

| Reference aspects | Mattermost original design | AgentNexus implementation |
|----------|-------------------|-----------------------|
| Channel model | Team > Channel > Message three-layer structure | Keep Channel as the core collaboration unit, remove the Team layer, and simplify it to Workspace > Channel |
| Bot Account | Independent Bot user account, with avatar and @mention name | Fully reserved, each OpenClaw instance corresponds to one Bot Account |
| Webhook mechanism | Outgoing/Incoming Webhook | Internalized as Orchestrator internal call, Webhook URL is not exposed to the outside world, more secure |
| WebSocket real-time messaging | Go native WebSocket implementation | FastAPI \+ websockets library reimplementation, interface format reference Mattermost |
| REST API format | Mattermost REST API v4 | Refer to its URL structure and response format to implement the core subset yourself |
| Permission system | Team/Channel/Role fine-grained permissions | Simplified to three roles: Admin/Member/BotManager, sufficient for the target user scale |

# __4 Core module design__

## __4\.1 ChatCore__

ChatCore is the chat infrastructure of AgentNexus, implemented in Python + FastAPI, and contains only the minimum feature set required by this system.

### __4\.1\.1 Function scope__

| Function module | Description | Whether to implement |
|----------|------|----------|
| Channel | Create/manage collaboration groups, support public and private channels | ✅ Implementation |
| Real-time messaging | WebSocket broadcast, support Markdown rendering | ✅ Implementation |
| @Mention | @User and @Bot auto-completion and notification | ✅ Implementation |
| File upload and preview | Upload files and preview MD conversion results on the front end | ✅ Implementation |
| Bot Account Management | Bot user registration, avatar, online status | ✅ Implementation |
| Message history loading | Scroll loading of historical messages, page turning without lag | ✅ Implementation |
| Message search | Full text search of channel messages and file contents | ✅ Implementation (Basic version) |
| Video/Audio Calls | Out of Target | ❌ Not Fulfilled |
| Kanban/Task Management | Out of Target | ❌ Not Achieved |
| Plug-in/Application Market | Beyond target scope | ❌ Not implemented |
| Enterprise Compliance Archiving | Out of Target | ❌ Not Achieved |

## __4\.2 Agent orchestration framework (AgentOrchestrator)__

AgentOrchestrator is the core self-developed component of AgentNexus. It deeply refers to the Crew/Role/Task/Process concept of CrewAI and is customized and designed based on the chat scene of this system.

### __4\.2\.1 Core Concept Model__

| Concept | Corresponds to CrewAI concept | Meaning in AgentNexus |
|------|-------------------|--------------------------|
| Crew (collaboration group) | Crew | A collection of all Bots activated in a Channel that jointly serve the project goals of the channel |
| Agent | Agent | Each OpenClaw instance has a role (Role), goal (Goal), and background (Backstory) || Task | Task | A user's @mention trigger, including input message, expected output format, and context |
| Process (execution mode) | Process | Sequential (sequential) or Parallel (parallel), control the response mode when multiple Bots are @ at the same time |
| Coordinator | Manager Agent | Optional master Bot, responsible for task dismantling and result summary (third stage function) |

### __4\.2\.2 Message routing logic__

Phase 1: Explicit @mention mode (safest, debugging friendly)

def route\_message\(message\):

    mentioned\_bots = extract\_mentions\(message\.text\) \# Parse @BotName

    if not mentioned\_bots: return \# No @mention, silently ignored

    active\_bots = channel\_crew\[message\.channel\_id\] \# Bots that have been activated in this channel

    targets = \[b for b in mentioned\_bots if b in active\_bots\]

    context = memory\_manager\.load\(message\.channel\_id\) \# Load four layers of memory

    files\_md = file\_converter\.load\(message\.file\_ids\) \# Load attachment MD

    if len\(targets\) == 1 or process\_mode == 'parallel':

        for bot in targets: \# Parallel execution

            asyncio\.create\_task\(execute\_agent\(bot, message, context, files\_md\)\)

    else: \# Execute sequentially (default, avoid message disorder)

        for bot in targets:

            await execute\_agent\(bot, message, context, files\_md\)

The third stage: Coordinator automatic scheduling mode (advanced function)

- Users only need @Coordinator, and the master Bot will automatically analyze tasks and decide which professional Bots to call.
- The main control Bot collects the output of various professional Bots, summarizes or reprocesses them, and then replies uniformly
- The master Bot records the division of tasks and the contributions of each Bot in the Context Store for subsequent tracing.

### __4\.2\.3 Bot role configuration (SOUL\.md)__

Each OpenClaw instance defines its professional roles through a SOUL\.md file, and AgentNexus reads this configuration when registering the bot:

__Bot example name__

__Role__

__Area of Expertise__

__Adapt LLM__

@codebot

Senior code review engineer

Code quality, architecture analysis, bug detection, PR review

Claude Sonnet

@docbot

Technical Documentation Expert

Information extraction, document writing, format specifications, Markdown output

Claude Haiku

@databot

data analyst

Data interpretation, chart suggestions, Excel/CSV analysis, report generation

GPT\-4o

@planbot

project planning consultant

Task decomposition, prioritization, risk identification, milestone planning

Claude Sonnet

@searchbot

Knowledge retrieval expert

RAG search, knowledge base Q&A, information aggregation

DeepSeek

@Coordinator

Task Coordination Master (Phase 3)

Task analysis, Bot scheduling, result summary

Claude Opus

## __4\.3 Four-layer memory system (MemoryManager)__

This is the core design of AgentNexus to ensure "multi-Agent context consistency and goal alignment". Referring to the memory hierarchical model of cognitive psychology, four independent layers of memory structures are established for each collaboration channel.

__Design Core Idea__Before each OpenClaw instance is called, MemoryManager automatically splices four layers of memory into System Prompt prefix injection.

This means that even if there is no direct communication between different Bot instances, they can still get a consistent view of the project through the shared Context Store.

This is the "cognitive glue" of the entire multi-agent collaboration solution.

__memory layer__

__Files/Storage__

__Content__

__Update method__

__Maximum size__

Level 1: Project Anchors
(long term memory)

ANCHOR\.md

Core goals, key commitments, team member responsibilities, and important constraints of the project/channel

Administrator maintains manually, or triggers Bot to generate summary

About 1500 words

Second level: decision record
(episodic memory)

DECISIONS\.md

Important decision records (including timestamp, decision-maker, basis, conclusion)

Bot automatically adds important conclusions and can be edited and corrected manually.

About 3000 words

The third level: data index
(external memory)

FILES\_INDEX\.md

Summary index of uploaded files (file name + core content 3 sentences + uploader)

Automatically writes after file processing pipeline completes

No hard cap

Level 4: Recent developments
(working memory)

RECENT\.md (scroll)

Compressed summary of the last 50 messages, preserving key information density

Automatically compressed updates by lightweight LLM after each Bot interaction

Fixed about 1500 words

### __4\.3\.1 Context injection format__

system\_prompt = f"""

You are \{bot\.role\} and are collaborating on channel \{channel\.name\}.

==Project anchor point (highest priority, must be adhered to)==

\{ANCHOR\.md content\}

== Important decision records ==

\{DECISIONS\.md content\}

== Uploaded data index ==

\{FILES\_INDEX\.md content\}

== Recent channel updates ==

\{RECENT\.md content\}

"""

### __4\.3\.2 Target alignment mechanism__

To prevent the Bot from deviating from the project goals after multiple conversations, the following alignment mechanism is designed:

- ANCHOR\.md is placed at the highest priority position in System Prompt and is highlighted.
- After each Bot responds, MemoryManager compares the response content with the target consistency of ANCHOR\.md, and issues a warning if the deviation is too large.
- Administrators can update ANCHOR\.md at any time, and the updated content will take effect immediately the next time the Bot is called.
- When DECISIONS\.md is automatically appended, MemoryManager will check whether the new decision conflicts with existing records, and if it conflicts, a conflict prompt will be generated.

## __4\.4 File Processing Pipeline (FileProcessor)__

__File format__

__Processing Tools__

__Special Instructions__

\.txt / \.md

Use directly

No conversion required, read directly

\.docx

mammoth library

Retain titles, lists, and table structures for the best conversion quality

\.pdf

pymupdf(fitz)

Extract text and tables; image pages call Vision API to generate descriptions

\.xlsx / \.csv

openpyxl/pandas

Convert to Markdown table; large tables automatically intercept key summaries

\.png / \.jpg

Claude Vision / GPT\-4o Vision

Generate a text description of the image content and save it as Markdown

\.mp4 (video)

ffmpeg frame extraction \+ Vision

Extract frames according to time intervals and generate timeline description Markdown

Very long documents (>30,000 words)

LlamaIndex / Handwriting Blocking

Block vectorization is stored in ChromaDB, and relevant blocks are retrieved before responding.

# __5 Usability design__

This chapter is specifically aimed at the design constraints of "users with low computer capabilities", and designs from two dimensions: front-end user experience and administrator background.

## __5\.1 Front-end user experience design__

### __5\.1\.1 Core interaction principles__

- Zero learning cost: The interface style is aligned with WeChat Group/Slack, and users who are familiar with chat software can get started without training.
- @mention guidance: When entering the @ symbol, a list of Bots will automatically pop up, displaying each Bot’s expertise description, allowing users to know who to @.- Bot status is visible: Bot online/offline/processing status is displayed in real time, and typing animation is displayed during processing to let users know that AI is working
- Clear response results: Bot responses are accompanied by role labels and expertise descriptions to distinguish responses from different Bots and avoid confusion.
- File upload feedback: After the file is uploaded, the processing progress is displayed (Converting → Ready), clearly informing the Bot when it can be read.

### __5\.1\.2 Key UI components__

__UI components__

__Function description__

__Ease of use considerations__

Bot select floating window

After entering @, a pop-up will appear, showing the Bot's avatar, name, expertise label, and current status.

Visually demonstrate what each Bot can do to avoid users being blind@

Contextual summary panel

The right column of the channel displays the current ANCHOR\.md and DECISIONS\.md summaries

Let users know what information AI has remembered at any time and increase their trust.

Task progress bubble

After the Bot receives the task, it displays the "Processing\.\.\." bubble and disappears after it is completed.

Reduce waiting anxiety, users clearly know that the system is responding

File preview inline

Uploaded MD/PDF/docx can be previewed inline without downloading

Reduce operating steps and provide a smooth experience

Pull in Bot with one click

Click Bot in the channel member list to add it to the current channel

Replaces complex configuration steps

Memory editing entrance

The channel settings page provides a rich text editing entry for ANCHOR\.md

Non-technical users can modify project targets directly without touching the file system

## __5\.2 Administrator backend design__

The administrator backend follows the "wizard first" principle: all complex configuration operations are provided with step-by-step guidance, and users are not faced with blank forms or command lines.

### __5\.2\.1 Bot Add Wizard (5 steps to complete)__

1. Select the Bot type: select from the list of preset templates (code review/documentation/data analysis/customization)
2. Configure LLM: drop down to select Claude / GPT / DeepSeek, paste the API Key (there is an eye icon to show/hide), the system automatically verifies connectivity
3. Set role description: pre-fill SOUL\.md based on the template. Users can modify it directly in the text box without knowing the file format.
4. Test dialogue: built-in dialogue test box, send test messages to verify whether the Bot responds normally
5. Assign to channels: Select which channels to activate this Bot in the checkbox, and click Finish

### __5\.2\.2 System status monitoring (no professional knowledge required)__

- Home page dashboard: List of all Bot online statuses, green = normal, orange = high load, red = offline, click to view details
- Today's statistics card: each Bot's response times today, average response time, user satisfaction (👍/👎 feedback statistics)
- Friendly display of error logs: technical error messages are converted into human-readable text (such as "codebot made an error while processing the message, it is recommended to check whether the API Key is valid")
- One-click restart: When the Bot encounters an exception, the administrator can click to restart directly on the interface without operating the command line.

### __5\.2\.3 Channel context management__

- ANCHOR\.md graphical editing: rich text editor, supports title/list/bold, automatically converted to Markdown after saving
- DECISIONS\.md visualization: Timeline view displays all decision records, supports search and manual addition
- FILES\_INDEX\.md preview: List displays all uploaded files and their summaries, supports deletion and reprocessing
- "Reset memory" function: Administrator can clear RECENT\.md or reset all, suitable for project phase switching

# __6 Data Model Design__

## __6\.1 Core Data Entity__

| Entity | Key Fields | Description |
|------|----------|------|
| Workspace | workspace\_id, name, created\_at | Top-level organizational unit, simplified from Mattermost's Team |
| Channel (channel/collaboration group) | channel\_id, workspace\_id, name, type\(public/private\), purpose | Core collaboration unit, corresponding to a project or topic |
| User | user\_id, username, display\_name, role\(admin/member/botmanager\), avatar\_url | Human user account || BotAccount (Bot account) | bot\_id, username, display\_name, specialty\_label, soul\_config\_path, openclaw\_endpoint, status | Each OpenClaw instance corresponds to one record |
| ChannelMembership | channel\_id, member\_id, member\_type\(user/bot\), joined\_at, added\_by | Channel membership, unified manager and Bot |
| Message | msg\_id, channel\_id, sender\_id, sender\_type, content, file\_ids\[\], mention\_bot\_ids\[\], created\_at | Unified storage of all messages |
| ContextStore (memory storage) | channel\_id, layer\(ANCHOR/DECISIONS/FILES\_INDEX/RECENT\), content, updated\_at, updated\_by | Four-layer memory database cache |
| FileRecord (file record) | file\_id, channel\_id, uploader\_id, original\_path, md\_path, status, summary\_3lines, converted\_at | File processing status tracking |
| AgentTask (task log) | task\_id, channel\_id, bot\_id, trigger\_msg\_id, response\_msg\_id, latency\_ms, token\_count, feedback | Bot response quality monitoring raw data |

## __6\.2 File storage structure__

data/

├── uploads/ \# Original upload file

│ └── \{channel\_id\}/\{file\_id\}\.\{ext\}

├── converted/ \# Converted MD file

│ └── \{channel\_id\}/\{file\_id\}\.md

├── context\_store/ \# Four-layer memory MD file

│ └── \{channel\_id\}/

│ ├── ANCHOR\.md \# First level: project anchor point

│ ├── DECISIONS\.md \# Second level: Decision record

│ ├── FILES\_INDEX\.md \# Third level: Data index

│ └── RECENT\.md \# Level 4: Recent developments

├── bot\_configs/ \# Bot SOUL\.md configuration file

│ └── \{bot\_id\}/SOUL\.md

└── vector\_index/ \# ChromaDB (large file, optional)

    └── \{channel\_id\}/

# __7 Key interface design__

## __7\.1 REST API core interface__

| Interface path | Method | Description |
|----------|------|------|
| /api/v1/channels | GET / POST | Get/create channel list |
| /api/v1/channels/\{id\}/messages | GET / POST | Get message history / Send message |
| /api/v1/channels/\{id\}/members | GET / POST / DELETE | Query/add/remove channel members (including Bot) |
| /api/v1/channels/\{id\}/context | GET / PUT | Read/update channel four-layer Context Store || /api/bots | GET / POST | Query/Register OpenClaw Bot instance |
| /api/bots/\{bot\_id\}/status | GET | Query the running status of Bot instance |
| /api/bots/\{bot\_id\}/test | POST | Send test message to verify Bot configuration |
| /api/v1/files/upload | POST | Upload files, trigger conversion pipeline |
| /api/v1/files/\{file\_id\}/status | GET | Query file conversion status |
| /ws/channels/\{id\} | WebSocket | Two-way push of real-time messages |

## __7\.2 AgentOrchestrator internal call Payload__

\{

  "task\_id": "uuid",

  "channel\_id": "ch\_abc123",

  "trigger\_message": \{

    "user": "Zhang San", "text": "@codebot help me review this code",

    "timestamp": "2026\-03\-07T10:30:00Z"

  \},

  "memory\_context": \{

    "anchor": "(ANCHOR\.md content)",

    "decisions": "(DECISIONS\.md content)",

    "files\_index": "(FILES\_INDEX\.md content)",

    "recent": "(RECENT\.md content)"

  \},

  "attachments": \[

    \{ "filename": "main\.py", "md\_content": "(MD content after conversion)" \}

  \],

  "process\_config": \{ "mode": "sequential", "timeout\_seconds": 120 \}

\}

# __8 Development Phase Planning__

## __8\.1 Three-Phase Roadmap__

| Phase | Time | Core Deliverables | Acceptance Criteria |
|------|------|------------|----------|
| Phase 1 (core link) | 5–7 weeks | Python ChatCore (channel\+WebSocket); single OpenClaw Bot access; basic file conversion to MD (txt/md/docx); @mention routing; four-layer memory structure establishment (manual maintenance); React front-end basic version; Docker Compose one-click deployment | Users can reply correctly in channel @bot; Bot after uploading docx Can read content; the front end can log in normally, send messages, and view history |
| Phase 2 (Multi-Agent collaboration) | 5–7 weeks | 3–5 professional Bots running simultaneously; MemoryManager automatic summary update; file type expansion (pdf/xlsx/picture); front-end Bot identification UI optimization; administrator back-end Bot addition wizard; context panel UI | 3 Bots in the same channel can be called by @ respectively, and are all aware of the project context; the administrator configures new Bots through the wizard without the need for a command line |
| The third stage (intelligent scheduling) | Continuous iteration | Coordinator masters Bot; structured communication protocol between Bots; automatic task decomposition and distribution; response quality monitoring dashboard; ChromaDB large file retrieval | User only @Coordinator, the master Bot automatically assigns tasks to professional Bots and summarizes the results |

## __8\.2 Technical Risks and Response__

| Risk | Level | Countermeasures |
|------|------|----------|
| Multiple Bots respond at the same time, causing messages to be out of order | High | The first stage strictly defaults to the serial (Sequential) mode, and the parallel mode is turned on by the administrator as an advanced option |
| Agent context "amnesia" (each call is independent) | High | Orchestrator forcibly injects four layers of Context Store before each call, and context persistence does not depend on the Agent itself || RECENT\.md Poor compression quality leads to information loss | High | Use proprietary lightweight LLM for summarization, retaining key decisions and @mentions; while retaining the last 20 original messages as supplements |
| OpenClaw API version upgrade destroys compatibility | Medium | Establish a BotAdapter interface isolation layer, only the Adapter is changed during version upgrade, and the Orchestrator is not affected |
| Large files exceed the LLM context window | Medium | ChromaDB block retrieval is automatically enabled if it exceeds 30,000 words. In the first stage, the upper limit of the file size can be set to prompt the user |
| The administrator configuration error causes the Bot to not respond | Medium | The management background configures real-time verification for each step. After the Bot registration is completed, it is forced to go through a test dialogue before it can be activated |
| Python ChatCore WebSocket has insufficient concurrency performance | Low | Target users ≤100 concurrency, FastAPI \+ uvicorn can fully support it; if it exceeds, introduce Redis Pub/Sub extension |

# __9 Non-functional requirements__

## __9\.1 Performance indicators__

| Indicator | Target value | Description |
|------|--------|------|
| Daily concurrent users | ≤ 100 people | Normal design baseline |
| Peak user support | ≤ 1000 people | System expansion upper limit |
| Message push latency (human messages) | < 200ms | WebSocket real-time messaging |
| Bot response startup delay | < 500ms | From the time the message is received to the time OpenClaw starts processing |
| Bot first word response (streaming) | < 3s | Depends on LLM service, system layer delay < 500ms |
| File to MD (< 10MB) | < 30s | Asynchronous processing, notifying the user after completion without blocking chat |
| Context Store loading time | < 100ms | Four-layer MD file reading \+ splicing |
| Manage background page loading | < 1s | React SPA, key pages |

## __9\.2 Security Requirements__

- The OpenClaw instance runs in a Docker container, is isolated from the ChatCore service network, and is only called internally through Orchestrator
- LLM API Key is stored in server environment variables or Docker Secret, and writing to code repositories and logs is prohibited
- User uploaded files undergo type whitelist verification (deny executable files) and ClamAV virus scanning
- Context Store does not store sensitive information such as user authentication credentials
- The administrator backend and user chat interface are deployed separately and have different access ports. It is recommended to add an access IP whitelist
- All HTTP interfaces enable HTTPS by default, WebSocket uses WSS

## __9\.3 Operability (for administrators with low technical skills)__

- All services are orchestrated through Docker Compose, providing start\.sh / stop\.sh / restart\.sh one-click scripts
- The management background system status page displays the health status of all services. In case of an exception, the cause of the error and recommended actions are described in Chinese.
- Provides a graphical log viewer that supports filtering by Bot and time range, without the need to operate the command line
- The database backup script works out of the box and supports exporting the entire data/ directory with one click.

# __10 Deployment Plan__

## __10\.1 Docker Compose service topology__

services:

  chat\-core: \# Python FastAPI chat core

  frontend: \# React front end (Nginx static service)

  admin\-panel: \# Management background (React \+ FastAPI)

  orchestrator: \# AgentOrchestrator orchestration layer

  memory\-manager: \# MemoryManager memory management layer

  file\-processor: \# File conversion service

  postgres: \# Primary database

  redis: \# message queue

  openclaw\-code: \# OpenClaw Code Professional Example

  openclaw\-doc: \# OpenClaw Document Professional Exampleopenclaw\-data: \# OpenClaw data analysis example

  \# \.\.\. Scaling more OpenClaw instances on demand

  chromadb: \# Vector database (optional)

networks:

  public: \# frontend, admin\-panel, chat\-core (external)

  internal: \# orchestrator ↔ openclaw instance (internal isolation)

  data: \# chat\-core ↔ postgres, redis (data layer)

## __10\.2 Minimize first-time deployment steps (for administrators with low technical skills) __

1. Install Docker Desktop (official one-click installation package link provided)
2. Download the AgentNexus installation package and extract it to any directory
3. Double-click start\.sh (Mac/Linux) or start\.bat (Windows)
4. Open http://localhost:3000，完成管理员账号注册 in the browser
5. Enter the management background and click the Bot Add Wizard to configure the first OpenClaw Bot.
6. Create the first channel, pull the Bot in, and start using it

# __11 Matters to be decided and follow-up work__

## __11\.1 Issues requiring further decision-making__

| Number | Issue | Scope of Impact | Current Recommendations |
|------|------|----------|----------|
| D\-01 | Does Bot response support streaming output (Streaming)? | User experience, front-end transformation | In the first stage, do non-streaming, verify the link and then upgrade. Streaming requires WebSocket sharding protocol |
| D\-02 | Should the Context Store be migrated to the database instead of the MD file? | Performance, reliability, concurrent writing | Initial MD file \+ database cache, migrate to PostgreSQL storage when concurrency is high |
| D\-03 | When multiple Bots are @ at the same time, do they default to serial or parallel? | Response time, message sorting | It is recommended to default to serial to avoid message disorder; the administrator can configure parallel by channel |
| D\-04 | Does Bot response content require manual review process? | Content security, workflow design | Audit queues can be added to external output scenarios; internal collaboration scenarios can be closed |
| D\-05 | RECENT\.md Which LLM is used for compression? | Cost, quality | It is recommended to use the cheapest model (such as Claude Haiku / GPT\-4o\-mini) to reduce costs |
| D\-06 | Does it support mobile native apps? | User coverage, development cost | Focus on Web adaptation in the early stage, and consider React Native code reuse after stabilization |

## __11\.2 Next step improvement plan for this document__

1. Complete the detailed design instructions (internal design of each module, database DDL, API interface detailed specifications)
2. Complete the front-end UI prototype design (chat interface, Bot selection floating window, context panel, management wizard)
3. Complete the first phase of technical verification (PoC): Python ChatCore \+ single OpenClaw instance end-to-end link
4. Revise the architectural assumptions in this document based on the PoC results, specifically WebSocket performance and memory injection latency
5. Prepare the "5-minute Quick Start Guide" and "Administrator Configuration Manual" for end users

# __12 Current implementation alignment (2026-03) __

To ensure that this outline design is consistent with the current code of the warehouse, the following alignment instructions are added:

- The built-in Bot system has converged into a unified `Coordinator` (`bot-helper-001`), and the user's main entrance has been unified into `@Coordinator`.
- The default main link for Bot execution is `LLMBotAdapter` (model + template); the OpenClaw HTTP/WS Adapter is reserved as an optional access capability.
- Added `auto_assist` to the channel model, which supports channel-level automatic takeover and collaboration triggering.
- Added SSE streaming interface (`/api/v1/channels/{channel_id}/messages/stream`) to the message link.
- The main file upload path is upgraded to pre-signed upload (`/api/v1/files/presign`), and the legacy upload interface continues to be compatible.- The storage architecture has a new abstraction layer (`StorageProvider`) that is compatible with S3 and supports object storage placement.
- Added workspace memberships and friend relationship API.
- MCP configuration import capability.
- Public knowledge/data platform access application API and A2A independent joining agreement are still in the design phase and have not been implemented as the default production path.

__Document Revision History__

| Version | Date | Description | Author |
|------|------|------|------|
| v1\.0 | 2026\-03\-07 | First draft, formed based on multiple rounds of demand discussions | — |
| v2\.0 | 2026\-03\-07 | The system is named AgentNexus; changed to Python self-developed ChatCore; deepens the multi-Agent collaboration framework; adds a four-layer memory system; adds a usability design chapter | Claude |
| v2\.1 | 2026\-03\-16 | Complete alignment revision based on code implementation: built-in Bots are unified into Coordinator; main link defaults to LLM Bot; SSE, object storage, workspace membership, image\_gen, MCP import and channel-level auto\_assist are added; it is clear that public platforms and A2A are still in the follow-up stage. | Maintenance updates |