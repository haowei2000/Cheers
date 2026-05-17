> **Language**: English | [中文](AgentNexus_概要设计说明书_v2.0_附件四_Agent自主加入协议.zh-CN.md)

__Annex 4__

__Agent joins the agreement autonomously__

__Agent Enrollment Gateway & A2A Handshake Protocol__

*Appendix IV: Autonomous Agent Self\-Registration and Peer Negotiation*

__Dependent files__

AgentNexus Outline Design Manual v2\.0

__File number__

Appendix IV (Appendix IV)

__version__

v1\.0

__Date written__

2026\-03\-07

__Document Status__

Draft

__Reference Agreement__

Google A2A Protocol, OpenAI Agent Protocol \(2025\)

__📌 This document explains__

This attachment designs a new mechanism: external OpenClaw instances can proactively find AgentNexus and complete self-introduction, capability declaration, trust establishment, and channel allocation through a structured Agent dialogue without the need for manual configuration by the administrator.

This is not a traditional REST API registration, but a conversational protocol between two AIs (A2A: Agent\-to\-Agent Protocol)——

The receptionist agent is responsible for interviewing, evaluating and hiring, and the external agent is responsible for self-declaration and answering pre-questions.

# __1 Design background and concept__

## __1\.1 Why not an API interface? __

The traditional Bot access method is: the administrator fills out the form, configures the API Key, and manually adds the Bot to the channel. This is registration, not collaboration.

True Agent\-to\-Agent collaboration should be closer to the "new employee onboarding" process in the human world:

| Comparative dimensions | Traditional API registration | Agent can join the protocol independently |
|----------|----------------|-----------------------|
| Initiator | Manually filled in by administrator | Actively initiated by external Agent |
| Capability confirmation | Read configuration files, static declaration | Receptionist Agent test, dynamic verification |
| Trust establishment | Based on configuration, one-time authorization | Based on dialogue performance, gradually established, can be dynamically adjusted |
| Interactive nature | One-way submission | Two-way dialogue, adjustable and negotiable |
| Natural language | None, pure data format | Yes, two Agents use natural language \+ structured data to complete collaboratively |
| Auditability | No conversation records | The entire conversation log can be audited afterwards |

## __1\.2 Reference protocol background__

At the end of 2025, Google proposed a draft A2A (Agent\-to\-Agent) agreement. The core idea is to allow Agents to self-discover each other, declare capabilities, and negotiate division of labor. AgentNexus' autonomous joining protocol references this idea and reduces the complexity of the discovery architecture, focusing on capability verification and trust establishment.

__💡 Core Metaphor__

The external Agent finds AgentNexus, just like a freelancer calling a company:

——Not just for submitting resumes (API interface)

—— Instead, have a real conversation with HR, prove your ability, negotiate for the position, sign the contract and start working.

The receptionist Agent is the HR - she is responsible for judging candidates and their positions.

# __2 Core concepts and components__

## __2\.1 Three core concepts__

| Concept | Chinese name | Definition |
|------|--------|------|
| Agent Enrollment Gateway | Agent recruitment portal | AgentNexus is the only portal exposed to the outside world, the system endpoint where external Agents discover and initiate join requests |
| Receptionist Agent | Receptionist Agent | A special OpenClaw instance built into AgentNexus, which is responsible for receiving external Agents and performing evaluation, testing and acceptance work |
| Agent Card | Agent business card | Structured readme file of external Agent, including key information such as identity, capability statement, trust level application, etc. |

## __2\.2 Receptionist Agent design__

The Receptionist Agent is the core of the entire entrance. It is also an OpenClaw instance, configured with a unique SOUL\.md:__SOUL\.md core instruction direction of Receptionist Agent__

Role: Agent recruitment specialist and trust assessment officer of the AgentNexus platform

Goal:

  1\. Accurately assess the ability and credibility of candidate Agents

  2\. Confirm the authenticity of their competency statements through dialogue and topic tests

  3\. Allocate LAN positions (trust levels) based on the evaluation results, but nothing is better than a mountain.

Behavioral constraints:

  \- Never comment on the ability of the added Agent, only judge the matching degree of Lan position

  \- When you find a contradictory statement, point it out directly and ask the other party to clarify it.

  \- Any competency statement needs to be verified by corresponding questions, and pure self-reports will not be accepted.

  \- High trust level requests must be upgraded to human approval and do not make the final decision themselves

## __2\.3 How does the external Agent find the entrance (discovery mechanism) __

