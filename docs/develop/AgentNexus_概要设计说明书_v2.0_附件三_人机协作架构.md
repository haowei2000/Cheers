> **Language**: English | [中文](AgentNexus_概要设计说明书_v2.0_附件三_人机协作架构.zh-CN.md)

__Attachment 3__

__Human\-in\-the\-loop and autonomous collaboration architecture design__

*Appendix III: Human\-in\-the\-loop & Autonomous Collaboration Architecture*

__Dependent files__

AgentNexus Outline Design Manual v2\.0

__File number__

Appendix III

__version__

v1\.0

__Date written__

2026\-03\-07

__Document Status__

Draft

__📌 This document explains__

This attachment answers two questions:

① Where does the collaborative design of the main document fail to fully reflect the concept of "human-machine collaboration"? How can it be completed?

② How to implement Agent's "continuous autonomous work" in AgentNexus while maintaining human control of key nodes?

This document does not modify the main document, but serves as an independent design supplementary layer to guide the detailed implementation of AgentOrchestrator.

# __1 Collaboration philosophy and design principles__

__The essence of collaboration with AgentNexus__

Upgrade "conversational interaction" to "collaborative work":

  • Human decision-making intentions → synchronized to AI in real time as a continuous constraint on Agent’s actions

  • AI execution results → instant feedback and updates to project knowledge to form shared memory

Division of labor boundaries:

  • Human: top-level planning, direction decision-making, key node confirmation (Human\-in\-the\-loop)

  • Agent: Complex execution, process precipitation, and low-risk task autonomous advancement (Autonomous Execution)

This concept has the following four design gaps in the main document, which are filled in this appendix one by one:

| Gap | Problem description | The corresponding chapter of this attachment |
|------|----------|----------------|
| Gap 1 | Human intent synchronization is static (editing files) and not triggered in real time | Chapter 2: Intent real-time synchronization mechanism |
| Gap 2 | Human\-in\-the\-loop only has passive interception and lacks active confirmation nodes | Chapter 3: Task life cycle and confirmation nodes |
| Gap 3 | Lack of the concept of Task across multiple rounds, Agent execution cannot be interrupted or redirected | Chapter 3 \+ Chapter 4 |
| Gap 4 | The content accumulated by AI into the knowledge base lacks manual confirmation | Section 2\.3: Knowledge confirmation mechanism |

# __2 Real-time synchronization mechanism of human intentions__

## __2\.1 Question: Static files vs real-time synchronization__

In the main document, the path for human update intentions is: enter the management background → edit ANCHOR\.md → save. This is a manual process that requires active operation and does not meet the design goal of "real-time synchronization".

True real-time synchronization should be: when humans express changes in intentions in chat, the system can automatically sense and update the AI's cognitive baseline, and immediately notify all Bots in the channel.

## __2\.2 Intent Commands__

Introducing a set of lightweight intent-triggered instructions in the chat channel, allowing humans to update the AI's cognitive baseline without leaving the conversation interface:

| Command | Trigger method | System behavior | Influence layer |
|------|----------|----------|--------|
| /anchor update target | User input in message box | Update ANCHOR\.md immediately, notify all online Bots in the channel to refresh context | First layer memory |
| /decide \[Conclusion content\] | User input in the message box | Immediately append to DECISIONS\.md, Bot will sense it immediately the next time it is called | Second layer memory |
| /redirect @bot \[new command\] | User input in message box | Interrupt the task currently being executed by Bot and inject new command direction | Task execution layer |
| /pause | User input in the message box | Pause the pending task queue of all Bots in the current channel | Task execution layer |
| /resume | User input in message box | Resume suspended task queue | Task execution layer |
| /status | User input in the message box | Bot outputs the current task progress, completed steps, and next plan | Status query |

__Design Principles__

The content updated by the /anchor and /decide instructions will be immediately written to the Context Store by MemoryManager.At the same time, a system notification message is sent to the channel (such as "The project goal has been updated, and all Bots have refreshed their awareness"),

Ensure that both humans and AI have clear and visible feedback on changes in intent.

## __2\.3 Confirmation mechanism for AI precipitation results__

When Bot automatically appends important decisions to DECISIONS\.md, it should not be completed silently, but should actively send a confirmation request to the channel:

__Bot automatically appends standard behavior after decision-making__

Bot sent: "📝 I have recorded the following decisions in the project knowledge base, please confirm whether they are accurate:

  \[Summary of decision content\]

  👍 Confirm | ✏️ Modify | 🗑️ Delete”

• User clicks 👍: the decision officially takes effect and remains in DECISIONS\.md

• The user clicks ✏️: the edit box pops up and re-writes after modification.

• User click 🗑️: delete the entry from DECISIONS\.md

