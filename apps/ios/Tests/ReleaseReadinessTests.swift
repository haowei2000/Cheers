import XCTest
@testable import Cheers

final class ReleaseReadinessTests: XCTestCase {
    func testGitHubSignInCapabilityAndOptionalProviders() throws {
        let enabled = try JSONDecoder().decode(AuthCapabilities.self,
            from: Data("{\"providers\":{\"github\":true,\"google\":true}}".utf8))
        XCTAssertTrue(enabled.signInWithGitHub)
        XCTAssertTrue(enabled.signInWithGoogle)
        let absent = try JSONDecoder().decode(AuthCapabilities.self, from: Data("{}".utf8))
        XCTAssertFalse(absent.signInWithGitHub)
    }

    func testIdentityConfirmationAndStructuredAuthErrorDecode() throws {
        let flow = try JSONDecoder().decode(IdentityConfirmationFlow.self,
            from: Data("{\"transaction_id\":\"proof\",\"status\":\"method_required\",\"methods\":[\"passkey\",\"email\"]}".utf8))
        XCTAssertEqual(flow.transactionId, "proof")
        XCTAssertEqual(flow.methods, ["passkey", "email"])
        let error = try JSONDecoder().decode(ApiErrorBody.self,
            from: Data("{\"code\":\"account_link_required\",\"message\":\"Sign in first\"}".utf8))
        XCTAssertEqual(error.message, "Sign in first")
    }

    func testArtifactIdentityAndAttachmentAvailability() throws {
        let raw = Data("""
        {"artifact_id":"stable-id","channel_id":"channel","uri":"cheers:artifact/stable-id",
         "title":"Report.pdf","source_kind":"attachment","source_id":"blob-id","path":null,
         "content_type":"application/pdf","size_bytes":123,"version":7,"availability":"ready","expires_at":null}
        """.utf8)
        let artifact = try JSONDecoder().decode(ChannelArtifact.self, from: raw)
        XCTAssertEqual(artifact.contextItem.verb, "channel.artifacts.read")
        XCTAssertEqual(artifact.contextItem.params["artifact_id"], .string("stable-id"))
        XCTAssertEqual(artifact.attachment?.fileId, "blob-id")
        let expired = try JSONDecoder().decode(ChannelArtifact.self,
            from: Data(String(decoding: raw, as: UTF8.self).replacingOccurrences(of: "\"ready\"", with: "\"expired\"").utf8))
        XCTAssertNil(expired.attachment)
        XCTAssertFalse(expired.isReady)
    }

    func testArtifactSnapshotUsesCanonicalVersionAndSourceData() throws {
        let content = try JSONDecoder().decode(ChannelArtifactContent.self, from: Data("""
        {"artifact":{"artifact_id":"stable-id","channel_id":"channel","uri":"cheers:artifact/stable-id",
          "title":"Renamed.tsx","source_kind":"text","source_id":"source-id","path":"Renamed.tsx",
          "content_type":null,"size_bytes":12,"version":9,"availability":"ready","expires_at":null},
         "content":"export default function Page() {}","kind":"text","truncated":false}
        """.utf8))
        XCTAssertEqual(content.artifact.version, 9)
        XCTAssertTrue(content.artifact.isInteractive)
        XCTAssertTrue(isChannelArtifactReference(content.artifact.uri))
        XCTAssertFalse(isChannelArtifactReference("cheers://auth/callback"))
    }

    func testWorkbenchExtensionDTOsDecodeScenesAndIgnoreWebRendererDetails() throws {
        let summary = try JSONDecoder().decode(
            WorkbenchExtensionSummary.self,
            from: Data("""
            {"id":"example","version":"1.0.0","title":"Example","description":"",
             "sha256":"abc","origin":"admin",
             "scenes":[{"id":"main","title":"Main","definition":"scenes/main.json"}],
             "renderers":[{"id":"web","title":"Web","entry":"renderers/web.js","match":["**/*.md"]}]}
            """.utf8))

        XCTAssertEqual(summary.scenes.map(\.id), ["main"])
        XCTAssertEqual(summary.renderers.map(\.id), ["web"])
        XCTAssertEqual(inferNativeLens(path: "notes.md", data: nil), "markdown")
    }

