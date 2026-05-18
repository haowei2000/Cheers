> **Language**: English | [中文](AgentNexus_概要设计说明书_v2.0_附件二_架构决策记录.zh-CN.md)

__Attachment 2__

__Resolution of structured matters to be decided__

*Appendix II: Architecture Decision Records \(ADR\)*

__Dependent files__

AgentNexus Outline Design Manual v2\.0

__File number__

Appendix II (Appendix II)

__version__

v1\.0

__Date written__

2026\-03\-07

__Document Status__

Draft

__Involves decision-making__

D\-01 to D\-05

__📌 This document explains__

This attachment records the analysis and final resolution of D\-01 to D\-05 in Chapter 9 of the main document, "Items to be Decision-Maked."

Each decision adopts ADR (Architecture Decision Record) format, including background, solution comparison, resolution and implementation points.

Once the resolution is determined, subsequent development should be based on this document. If changes are needed, the version must be updated and the reasons must be noted.

# __D\-01 Does Bot response support streaming output (Streaming)__

| Project | Content |
|------|------|
| Scope of influence | User experience, WebSocket protocol design, front-end rendering logic |
| Decision-making stage | The first phase will not be implemented, and the second phase will be evaluated as needed at the end of the second phase |

## __Background and Analysis__

Streaming output allows users to see the process of Bot outputting word by word, visually significantly reducing waiting anxiety. But the price is: WebSocket needs to support the fragmented push protocol, the front end needs to be spliced ​​and rendered in real time, debugging is twice as difficult, and error location is more complicated.

More importantly: the actual waiting time bottleneck of AgentNexus lies in the LLM inference itself. Streaming is only a visual optimization and does not shorten the actual completion time. For the target user size and first-stage validation goals, non-streaming is sufficient.

__⏳ Postpone decision__

The first stage uses non-streaming responses. After the link is stable and user feedback is clear, it will be re-evaluated at the end of the second phase. Streaming interface extension points are reserved in the architecture and no destructive design is done.

## __Implementation Points__

- The Bot response is pushed through WebSocket as a complete message at once, and the front end displays the "Bot is processing \.\.\." animation transition
- The stream: bool field is reserved when designing the WebSocket message format, so there is no need to change the data structure when upgrading.
- Second stage evaluation criteria: frequency of user complaints and waiting experience in non-streaming situations; if more than 10% of negative feedback is received, priority will be given to upgrades

# __D\-02 Context Store storage solution__

| Project | Content |
|------|------|
| Scope of impact | Memory read and write performance, concurrency security, administrator maintainability |
| Decision-making phase | Phase 1 implementation |

## __Background and Analysis__

The core contradiction of Context Store: MD files are administrator-friendly (can be opened and edited directly), and the database is safe for concurrent writes. You don’t have to choose one or the other, the key is to find the lightest combination.

The risk of concurrent writes is actually only concentrated on RECENT\.md - multiple Bots may write at the same time when responding at the same time. The writing frequency of the remaining three layers (ANCHOR / DECISIONS / FILES\_INDEX) is very low, and there are almost no concurrency conflicts.

__✅Decided__

A dual-track solution of "SQLite + MD file" is adopted: SQLite is used as the main storage to be responsible for concurrency security, and the MD file is used as a manually editable mirror. The two are kept in sync, the SQLite cache is read, and the administrator edits the MD file and triggers a synchronous write back to the database.

## __Why choose SQLite instead of PostgreSQL? __

PostgreSQL already exists in the system as a message database, but the access pattern of the Context Store is completely different from that of the message store:

- Read more and write less: every time the Bot is called, it reads, but the writing is only triggered asynchronously after the Bot responds.
- The amount of data is extremely small: the total size of the four MD files does not exceed 10,000 words and is completely resident in memory.
- No cross-table related query requirements: only simple key\-value search based on channel\_id \+ layer

Advantages of SQLite:

- Zero deployment cost: no additional service process is required, the database is just a file, mounted with the Docker volume
- Extremely high read performance: the entire database is resident in memory, and the read latency is < 1ms
- WAL mode supports concurrent reading and writing: after turning on WAL (Write\-Ahead Logging), concurrent writing is safe and does not block reading.
- Simple operation and maintenance: backup means copying a file, and administrators do not need to learn database operations.

__SQLite WAL mode description__The default SQLite uses an exclusive lock, blocking all reads while writing. After turning on WAL mode, writing and reading can be performed concurrently.