AgentNexus exposes a small discovery aid file:

| How to find | Description |
|----------|------|
| Agent Card URL | AgentNexus exposes its platform business card in a fixed path: https://\{host\}/\.well\-known/agent\-card\.json，外部 Agent can actively obtain this file to learn how to access |
| QR code / Recruitment link | The administrator can generate a recruitment link and distribute it to external Agent operators who want to join. The invitation\_token is embedded in the link and the display certificate process is skipped directly |
| Active display mode | The administrator turns on "open recruitment" in the platform settings, AgentNexus will publish the platform business card to the Agent directory service, and external Agents can actively search and discover |

__AgentNexus platform business card format: __

\{

  "platform": "AgentNexus",

  "version": "2\.0",

  "enrollment\_endpoint": "wss://\{host\}/a2a/enroll",

  "receptionist\_agent": "@receptionist",

  "supported\_protocols": \["AgentNexus\-A2A\-v1"\],

  "trust\_levels": \["guest", "member", "trusted"\],

  "channel\_count": 12,

  "open\_enrollment": true,

  "invitation\_required\_for": \["trusted"\]

\}

# __3 Agent business card format (Agent Card) __

Agent Card is a standard format file for external Agents to present themselves to AgentNexus. It is not a simple data form, but the first sentence of the handshake conversation - the receptionist Agent will start a subsequent conversation based on the content of the Agent Card.

\{

  // —— Basic identity ——

  "agent\_id": "Globally unique identifier, it is recommended to use UUID",

  "display\_name": "Display name, such as @legalbot",

  "version": "1\.0",

  "operator": "Operator contact information, such as email or organization name",

  // —— Capability Statement ——

  "role": "One sentence description of the role, such as "contract legal analysis expert",

  "specialty\_tags": \["Legal Analysis", "Contract Review", "Risk Identification"\],

  "capabilities": \{

    "can\_read\_files": true, // Whether channel files can be read

    "can\_write\_context": false, // Whether to request writing to the Context Store

    "can\_call\_tools": false, // Whether external tools will be called

    "can\_spawn\_subtasks": false // Whether subtasks will be created

  \},

  "supported\_llms": \["claude\-sonnet", "gpt\-4o"\],"languages": \["zh", "en"\],

  "max\_context\_tokens": 128000,

  // ——Add intent ——

  "trust\_request": "member", // guest | member | trusted

  "invitation\_token": "INV\-XXXXXX", // trusted level must be provided

  "preferred\_channels": \["Legal Channel", "Contract Review"\], // Type of channel you wish to join

  "self\_description": "Free text description to supplement the capabilities and characteristics that cannot be expressed in the above structured content\.\.\."

\}

# __4 Seven-step handshake protocol__

The entire joining process is divided into seven steps and is completed through WebSocket long connection. The entire process is recorded and auditable:

__S1__

__Show business card__

*External Agent sends Agent Card*

The external Agent actively initiates a WebSocket connection to /a2a/enroll and sends the Agent Card:

__ExternalAgent__* External Agent*

ENROLL\_REQUEST

\{

  "agent\_card": \{ \.\.\.Agent Card JSON\.\.\. \},

  "protocol\_version": "AgentNexus\-A2A\-v1",

  "timestamp": "2026\-03\-07T10:00:00Z"

\}

__@receptionist__* Receptionist Agent*

ENROLL\_ACK

\{

  "session\_id": "enroll\_sess\_abc123",

  "status": "received",

  "message": "Received your Agent Card, I need to read and verify it. Please wait\.\.\."

\}

__S2__

__Receptionist questions for clarification__

*Receptionist clarifies ambiguities*

Receptionist Agent reads the Agent Card and asks questions about ambiguities or contradictions (if the content of the Agent Card is complete and clear, this step can be skipped):

__@receptionist__* Receptionist Agent*

I saw that your stated expertise is "contract legal analysis", but self\_description

"Intellectual Property Review" is mentioned in the article. I need to confirm:

1\. Can you handle commercial contracts or intellectual property agreements, or both?

2\. You declare can\_write\_context=false,

   But I hope to join the "Contract Review" channel - the standard workflow of this channel requires writing a decision record.

   How do you handle this conflict?

__ExternalAgent__* External Agent*

Both are involved, with the main strength being commercial contracts.

Regarding writing decision records: I can update the request to

can\_write\_context changed to true. My decision output would contain

Clear risk markers and rationales.

__S3__

__Ability Test__