    func testWorkbenchSceneItemsDecodePublishedAndNormalizedWireShapes() throws {
        let legacy = try JSONDecoder().decode(
            WorkbenchPanelDef.self,
            from: Data("""
            {"id":"notes","title":"Notes","file":"notes.md","renderer":"builtin:markdown"}
            """.utf8))
        let normalized = try JSONDecoder().decode(
            WorkbenchPanelDef.self,
            from: Data("""
            {"id":"notes","title":"Notes","source":{"kind":"fs","path":"notes.md"},"view":"builtin:markdown"}
            """.utf8))

        XCTAssertEqual(legacy.path, "notes.md")
        XCTAssertEqual(legacy.lensId, "markdown")
        XCTAssertEqual(normalized.path, legacy.path)
        XCTAssertEqual(normalized.lensId, legacy.lensId)
    }

    func testWorkbenchSceneStateDecodesSharedNavigationIndex() {
        let value = JSONValue.object([
            "version": .number(1),
            "order": .array([.string("code"), .string("research")]),
            "titles": .object(["code": .string("Code")]),
            "items": .object(["code": .array([.string("dev/plan.yaml")])]),
        ])

        let state = WorkbenchSceneState(value)

        XCTAssertEqual(state.order, ["code", "research"])
        XCTAssertEqual(state.titles["code"], "Code")
        XCTAssertEqual(state.items["code"], ["dev/plan.yaml"])
    }

    func testGlobalSceneActivationKeepsOnlyNativeRendererBindings() {
        // A scene's items are panels: one `source` and one `view`, where the old shape
        // carried a `file` plus a `lens`/`renderer` pair that could disagree with itself.
        let manifest = WorkbenchTemplateManifest(
            id: "extension:example:main",
            title: "Research",
            items: [
                WorkbenchPanelDef(
                    id: "notes", title: "Notes",
                    source: WorkbenchPanelSource(kind: "fs", path: "notes.md"),
                    view: "builtin:markdown", config: nil),
                WorkbenchPanelDef(
                    id: "web", title: "Web",
                    source: WorkbenchPanelSource(kind: "fs", path: "custom.data"),
                    view: "personal:web", config: nil),
            ],
            seed: nil,
            pin: ["notes.md"])

        let config = workbenchConfiguration(applying: manifest, to: [:])
        let state = WorkbenchSceneState(config["scene_state"])
        let bindings = config["bindings"]?.objectValue

        XCTAssertEqual(state.order, ["extension:example:main"])
        XCTAssertEqual(state.items[manifest.id], ["notes.md", "custom.data"])
        XCTAssertEqual(bindings?["notes.md"], .string("builtin:markdown"))
        XCTAssertNil(bindings?["custom.data"])
        XCTAssertNil(inferNativeLens(path: "custom.data", data: nil))
    }

    func testWorkbenchNativeRendererMatchingUsesParsedData() {
        XCTAssertEqual(inferNativeLens(path: "notes.md", data: nil), "markdown")
        XCTAssertEqual(inferNativeLens(path: "rows.yaml", data: .array([
            .object(["name": .string("A")]),
        ])), "table")
        XCTAssertEqual(inferNativeLens(path: "metrics.yaml", data: .object([
            "series": .array([]),
        ])), "chart")
        XCTAssertEqual(inferNativeLens(path: "codemap/map.yaml", data: .object([
            "codemap": .number(1),
            "nodes": .object([:]),
        ])), "codemap")
        XCTAssertNil(inferNativeLens(path: "config.toml", data: nil))
    }

    func testCodemapParserPreservesGraphAndFocusState() throws {
        let document = try XCTUnwrap(parseCodemap(.object([
            "codemap": .number(1),
            "repo": .string("haowei2000/Cheers"),
            "focus": .array([.string("gateway.fs")]),
            "nodes": .object([
                "gateway.fs": .object([
                    "kind": .string("module"),
                    "label": .string("Filesystem resources"),
                    "summary": .string("Reads and patches Workbench files"),
                    "status": .string("explored"),
                ]),
                "ios": .object([
                    "kind": .string("area"),
                    "label": .string("iOS"),
                    "status": .string("partial"),
                ]),
            ]),
            "edges": .array([.object([
                "from": .string("ios"),
                "to": .string("gateway.fs"),
                "kind": .string("calls"),
            ])]),
        ])))

        XCTAssertEqual(document.repository, "haowei2000/Cheers")
        XCTAssertEqual(document.nodes.map(\.id), ["ios", "gateway.fs"])
        XCTAssertEqual(document.focus, ["gateway.fs"])
        XCTAssertEqual(document.edges, [CodemapEdge(from: "ios", to: "gateway.fs", kind: "calls", label: nil)])
    }