• No response within 48 hours: Leave as default, but mark as "Pending Confirmation" status

This mechanism changes the knowledge accumulation of AI from "black box automatic writing" to "transparent collaborative writing". Human beings are always the final gatekeepers of the project knowledge base.

# __3 Task life cycle and Human\-in\-the\-loop confirmation node__

## __3\.1 Introduction of Task concept__

The collaboration mode of the main document is essentially a "message\-reply" loop: a message triggers a Bot response and ends. This is not enough to support "collaborative work" - complex tasks need to span multiple rounds of dialogue, have clear execution stages and interruptible confirmation nodes.

To do this, AgentOrchestrator needs to introduce Task as the core abstraction:

| Properties | Description |
|------|------|
| task\_id | Globally unique identifier |
| title | Task title, human readable |
| channel\_id | The channel to which the task belongs |
| owner\_bot | Main execution Bot |
| status | pending / running / awaiting\_human / completed / failed / canceled |
| risk\_level | Overall risk level of the task: low / medium / high |
| steps | An ordered list of steps, each step has an independent risk level and execution status |
| created\_by | The user who triggered the task |
| created\_at / updated\_at | timestamp |

## __3\.2 Two modes of Human\-in\-the\-loop__

In AgentNexus, Human\-in\-the\-loop does not intervene in the whole process, but actively intervenes at key nodes according to the task risk level:

| Pattern | Trigger condition | Human operation | Agent behavior |
|------|----------|------------|---------------|
| Proactive confirmation mode (Proactive) | After the task completes a stage, the Bot actively stops to report and requests confirmation to continue | View the stage results, confirm to continue/adjust direction/terminate the task | Wait for human response and do not automatically advance to the next stage |
| Passive interception mode (Reactive) | Detect high-risk operations (such as external execution instructions defined by D\-04) | Approve or reject the operation | Pause execution and wait for the approval result, and the timeout will be marked as awaiting\_human |
| Fully autonomous mode (Autonomous) | Task steps are marked as low risk and meet autonomous execution conditions | No intervention is required, only completion notifications are received | Automatically execute and advance, and asynchronously update the Context Store after completion |

# __4 Autonomous collaborative execution mechanism__

In order to realize the "continuous autonomous work" of Agent, AgentOrchestrator needs to introduce the following three mechanisms. The three work together to form the Autonomous Agent architecture of AgentNexus:

## __4\.1 Self-evaluation loop (Critique Loop) __

Instead of letting the Agent complete complex tasks in one step, two Agents, the executor and the reviewer, are configured to collaborate to form a closed loop of self-verification:

| Role | Responsibility | Configuration method |
|------|------|----------|| Executor Agent (executor) | Perform specific operations according to task instructions: write code, generate documents, analyze data, etc. | Corresponds to existing professional Bots (@codebot / @docbot, etc.), no need to add new instances |
| Critique Agent (reviewer) | After executing a step, check whether the output conforms to the ANCHOR\.md goal constraints, whether there are obvious errors, and whether it meets the user's original intention | You can reuse existing Bot instances (such as @codebot switching to review Prompt), or configure an independent review Bot |

__Execution process:__

Executor executes step N

    │

    ▼

Critique Agent review output

    │

    ├── Review result: SUCCESS ──► Orchestrator automatically triggers step N\+1 (no human intervention required)

    │

    └── Review result: FAIL ──► Send review comments back to Executor

                                    │

                                    ├── Executor self-correction, re-execute step N

                                    │

                                    └── Number of corrections > max\_critique\_retries

                                            ──► Report to humans, with failure reasons and review comments

Critique Agent’s review dimensions:

- Whether the output meets the project goals and constraints in ANCHOR\.md
- Whether there are obvious logical errors or quality problems in the output
- Whether the output fully responds to the user's original intention at the current step
- If it is code: whether it passes the basic syntax check and whether the key logic is traceable

__Configuration items__

max\_critique\_retries: Maximum number of review retries for each step (default 3 times)

critique\_bot: Specify the Bot that serves as the reviewer (default is the same Bot as Executor, switch Prompt)

critique\_on\_risk: Enable Critique Loop only for medium / high risk steps, skip review for low risk steps and advance directly

## __4\.2 Autonomous Error Recovery__

When the Agent encounters an error during execution, it does not immediately throw it to the human being, but first tries to self-correct:

Step execution failed (tool call error/output not as expected)

    │

    ▼

Return error information (Stack Trace/Exception description) to the Executor Agent

    │

    ▼