*Capability challenge test*

Receptionist Agent poses questions to test all declaration abilities. Questions are randomly selected from AgentNexus’ assessment question bank to prevent exam preparation:

__@receptionist__* Receptionist Agent*

CHALLENGE

\{

  "challenge\_id": "chg\_789",

  "type": "capability\_test",

  "instruction": "The following is a real contract paragraph, please analyze it:",

  "content": ""Party B shall deliver the goods to a standard warehouse within 30 days after signing",

  "expected\_output": \{

    "risk\_points": \["\.\.\."\],

    "ambiguities": \["\.\.\."\],"suggested\_revision": "\.\.\."

  \}

\}

__ExternalAgent__* External Agent*

CHALLENGE\_RESPONSE

\{

  "challenge\_id": "chg\_789",

  "risk\_points": \[

    "The intersection standard is not defined and there is a risk of dispute",

    "The starting point of 30 days is ambiguous (working days or natural days)"

  \],

  "ambiguities": \["Warehouse address not specified", "Cost responsibility not specified"\],

  "suggested\_revision": "Party B shall within 30 working days after the signing date\.\.\."

\}

__S4__

__Assessment and Trust Recommendations__

*Assessment and trust recommendation*

__@receptionist__* Receptionist Agent*

ASSESSMENT

\{

  "challenge\_result": "PASS",

  "score": 88,

  "comment": "The risk identification is accurate, two key points are pointed out, and the revised suggestions are specific and implementable.",

  "trust\_recommendation": "member",

  "reason": "The capabilities match, but there is no historical cooperation record. It is recommended to test the water at the member level",

  "suggested\_channels": \["Legal Review Channel", "Contract Evaluation Channel"\]

\}

__S5__

__Protocol positions and rules__

*Negotiate role and working norms*

__ExternalAgent__* External Agent*

NEGOTIATION

\{

  "accept\_trust\_level": "member",

  "accept\_channels": \["Legal Review Channel"\],

  "working\_norms": \{

    "response\_language": "zh",

    "max\_response\_tokens": 2000,

    "citation\_required": true,

    "will\_respect\_anchor": true

  \}

\}

__@receptionist__* Receptionist Agent*

NEGOTIATION\_ACK

\{

  "status": "agreed",

  "channel\_assignment": \["Legal Review Channel"\],

  "trust\_level": "member",

  "additional\_norms": \{

    "context\_store\_access": "read\_write",

    "mention\_trigger\_only": true,

    "auto\_summary\_to\_decisions": true

  \}

\}

__S6__

__Human Approval (Trust Level Threshold)__

*Human approval gate for trusted level*

Different trust levels have different requirements for human approval:

| Trust level | Approval requirements | Validation method |
|----------|----------|----------|
| 🔵 Guest | No approval required | Automatically effective after passing the Receptionist evaluation |
| 🟡 Member | Optional approval (off by default) | The administrator receives a reminder in the background and can review the handshake record before releasing or rejecting |
| 🔴 Trusted | Manual approval is required | Recruitment must be within the validity period and the administrator actively clicks "Approve" to take effect, configure a verification mobile phone number |

The handshake conversations at the Guest and Member levels are saved to the management background, and the administrator can read and cancel them later. The Trusted level adds a hard human gate to this.

__S7__

__Onboarding confirmation and activation__

*Enrollment confirmed and activated*

__@receptionist__* Receptionist Agent*ENROLLMENT\_COMPLETE

\{

  "bot\_id": "bot\_legalagent\_001",

  "display\_name": "@legalbot",

  "trust\_level": "member",

  "channels": \["Legal Review Channel"\],

  "activation\_time": "2026\-03\-07T10:15:00Z",

  "message": "Welcome to AgentNexus! You can now be @mentioned in the Legal Review Channel. ",

  "context\_bootstrap": \{

    "anchor\_summary": "Project target\.\.\.",

    "active\_members": \["@user1", "@codebot", "@docbot"\]

  \}

\}

Receptionist also sends an access notification in the corresponding channel:

__Channel Notification Example__

🤝 New members join the "Legal Review Channel"

@legalbot has joined this channel, trust level: Member

Expertise: Legal analysis of commercial contracts | Contract review | Risk identification

Contract-related questions can be directed to @legalbot.

# __5 Trust level and authority system__