    func testWorkbenchOtherSceneHidesUnsupportedAndConfigFiles() {
        let paths = workbenchOtherPaths(
            discovered: ["notes.md": "markdown", "tasks.yaml": "table", ".workbench.json": "raw"],
            claimed: ["tasks.yaml"],
            existing: ["notes.md", "tasks.yaml", ".workbench.json", "secret.bin"]
        )

        XCTAssertEqual(paths, ["notes.md"])
    }

    func testProductionServerIdentity() {
        let identity = ServerIdentity.resolve("https://www.tocheers.com/api/v1")

        XCTAssertEqual(identity.kind, .production)
        XCTAssertEqual(identity.title, "Cheers Cloud")
        XCTAssertTrue(identity.isProduction)
    }

    func testCustomServerIdentityExposesHost() {
        let identity = ServerIdentity.resolve("http://localhost:30080/api/v1")

        XCTAssertEqual(identity.kind, .custom)
        XCTAssertEqual(identity.title, "Custom workspace")
        XCTAssertEqual(identity.detail, "localhost")
        XCTAssertFalse(identity.isProduction)
    }

    func testDMUsesPeerNameInsteadOfGenericChannelName() throws {
        let data = Data("""
        {
          "channel_id":"dm-1",
          "workspace_id":null,
          "name":"Direct Message",
          "type":"dm",
          "peer_name":"Ada Lovelace"
        }
        """.utf8)

        let channel = try JSONDecoder().decode(ChannelDto.self, from: data)

        XCTAssertEqual(channel.displayName, "Ada Lovelace")
    }

    func testDMWithoutPeerNeverShowsGenericDirectMessageLabel() throws {
        let data = Data("""
        {
          "channel_id":"dm-2",
          "workspace_id":null,
          "name":"Direct Message",
          "type":"dm"
        }
        """.utf8)

        let channel = try JSONDecoder().decode(ChannelDto.self, from: data)

        XCTAssertEqual(channel.displayName, "Unknown participant")
    }

    func testActivityNotificationDecodesAllBotApprovalFields() throws {
        let data = Data("""
        {
          "id":"bot-channel:channel-1:bot-1",
          "kind":"bot_channel_invite",
          "title":"private-planning",
          "actor_id":"user-1",
          "actor_name":"Ada",
          "created_at":"2026-08-08T00:00:00Z",
          "workspace_id":"workspace-1",
          "channel_id":"channel-1",
          "bot_id":"bot-1",
          "bot_name":"Planner",
          "role":"member",
          "requested_cwd":"/repo",
          "requested_additional_dirs":["/docs"]
        }
        """.utf8)

        let notification = try JSONDecoder().decode(NotificationDto.self, from: data)

        XCTAssertEqual(notification.id, "bot-channel:channel-1:bot-1")
        XCTAssertEqual(notification.botName, "Planner")
        XCTAssertEqual(notification.requestedCwd, "/repo")
        XCTAssertEqual(notification.requestedAdditionalDirs, ["/docs"])
    }

    func testActivityPushRoutesWithoutAChannelId() {
        let destination = PushRouter.destination(from: [
            "type": "activity",
            "notification_id": "friend:request-1",
        ])

        XCTAssertEqual(destination, .activity)
    }

    @MainActor
    func testRealtimeNotificationOnlyTreatsDmKindAsDirectMessage() {
        let dm = Data("""
        {"type":"notification","data":{"kind":"dm","channel_id":"dm-1"}}
        """.utf8)
        let mention = Data("""
        {"type":"notification","data":{"kind":"mention","channel_id":"channel-1"}}
        """.utf8)

        XCTAssertEqual(ChatSocket.directMessageChannelId(fromNotificationFrame: dm), "dm-1")
        XCTAssertNil(ChatSocket.directMessageChannelId(fromNotificationFrame: mention))
    }