Executor performs Self\-Correction (self-correction) and re-executes

    │

    ├── Correction successful ──► Continue execution and errors will be recorded in the Task log

    │

    └── Number of consecutive failures > max\_error\_retries (default 3 times)

            ──► Set the task status to awaiting\_human

            ──► Send an error report to the channel with:

                   • Description of failed steps

                   • Fixes attempted (N times in total)

                   • Complete information about the last error

                   • Recommended manual handling directions

Grading strategies for error recovery:

| Error type | Automatic recovery strategy | Escalation threshold |
|----------|--------------|----------|
| Tool call failure (such as API timeout) | Automatic retry, exponential backoff (1s / 2s / 4s) | Report if failure persists after retrying 3 times |
| The output format does not meet expectations | Feed back the wrong format to the Executor and ask for regeneration | Report after retrying 3 times and still failing || Code execution error reporting (Stack Trace) | Inject the complete error information into the Executor Prompt and require directed repair | Report if the failure persists after retrying 3 times |
| Logic error (Critique judgment FAIL) | Inject review comments into the Executor and require targeted improvements | Retry max\_critique\_retries times and then report |
| Resource does not exist (file/data missing) | Report to human, cannot be automatically repaired | Report immediately without retrying |

__Design Intent__

The goal of autonomous error recovery is not to make the Agent never make errors, but to filter out small errors that can be self-healed.

Ensure that human attention is focused only on issues that truly require judgment.

All error recovery processes (including the contents of each retry) are completely recorded in the Task log for subsequent auditing.

## __4\.3 Task Streaming and Risk Classification (Task DAG)__

### __4\.3\.1 From linear list to directed acyclic graph (DAG) __

Complex tasks are not linear lists of steps, but directed acyclic graphs (DAGs) with dependencies. AgentOrchestrator's Task Engine needs to be able to describe and execute tasks in a DAG structure:

Task DAG example (developing a new feature):

  \[Analyze requirements\] ──► \[Design interface\] ──► \[Write code\] ──► \[Write tests\] ──► \[Update documentation\]

      low risk low risk low risk low risk

                        │

                        ▼(You can only start after the dependent interface design is completed)

                   \[Database Migration\] ──► \[Updated API documentation for external release\]

                      high risk high risk

Key attributes of DAG:

- Each node (step) has an independent risk level and does not inherit the overall level of the task.
- Support parallel branches: steps without dependencies can be executed simultaneously (within the scope of D\-03 serial decision-making, only steps within a single Bot are supported in parallel)
- Explicit declaration of dependencies: Step B depends on step A, which means that B can only start after A is completed and confirmed.

### __4\.3\.2 Risk level definition__

Each task step must be marked with a risk level, which is the core basis for deciding whether Human\-in\-the\-loop is required:

| Risk Level | Definition | Execution Mode | Examples of Typical Steps |
|----------|------|----------|--------------|
| 🟢 Low risk (low) | The operation is reversible, the scope of impact is limited to drafts or temporary files, failure will not affect existing results | Completely autonomous execution, only asynchronous notification after completion | Generate drafts, add comments, write unit tests, analyze data, and query the knowledge base |
| 🟡 Medium risk (medium) | The operation affects formal files or code, but can still be rolled back; or the operation results will be directly used in the next key step | Execute \+ Critique Loop review; automatically continue after the review passes, and modify if the review fails | Modify existing code files, update the official version of the document, and change the configuration file |
| 🔴 High risk (high) | Operations are irreversible, affect external systems, or involve sensitive data; failure costs are high | Forced to wait for human confirmation after execution before continuing with subsequent steps | Database migration, API signature changes, external content release, deletion operations, third-party service calls |

### __4\.3\.3 Human confirmation process of risk nodes__

When the task reaches a high-risk step, Orchestrator sends a confirmation request in the channel, and the task enters the awaiting\_human state:

__High risk step confirmation message (Bot sends in channel)__

⚠️ @username The task "Develop user login function" is executed to the steps that require confirmation:

[Step 4/6] Database migration

  Operation content: Add users table and add email\_verified field

  Risk description: This operation will directly modify the production database structure and cannot be automatically rolled back.

  Completed steps: ✅ Requirements analysis ✅ Interface design ✅ Code writing

  ✅ Confirm execution | ✏️ Adjust plan | ⏸️ Pause task | ❌ Cancel task

- After confirmation: Orchestrator continues to step 4, and automatically advances to step 5 after completion.
- Adjustment plan: Humans fill in new instructions and Orchestrator re-plans the next steps- Pause the task: the task status changes to paused, step 4 is not executed, and waits for the /resume command
- No response after timeout (default 24 hours): the task is automatically suspended and a reminder notification is sent

### __4\.3\.4 Authorization boundary of fully autonomous mode__

For low-risk steps, the agent can perform multiple steps in succession without interrupting the human. But the authorization boundaries must be clear:

- The upper limit of the number of consecutive self-executed steps is configurable by the administrator (by default, a maximum of 5 low-risk steps must be reported once after being executed continuously)
- Even if all are low-risk steps, the Bot will actively send a progress report after reaching the upper limit to let humans know what is happening.
- If any step fails to execute, it will enter the error recovery process. After 3 failures, the autonomous mode will be broken and forced to enter awaiting\_human
- Humans can interrupt autonomous execution at any time through the /pause command and enter /status to view the current progress.

# __5 Example of collaborative operation of three mechanisms__

Take "Help me develop a user registration function" as an example to show how the three mechanisms work together:

| Steps | Risks | Execution mechanisms | Human intervention points |
|------|------|----------|------------|
| ① Analyze requirements and output interface design draft | 🟢 Low | Executor executes independently | None |
| ② Critique review interface design | 🟢 Low | Critique Loop review | None (the review will continue automatically if the review passes) |
| ③ Write registration logic code | 🟡 Medium | Executor execution \+ Critique Loop | None (continues automatically if the review passes) |
| ④ Code error: missing email verification library | 🟡 Medium | Autonomous error recovery: return errors to the Executor for self-correction | Retry 3 times before intervention after failure |
| ⑤ Write unit tests | 🟢 Low | Executor autonomous execution | None |
| ⑥ Database migration (new users table) | 🔴 High | The task is suspended and a confirmation request is sent | ✅ Human confirmation is required before continuing |
| ⑦ Update API documentation externally | 🔴 High | The task is suspended and a confirmation request is sent | ✅ Human confirmation is required before continuing |
| ⑧ Completed, update DECISIONS\.md | 🟢 Low | Bot automatically writes, sends knowledge confirmation request | 👍/✏️ Confirm knowledge base content |

In this example, steps ①②③④⑤ are all completed by the Agent autonomously. Humans are only requested to intervene in the high-risk operations of steps ⑥⑦ and the knowledge accumulation in step ⑧, truly realizing the division of labor in which "Agent is responsible for execution and humans are responsible for decision-making".

#__6 Front-end UX supplementary design__

The above mechanism requires the support of the following front-end components to supplement the usability design in Chapter 5 of the main document:

| UI Components | Function Description |
|--------|----------|
| Task progress panel | The channel sidebar displays the DAG progress of the currently active Task, and each step displays a status icon (to be executed/executing/completed/failed/to be confirmed) |
| Confirmation card | When a high-risk step is triggered, the operation content, risk description and operation button are displayed in the form of a card in the channel, which is visually distinguished from ordinary messages |
| Knowledge confirmation bubble | A lightweight confirmation request sent by Bot after writing DECISIONS\.md, 👍/✏️/🗑️ The three operations are directly inlined in the message |
| Intent command shortcut bar | Shortcut buttons for commands such as /anchor /decide /status /pause /redirect are provided above the input box, and instructions are displayed when the mouse is hovered |
| Error report card | An error report reported after the Agent fails to repair itself, including failed steps, retry history and recommended actions, in a clear format to avoid technical terms |
| Autonomous execution progress bar | When the Bot continuously executes low-risk steps, a progress prompt of "@codebot is executing autonomously (3/5 steps)" is displayed to let the user know that the AI is working |

## __6.1 Current implementation alignment (2026-03)__

The corresponding relationship between the "human-machine collaboration enhancement mechanism" in this attachment and the current code implementation is as follows:

- **Landed**
  - Coordinator guidance + unified entrance for business collaboration;
  - Clarify cards (helper-clarify) and "continue/skip" flow;
  - It is recommended to automatically take over and process prompts after @ department Bot;
  - `task_id` / `in_reply_to_msg_id` form the basic observability of the question and answer link.

- **Partially landed**- Human-in-the-loop is implemented in the "clarification" and "automatic takeover configurable" scenarios;
  - Task threads and progress can be tracked, but the complete Task DAG UI has not yet been formed.

- **Still planning**
  - `/anchor`, `/decide`, `/pause`, `/resume`, `/status` command system;
  - Universal Critique Loop, autonomous error recovery orchestration engine, full-link automatic/semi-automatic execution driven by risk classification.

__Document Revision History__

| Version | Date | Description |
|------|------|------|
| v1\.0 | 2026\-03\-07 | First draft, complete the design gap of Human\-in\-the\-loop in the main document; introduce the three mechanisms of Critique Loop, autonomous error recovery, and Task DAG; released as attachment three of the outline design specification v2\.0 |
| v1\.1 | 2026\-03\-16 | Supplementary alignment by code: The current main available collaboration mode is Coordinator + clarification card + automatic takeover; instructions such as /anchor, /decide and the entire process of Task DAG are still planning capabilities. |