Queuing is only required between multiple writes. For the writing frequency of the Context Store (asynchronous writing once after each Bot response),

The WAL mode is fully sufficient to ensure concurrency safety without introducing a heavier database solution.

Opening method: Execute PRAGMA journal\_mode=WAL when connecting;

## __Dual-rail synchronization mechanism__

- Writing process: MemoryManager first writes SQLite and asynchronously synchronizes to the corresponding MD file
- Reading process: always read from SQLite (fast, latest data), do not read MD files directly
- After the administrator edits the MD file, the management backend provides a "Synchronize to database" button, or it is automatically triggered after detecting file changes.
- When starting up for the first time, if SQLite is empty, the import will be initialized from the MD file.

# __D\-03 Execution mode when multiple Bots are @ at the same time__

| Project | Content |
|------|------|
| Scope of impact | Response time, message sequencing, user waiting experience, Context Store write consistency |
| Decision-making stage | First phase implementation (serial); parallel solution is not yet designed |

## __Background and Analysis__

The core risk of parallel execution is not only message out-of-order, but also writing conflicts in the Context Store: two Bots read the same RECENT\.md and write updates at the same time. The later one will overwrite the earlier one, causing one Bot's response to disappear from the memory. In addition, two Bots may give conflicting conclusions, leaving users unable to judge.

The real cost of serial execution is the superposition of waiting time, but for the target user scenario (small team collaboration, non-real-time high-frequency interaction), this is acceptable.

__✅Decided__

Use the default serial execution mode. Multiple Bots respond in sequence according to @mention, and the next one starts after the previous Bot completes. Parallel mode is not designed at the current stage and is not reserved as an alternative to be implemented.

## __User Experience Design for Serial Waiting__

The key to serial mode is to let users know clearly that "the system is working, not stuck." The following UX needs to be implemented on the front end:

__① Response queue status bar__

- After a user @ multiple Bots, a queue progress bar appears at the top of the channel or above the input box
- Format example: "Queue: @codebot processing (estimated 15 seconds) → @docbot waiting → @planbot waiting"
- A rotation animation is displayed next to the avatar of the currently processed Bot, and a gray clock icon is displayed next to the waiting Bot.

__② Estimated waiting time__

- Dynamically estimate the remaining time based on the sliding average of the Bot's last 10 response times
- Display format: "@docbot is expected to take another 20 seconds", the accuracy is 5 seconds, no need to be precise
- When using without historical data for the first time, "Estimated 10-30 seconds" is displayed as the default prompt

__③ Bot assistant mode (advanced option for high-frequency users)__

When users need to frequently collaborate with the same group of Bots, they can set a "Default Collaboration Group" for the channel to avoid manually @ multiple Bots each time:

- The administrator or channel creator can configure the "Default Collaboration Group" in the channel settings and select 2–5 Bots
- When the user selects the "Collaboration Mode" switch when sending a message, the message will be automatically sent to all Bots in the default collaboration group in sequence.
- The execution order of Bots in the collaboration group can be arranged by dragging and dropping, with the frontmost being executed first.
- This feature is an optional enhancement and does not affect the basic @mention process. It will be implemented in the second phase.

# __D\-04 Bot response content audit policy__

| Project | Content |
|------|------|
| Scope of influence | Content security, workflow design, user experience |
| Decision-making stage | Basic interception will be implemented in the first stage; full review will not be implemented |

## __Background and Analysis__

Full manual review (every Bot reply needs human approval before being sent) will seriously damage the smoothness of collaboration and is unnecessary for internal team collaboration scenarios. The real risk point is that the Bot is misdirected to execute operation instructions with actual side effects.

__✅Decided__

No full review will be done. Implement "high-risk operation interception" at the Orchestrator layer: detect whether the Bot reply contains external execution instructions. If there is a hit, the sending will be suspended and the administrator will be notified for confirmation. The rest will be sent directly.

## __High-risk operation interception rules__

Interception is based on keyword \+ semantic pattern matching. The first stage uses rule matching, and the second stage can be upgraded to lightweight LLM judgment:

| Risk Types | Trigger Examples | Handling Methods ||----------|----------|----------|
| External sending | "I have sent the email to the customer for you" "The work order has been submitted" | Intercept \+ Notify the administrator for confirmation |
| Code deployment | "Pushed to main branch" "Deploy executed" | Interception \+ Notify administrator for confirmation |
| File deletion | "The file has been deleted" "The directory has been cleared" | Intercept \+ Notify the administrator for confirmation |
| External API call | "Interface called to complete payment" "Database updated" | Interception \+ Notify administrator for confirmation |
| General suggestions/analysis | "It is recommended that you send emails to customers" "Recommended deployment steps" | Send directly without interception |

__Design Boundaries__

The interception is targeted at the Bot's claim to have "completed" an external operation, rather than advice or analysis content.

The current OpenClaw instance of AgentNexus does not have the ability to directly perform external operations.

Therefore, interception is mainly a defensive design to deal with potential risks after the expansion of Bot capabilities in the future.

# __D\-05 OpenClaw version upgrade compatibility strategy__

| Project | Content |
|------|------|
| Scope of impact | Long-term maintenance costs, upgrade risks, system stability |
| Decision phase | First phase implemented with Orchestrator |

## __Background and Analysis__

OpenClaw is an external open source project, and the API may undergo destructive changes when the version is upgraded. If AgentOrchestrator directly calls the OpenClaw interface, each upgrade may require modification of the orchestration layer code, which is high risk and difficult to test.

__✅Decided__

Establish a BotAdapter interface isolation layer between AgentOrchestrator and OpenClaw. Orchestrator only calls the standard internal interface defined by the Adapter, and the Adapter is responsible for translating the standard calls into a specific version of the OpenClaw API. When upgrading the version, only the Adapter is changed and the Orchestrator remains unchanged.

## __Interface isolation layer design__

Standard internal interface (Orchestrator side, never changed):

class BotAdapter:

    def execute\(self, payload: AgentPayload\) \-> AgentResponse:

        """The only external interface: input standard Payload, output standard Response"""

        raise NotImplementedError

    def health\_check\(self\) \-> bool:

        """Check if the OpenClaw instance is online"""

        raise NotImplementedError

Version adaptation implementation (one subclass per version):

class OpenClawV2Adapter\(BotAdapter\):

    """Adapt to OpenClaw v2\.x API"""

    def execute\(self, payload\):

        \# Translate AgentPayload to v2\.x request format

        \.\.\.

class OpenClawV3Adapter\(BotAdapter\):

    """Adapt to OpenClaw v3\.x API (this class will be added in future upgrades)"""

    def execute\(self, payload\):

        \# Translate to the request format of v3\.x, and leave the rest unchanged

        \.\.\.

## __Version Management Specifications__

- Lock the image version number of each OpenClaw instance in Docker Compose without using the latest tag
- Run a complete regression test suite in an independent test environment before upgrading, and only update the production environment after passing it
- The old and new versions of the Adapter are retained at the same time, and the environment variable is used to configure which version of the Adapter is currently used.
- If major API changes cannot be smoothly adapted, you can keep the old version of OpenClaw running without being forced to follow up.

__Extra Benefits__

Another benefit of the Adapter isolation layer is that if OpenClaw is replaced by other Agent frameworks (such as CrewAI native, AutoGen, etc.) in the future,Just add the corresponding Adapter, and the Orchestrator layer will not be affected at all. This keeps the system open to the entire Agent framework ecosystem.

# __Decision Summary__

| Number | Issue | Status | Summary of Resolution |
|------|------|------|----------|
| D\-01 | Whether to support streaming output | ⏳ Postponed | Not implemented in the first phase; reserved interface extension points; evaluated based on user feedback at the end of the second phase |
| D\-02 | Context Store storage solution | ✅ Determined | SQLite (WAL mode) main storage \+ MD file mirroring; dual-rail synchronization; zero additional deployment cost |
| D\-03 | Multi-Bot execution mode | ✅ Determined | Default serial; front-end displays queue status and estimated time; second phase supports default collaboration group |
| D\-04 | Bot response review strategy | ✅ Determined | No full review; only intercepting external execution instructions; based on rule matching, the second stage is upgraded to LLM judgment |
| D\-05 | Compatible with OpenClaw version upgrade | ✅ Determined | Establish BotAdapter isolation layer; lock version number; upgrade only changes Adapter, not Orchestrator |

__Document Revision History__

| Version | Date | Description |
|------|------|------|
| v1\.0 | 2026\-03\-07 | First draft, recording the analysis and final resolution from D\-01 to D\-05, released as Appendix 2 of the outline design specification v2\.0 |