    func testApprovalUsesClaudeRawInputAndLocations() throws {
        let request = try permissionRequest("""
        {
          "request_id":"permission-1",
          "title":"ACP permission request",
          "tool": {
            "kind":"edit",
            "title":"Edit release metadata",
            "raw_input":{"file_path":"/repo/Info.plist","content":"1.0.0"},
            "locations":[{"path":"/repo/Info.plist"}]
          },
          "options":[{"option_id":"allow_once","kind":"allow_once"}]
        }
        """)

        XCTAssertEqual(request.title, "Edit release metadata")
        XCTAssertEqual(request.command, "/repo/Info.plist  (5 chars)")
        XCTAssertEqual(request.locations, ["/repo/Info.plist"])
    }

    func testApprovalUsesCursorLocationsWhenCommandIsMissing() throws {
        let request = try permissionRequest("""
        {
          "request_id":"permission-2",
          "tool": {
            "kind":"edit",
            "locations":[{"path":"/repo/Sources/App.swift"}]
          }
        }
        """)

        XCTAssertEqual(request.title, "Approval needed")
        XCTAssertEqual(request.command, "/repo/Sources/App.swift")
        XCTAssertEqual(request.locations, ["/repo/Sources/App.swift"])
    }

    func testApprovalUsesCodexArgvPreview() throws {
        let request = try permissionRequest("""
        {
          "request_id":"permission-3",
          "tool":{"raw_input":{"argv":["xcodebuild","test"]}}
        }
        """)

        XCTAssertEqual(request.command, "xcodebuild test")
    }

    func testAttachmentUploadPolicyRejectsEmptyAndOversizedFiles() {
        XCTAssertThrowsError(try AttachmentUploadPolicy.validate(byteCount: 0)) { error in
            XCTAssertEqual(error as? AttachmentUploadError, .empty)
        }
        XCTAssertNoThrow(try AttachmentUploadPolicy.validate(
            byteCount: AttachmentUploadPolicy.maximumByteCount
        ))
        XCTAssertThrowsError(try AttachmentUploadPolicy.validate(
            byteCount: AttachmentUploadPolicy.maximumByteCount + 1
        ))
    }

    func testImageAttachmentDetectionUsesMimeTypeAndSafeExtensionFallback() throws {
        let mimeImage = try fileRef(filename: "opaque.bin", contentType: "image/webp")
        let extensionImage = try fileRef(filename: "photo.HEIC", contentType: nil)
        let document = try fileRef(filename: "report.pdf", contentType: "application/pdf")

        XCTAssertTrue(mimeImage.isImageAttachment)
        XCTAssertTrue(extensionImage.isImageAttachment)
        XCTAssertFalse(document.isImageAttachment)
    }

    func testTraceEventNormalizesLegacyLivePayload() throws {
        let event = try traceEvent("""
        {
          "event_id":"call-1",
          "msg_id":"message-1",
          "phase":"tool_call_update",
          "status":"completed",
          "data":{"tool_call_id":"call-1"}
        }
        """)

        XCTAssertEqual(event.v, TraceEventContract.version)
        XCTAssertEqual(event.id, "call-1")
        XCTAssertEqual(event.toolCallId, "call-1")
        XCTAssertEqual(event.operationKind, "tool")
        XCTAssertEqual(event.operationId, "call-1")
        XCTAssertTrue(event.isTerminal)
    }

    func testTraceEventNormalizesCrossAgentStatusVocabulary() throws {
        let event = try traceEvent("""
        {
          "msg_id":"message-1",
          "phase":"tool_call_update",
          "status":"done",
          "tool_call_id":"call-1"
        }
        """)

        XCTAssertEqual(event.status, "completed")
        XCTAssertTrue(event.isTerminal)
    }