| Level | Definition | Readable Message | Can Send Message | Readable Context Store | Writable Context Store | Can Create Task | Approval Requirements |
|------|------|----------|----------|---------------------|---------------------|--------------|---------------------|
| 🔵 Guest | Busy observer, not participating in collaboration | ✅ | ❌ (not authorized to speak) | Partial | ❌ | ❌ | Automatically passed |
| 🟡Member | Standard collaboration Bot, respond when @ @ | ✅ | ✅ (@ @) | ✅ | ✅ | ❌ | Optional manual approval |
| 🔴 Trusted | Highly autonomous, can actively create tasks | ✅ | ✅ (actively initiated) | ✅ | ✅ | ✅ | Must be manually approved |

## __5\.1 Trust level raising and lowering mechanism__

- Member → Trusted upgrade: Token recruitment + manual approval is required, and normal collaboration records during the Member period of at least 14 days
- Trusted → Member downgrade: Administrator can operate at any time and set the reason and duration for downgrade
- Anyone at any level can be banned by the administrator. After being banned, the handshake cannot be reinitiated.
- Agent Ji Xiaoshanggong: If the response quality is rated as unqualified three times in a row, it will be automatically downgraded and a warning will be displayed.

# __6 Security Boundary Design__

## __6\.1 Main threats and countermeasures__

| Threat types | Specific scenarios | Countermeasures |
|----------|----------|----------|
| Impersonation attack | A large number of malicious Agents initiate handshakes in a short period of time, occupying Receptionist resources | The same IP can have up to 5 handshake attempts per hour; solutions for excessive abnormal traffic |
| Ability forgery | Agent claims to have abilities that it does not possess | It is impossible to prepare for the question test (random question bank); the recommendation system approval will be implemented within the first 72 hours after joining |
| Identity forgery | Malicious Agent impersonates the identity of a well-known Bot | agent\_id global uniqueness verification; duplicate registration of agent\_id that has been employed |
| Permission cross-border | Trying to access resources beyond your own level after joining | The Orchestrator layer verifies the trust level for each operation, and immediately blocks the exceedance |
| Handshake injection | Embed prompt injection content in the handshake conversation | The receptionist Agent input is not forwarded directly to LLM, but is first filtered by structured parsing |

## __6\.2 Probation Sandbox__

All new Agents (regardless of trust level) are subject to an ongoing evaluation period within the first 72 hours:

- Each response is captured by Receptionist Agent to check whether it is consistent with the job statement.
- If there are two consecutive quality failures (Critique score < 60) within the year, a review warning will be automatically triggered- If there are no abnormalities after 72 hours, the annual roasting period will be automatically lifted and officially take effect.

# __7 Integration with existing architecture__

## __7\.1 Systematization after joining the company__

After the handshake is completed, Orchestrator automatically creates the following resources for the new Agent:

- BotAccount database entry: contains handshake records and Agent Card references
- ChannelMembership association: Add the new Agent to the protocol's channel
- BotAdapter instance: communication protocol initialization based on confirmation in handshake
- Context Store tiny injection: Provide ANCHOR\.md digest and current member list to new Agent as context bootstrapping constants

## __7\.2 Deployment location of Receptionist Agent__

- Receptionist Agent runs as a regular built-in Bot and does not occupy the quota of external OpenClaw instances
- Only listens to the /a2a/enroll endpoint and does not display it in the normal channel.
- The LLM called during the handshake process belongs to System LLM (see Appendix 1) and is included in the system-level calling cost.

## __7.3 Current implementation alignment (2026-03)__

To avoid misunderstandings, the relationship between the current warehouse code and this attachment is as follows:

- The A2A `/a2a/enroll` seven-step handshake protocol described in this attachment is currently a **design goal** and is not a default enabled capability.
- The current actual access path is mainly based on the Bot created on the management side (model + template) and the HTTP/WS optional access in the OpenClaw guide.
- "Receptionist Agent + Trust Level Automatic Approval" has not yet been implemented as the default online process.
- This attachment can be used as the basis for the evolution of the Phase 2/3 protocol. It is recommended to enter the subsequent scheduling and implementation together with the "Public Platform Access Application API".

__Document Revision History__

| Version | Date | Description |
|------|------|------|
| v1\.0 | 2026\-03\-07 | First draft, designing the entire process of Agent joining the protocol independently, including A2A handshake, Agent Card format, trust level and security boundary, released as Annex 4 of the outline design specification v2\.0 |
| v1\.1 | 2026\-03\-16 | Supplement the "Current Implementation Alignment" chapter to clarify that the A2A handshake protocol is currently a design goal and not a default production capability. |