    func testTraceLifecycleCoalescingPreservesOpeningDetail() throws {
        let opening = try traceEvent("""
        {
          "v":1,
          "id":"row-1",
          "msg_id":"message-1",
          "trace_seq":1,
          "kind":"trace",
          "phase":"tool_call",
          "status":"in_progress",
          "title":"Write novel.txt",
          "data":{
            "tool_call_id":"call-1",
            "input":{"path":"novel.txt","content":"draft"}
          },
          "created_at":"2026-08-02T09:00:00Z"
        }
        """)
        let terminal = try traceEvent("""
        {
          "v":1,
          "id":"call-1",
          "msg_id":"message-1",
          "kind":"trace",
          "phase":"tool_call_update",
          "status":"completed",
          "data":{
            "tool_call_id":"call-1",
            "input":null,
            "output":{"bytes":5}
          },
          "created_at":"2026-08-02T09:00:01Z"
        }
        """)

        let merged = try XCTUnwrap(TraceEventContract.coalesce([opening], [terminal]).first)
        XCTAssertEqual(merged.id, "row-1")
        XCTAssertEqual(merged.traceSeq, 1)
        XCTAssertEqual(merged.title, "Write novel.txt")
        XCTAssertEqual(merged.status, "completed")
        XCTAssertTrue(merged.isTerminal)
        XCTAssertEqual(merged.data?["input"]?["path"]?.stringValue, "novel.txt")
        XCTAssertEqual(merged.data?["output"]?["bytes"]?.numberValue, 5)
    }

    func testTraceCoalescingDeduplicatesSameTransportRow() throws {
        let event = try traceEvent("""
        {
          "id":"plan-1",
          "msg_id":"message-1",
          "trace_seq":2,
          "phase":"plan",
          "status":"completed",
          "created_at":"2026-08-02T09:00:00Z"
        }
        """)

        XCTAssertEqual(TraceEventContract.coalesce([event], [event]).count, 1)
    }

    func testTraceTerminalOperationCannotReopenFromStaleFrame() throws {
        let terminal = try traceEvent("""
        {
          "id":"call-1",
          "msg_id":"message-1",
          "phase":"tool_call_update",
          "status":"completed",
          "data":{"tool_call_id":"call-1"},
          "created_at":"2026-08-02T09:00:01Z"
        }
        """)
        let stale = try traceEvent("""
        {
          "id":"call-1",
          "msg_id":"message-1",
          "phase":"tool_call_update",
          "status":"in_progress",
          "data":{"tool_call_id":"call-1"},
          "created_at":"2026-08-02T09:00:00Z"
        }
        """)

        let merged = try XCTUnwrap(TraceEventContract.coalesce([terminal], [stale]).first)
        XCTAssertTrue(merged.isTerminal)
        XCTAssertEqual(merged.status, "completed")
    }

    func testTraceCoalescingDropsTransientThoughtChunks() throws {
        let finished = try traceEvent("""
        {
          "id":"finished-1",
          "msg_id":"message-1",
          "trace_seq":3,
          "phase":"prompt_finished",
          "status":"completed",
          "created_at":"2026-08-02T09:00:02Z"
        }
        """)
        let thought = try traceEvent("""
        {
          "id":"thought-1",
          "msg_id":"message-1",
          "producer_seq":2,
          "phase":"agent_thought_chunk",
          "status":"running",
          "created_at":"2026-08-02T09:00:01Z"
        }
        """)

        let events = TraceEventContract.coalesce([finished], [thought])
        XCTAssertEqual(events.map(\.id), ["finished-1"])
    }

    func testToolPresentationAcceptsOnlyGatewayV2EventTypes() throws {
        let event = try traceEvent("""
        {
          "msg_id":"message-1",
          "phase":"tool_call_update",
          "status":"completed",
          "data":{
            "presentation":{
              "v":2,
              "event_type":"git_status",
              "family":"git",
              "operation":"status",
              "command":"git status --short --branch",
              "cwd":"/repo/Cheers"
            }
          }
        }
        """)

        XCTAssertEqual(event.toolPresentation?.eventType, .gitStatus)
        XCTAssertEqual(event.toolPresentation?.command, "git status --short --branch")
        XCTAssertEqual(event.toolPresentation?.cwd, "/repo/Cheers")
    }

    func testToolPresentationRejectsLegacyAndUnknownEventTypes() throws {
        let legacy = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"v":1,"renderer":"git_status","family":"git","operation":"status"}
        """.utf8))
        let unknown = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"v":2,"event_type":"mystery_tool","family":"git","operation":"status"}
        """.utf8))

        XCTAssertNil(ToolPresentation.parse(legacy))
        XCTAssertNil(ToolPresentation.parse(unknown))
    }

    func testGitStatusResultUsesStructuredGatewayPayload() throws {
        let event = try traceEvent("""
        {
          "msg_id":"message-1",
          "phase":"tool_call_update",
          "status":"completed",
          "data":{
            "presentation":{
              "v":2,
              "event_type":"git_status",
              "family":"git",
              "operation":"status",
              "result":{
                "kind":"git_status",
                "branch":"feature/tool-presentation",
                "clean":false,
                "counts":{"staged":1,"unstaged":2,"untracked":1,"conflicted":0},
                "files":[
                  {"path":"apps/ios/Sources/Views/BotTracePanelView.swift","index":" ","worktree":"M","state":"unstaged"}
                ],
                "truncated":false
              }
            }
          }
        }
        """)

        let result = try XCTUnwrap(GitStatusResult.parse(event.toolPresentation))
        XCTAssertEqual(result.branch, "feature/tool-presentation")
        XCTAssertEqual(result.counts.unstaged, 2)
        XCTAssertEqual(result.files.first?.state, .unstaged)
    }

    func testMessageTreeNestsRepliesUnderParent() {
        let root = MessageDto(
            msgId: "root", channelId: "c1", channelSeq: 1,
            senderType: "user", senderId: "u1", content: "hi"
        )
        let bot = MessageDto(
            msgId: "bot1", channelId: "c1", channelSeq: 2,
            senderType: "bot", senderId: "b1", content: "ok",
            replyToMsgId: "root",
            contentData: .object(["session_id": .string("sid-1")])
        )
        let reply = MessageDto(
            msgId: "r1", channelId: "c1", channelSeq: 3,
            senderType: "user", senderId: "u1", content: "more",
            replyToMsgId: "bot1"
        )
        let grouped = MessageTree.groupByReply([root, bot, reply])
        XCTAssertEqual(grouped.roots.map(\.msgId), ["root"])
        XCTAssertEqual(grouped.childrenByParent["root"]?.map(\.msgId), ["bot1"])
        XCTAssertEqual(grouped.childrenByParent["bot1"]?.map(\.msgId), ["r1"])
        XCTAssertEqual(MessageTree.messageSessionId(bot), "sid-1")
    }

    func testMessageTreeKeepsOrphanRepliesAsRoots() {
        let orphan = MessageDto(
            msgId: "o1", channelId: "c1", channelSeq: 1,
            senderType: "user", senderId: "u1", content: "x",
            replyToMsgId: "missing"
        )
        let grouped = MessageTree.groupByReply([orphan])
        XCTAssertEqual(grouped.roots.map(\.msgId), ["o1"])
    }

    func testMessageTreeFoldsAnchoredPermissions() {
        let bot = MessageDto(
            msgId: "bot1", channelId: "c1", channelSeq: 1,
            senderType: "bot", senderId: "b1", content: "ok"
        )
        let perm = MessageDto(
            msgId: "p1", channelId: "c1", channelSeq: 2,
            senderType: "bot", senderId: "b1", content: "",
            msgType: "permission",
            contentData: .object([
                "source_msg_id": .string("bot1"),
                "request_id": .string("req1"),
            ])
        )
        let grouped = MessageTree.groupByReply([bot, perm])
        XCTAssertEqual(grouped.roots.map(\.msgId), ["bot1"])
        XCTAssertNil(grouped.byId["p1"])
        XCTAssertEqual(MessageTree.permissionSourceId(perm), "bot1")
    }

    @MainActor
    func testTaskClaimEventRequiresMatchingEnvelopeChannel() throws {
        let event = Data("""
        {"type":"task_claim_updated","channel_id":"c1","data":{
          "claim_id":"claim1","channel_id":"c1","status":"cancelled","execution_msg_id":null,
          "confirmation_message":{"msg_id":"confirmation1","content_data":{
            "claim_id":"claim1","claim_status":"cancelled","claim_revision":3,"resolved":true}},
          "future_field":true}}
        """.utf8)
        let update = try XCTUnwrap(ChatSocket.taskClaimUpdate(from: event))
        XCTAssertEqual(update.status, "cancelled")
        let wrongChannel = Data(String(decoding: event, as: UTF8.self)
            .replacingOccurrences(of: "\"channel_id\":\"c1\",\"data\"", with: "\"channel_id\":\"c2\",\"data\"").utf8)
        XCTAssertNil(ChatSocket.taskClaimUpdate(from: wrongChannel))
    }

    func testTaskClaimHttpAndSocketProjectionsCannotDowngradeEachOther() {
        let pending = claimConfirmation(status: "pending", revision: 1)
        let cancelled = TaskClaimUpdate(
            claimId: "claim1", channelId: "c1", status: "cancelled", executionMsgId: nil,
            confirmationMessage: .init(msgId: pending.msgId, contentData: claimData(status: "cancelled", revision: 3))
        )
        let lateApproval = TaskClaimUpdate(
            claimId: "claim1", channelId: "c1", status: "executing", executionMsgId: "execution1",
            confirmationMessage: .init(msgId: pending.msgId, contentData: claimData(status: "executing", revision: 2))
        )
        let current = TaskClaimProjection.applying(cancelled, to: pending)
        XCTAssertEqual(current.contentData?["claim_status"]?.stringValue, "cancelled")
        XCTAssertEqual(current.content, pending.content)
        XCTAssertEqual(current.channelSeq, pending.channelSeq)
        XCTAssertEqual(TaskClaimProjection.applying(lateApproval, to: current), current)
        XCTAssertEqual(TaskClaimProjection.applying(cancelled, to: current), current)
        XCTAssertEqual(TaskClaimProjection.preservingNewerMetadata(in: pending, previous: current), current)
    }

    func testTaskClaimProjectionRejectsUnrelatedMessagesAndMalformedRevisions() {
        let pending = claimConfirmation(status: "pending", revision: 1)
        func update(channel: String = "c1", claim: String = "claim1", message: String = "confirmation1", revision: Double = 2) -> TaskClaimUpdate {
            .init(claimId: claim, channelId: channel, status: "failed", executionMsgId: nil,
                  confirmationMessage: .init(msgId: message, contentData: claimData(status: "failed", revision: revision)))
        }
        for invalid in [update(channel: "c2"), update(claim: "other"), update(message: "source1"), update(revision: 0), update(revision: 1.5)] {
            XCTAssertEqual(TaskClaimProjection.applying(invalid, to: pending), pending)
        }
        var other = pending
        other.msgType = "normal"
        XCTAssertEqual(TaskClaimProjection.applying(update(), to: other), other)
        other = pending
        other.isDeleted = true
        XCTAssertEqual(TaskClaimProjection.applying(update(), to: other), other)
    }

    func testTaskClaimWarmCacheRevalidationPreservesNewerProjection() {
        var legacy = claimConfirmation(status: "pending", revision: 1)
        legacy.contentData = .object(["claim_id": .string("claim1"), "resolved": .bool(false)])
        XCTAssertTrue(TaskClaimProjection.needsRevalidation(legacy))
        let executing = claimConfirmation(status: "executing", revision: 2)
        XCTAssertTrue(TaskClaimProjection.needsRevalidation(executing))
        let completed = claimConfirmation(status: "completed", revision: 3)
        XCTAssertFalse(TaskClaimProjection.needsRevalidation(completed))
        XCTAssertEqual(TaskClaimProjection.applyingSnapshot(completed, to: legacy).contentData, completed.contentData)
        XCTAssertEqual(TaskClaimProjection.applyingSnapshot(executing, to: completed), completed)
        var unrelated = completed
        unrelated.msgId = "another-message"
        XCTAssertEqual(TaskClaimProjection.applyingSnapshot(unrelated, to: legacy), legacy)
        var legacyClosed = legacy
        legacyClosed.contentData = .object(["claim_id": .string("claim1"), "resolved": .bool(true)])
        XCTAssertEqual(TaskClaimProjection.applyingSnapshot(legacy, to: legacyClosed), legacyClosed)
        var equalRevisionPending = completed
        equalRevisionPending.contentData = claimData(status: "pending", revision: 3)
        XCTAssertEqual(TaskClaimProjection.applyingSnapshot(equalRevisionPending, to: completed), completed)
        XCTAssertNil(TaskClaimProjection.revision(claimData(status: "pending", revision: 9_007_199_254_740_992)))
    }

    func testDiscussionMergePreservesNewerTaskClaimMetadata() {
        let root = MessageDto(msgId: "root", channelId: "c1", channelSeq: 1,
                              senderType: "user", senderId: "u1", content: "Task")
        var stale = claimConfirmation(status: "executing", revision: 2)
        stale.replyToMsgId = root.msgId
        var completed = claimConfirmation(status: "completed", revision: 3)
        completed.replyToMsgId = root.msgId
        let merged = MessageTree.mergeDiscussion(root: root, replies: [completed], live: [stale])
        XCTAssertEqual(merged.first { $0.msgId == completed.msgId }?.contentData, completed.contentData)
    }

    func testTaskClaimRevalidationAppliesOnlyMatchingExplicitTombstones() {
        let pending = claimConfirmation(status: "pending", revision: 1)
        var tombstone = pending
        tombstone.isDeleted = true
        let deleted = TaskClaimProjection.applyingSnapshot(tombstone, to: pending)
        XCTAssertEqual(deleted.isDeleted, true)
        XCTAssertTrue(deleted.content.isEmpty)
        XCTAssertFalse(TaskClaimProjection.needsRevalidation(deleted))
        XCTAssertEqual(TaskClaimProjection.preservingNewerMetadata(in: pending, previous: deleted), deleted)

        let completed = claimConfirmation(status: "completed", revision: 3)
        let newerDeleted = TaskClaimProjection.applyingSnapshot(tombstone, to: completed)
        XCTAssertEqual(newerDeleted.isDeleted, true)
        XCTAssertEqual(newerDeleted.contentData, completed.contentData)
        for keyPath in [\MessageDto.msgId, \MessageDto.channelId] {
            var unrelated = tombstone
            unrelated[keyPath: keyPath] = "another-id"
            XCTAssertEqual(TaskClaimProjection.applyingSnapshot(unrelated, to: pending), pending)
        }
        var unrelated = tombstone
        unrelated.senderId = "another-bot"
        XCTAssertEqual(TaskClaimProjection.applyingSnapshot(unrelated, to: pending), pending)
        unrelated = tombstone
        unrelated.contentData = .object(["claim_id": .string("another-claim")])
        XCTAssertEqual(TaskClaimProjection.applyingSnapshot(unrelated, to: pending), pending)
    }

    func testTaskClaimActionsRequirePendingOrLegacyUnresolvedState() {
        let pending = claimConfirmation(status: "pending", revision: 1)
        XCTAssertTrue(TaskClaimProjection.isUnresolved(pending))
        var legacy = pending
        legacy.contentData = .object(["claim_id": .string("claim1"), "resolved": .bool(false)])
        XCTAssertTrue(TaskClaimProjection.isUnresolved(legacy))
        for status in ["executing", "completed", "failed", "cancelled", "rejected", "unknown"] {
            var inconsistent = claimConfirmation(status: status, revision: 2)
            var fields = inconsistent.contentData!.objectValue!
            fields["resolved"] = .bool(false)
            inconsistent.contentData = .object(fields)
            XCTAssertFalse(TaskClaimProjection.isUnresolved(inconsistent))
        }
        legacy.isDeleted = true
        XCTAssertFalse(TaskClaimProjection.isUnresolved(legacy))
    }

    private func claimData(status: String, revision: Double) -> JSONValue {
        .object(["claim_id": .string("claim1"), "requester_id": .string("u1"),
                 "claim_status": .string(status), "claim_revision": .number(revision),
                 "resolved": .bool(status != "pending")])
    }

    private func claimConfirmation(status: String, revision: Double) -> MessageDto {
        MessageDto(msgId: "confirmation1", channelId: "c1", channelSeq: 2,
                   senderType: "bot", senderId: "b1", content: "Claim request",
                   msgType: "task_claim_confirmation", isPartial: false,
                   contentData: claimData(status: status, revision: revision))
    }

    private func permissionRequest(_ json: String) throws -> PermissionRequest {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return try XCTUnwrap(PermissionRequest(contentData: value))
    }

    private func fileRef(filename: String, contentType: String?) throws -> MessageFileRef {
        var object: [String: Any] = [
            "file_id": UUID().uuidString,
            "original_filename": filename,
        ]
        if let contentType { object["content_type"] = contentType }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(MessageFileRef.self, from: data)
    }

    private func traceEvent(_ json: String) throws -> TraceEventDto {
        try JSONDecoder().decode(TraceEventDto.self, from: Data(json.utf8))
    }
}
