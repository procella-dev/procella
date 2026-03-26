# Pulumi Backend: `display/` and `httpstate/` Deep Dive

**Repo**: https://github.com/pulumi/pulumi  
**Commit SHA**: `e6454076ac9b983e740867d43f338fbf7dbaa496`  
**Permalink base**: `https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496`

---

## `pkg/backend/display/` — CLI Output Rendering

This package renders Pulumi engine events (resource changes, diagnostics, progress) into human-readable terminal output. It supports multiple display modes: progress (interactive tree), diff, JSON, watch, and query.

### `doc.go`
- **Purpose**: Package documentation. States this package handles display of engine events.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/doc.go)

### `options.go`
- **Key types**: `Type` (enum: `DisplayProgress`, `DisplayDiff`, `DisplayWatch`), `Options` (struct)
- **Key fields in `Options`**: `Color`, `ShowConfig`, `SuppressOutputs`, `SuppressPermalink`, `SummaryDiff`, `IsInteractive`, `Type`, `JSONDisplay`, `EventLogPath`, `Debug`, `ShowSameResources`, `Stdout`, `Stderr`, `SuppressTimings`, `ShowSecrets`, `ShowNeoFeatures`, `StartNeoTaskOnError`
- **Purpose**: Central configuration struct controlling all display behavior — colorization, verbosity, output format, interactivity, and Neo (Pulumi Copilot) integration.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/options.go)

### `display.go`
- **Key functions**: `ShowEvents()`, `stampEvents()`, `logJSONEvent()`, `ConvertEngineEvent()`
- **Purpose**: Main entry point. `ShowEvents()` reads engine events from a channel, stamps them with sequence numbers/timestamps, then dispatches to the appropriate renderer based on `Options.Type` (diff → `ShowDiffEvents`, progress → `ShowProgressEvents`, watch → `ShowWatchEvents`, JSON → `ShowJSONEvents`/`ShowPreviewDigest`).
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/display.go)

### `events.go`
- **Key functions**: `ConvertEngineEvent()`, various event-to-apitype conversion helpers
- **Purpose**: Converts internal `engine.Event` types into `apitype.EngineEvent` for JSON serialization and API transmission. Handles all event types: prelude, summary, resource step, diagnostic, policy violation, progress events.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/events.go)

### `diff.go`
- **Key functions**: `ShowDiffEvents()`, `PrintStepOp()`, `getResourcePropertiesSummary()`, `writePropertyDiff()`
- **Purpose**: Renders engine events as a rich text diff (the classic `pulumi preview` output). Shows resource operations with `+`, `-`, `~` prefixes, property-level diffs, and diagnostic messages.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/diff.go)

### `json.go`
- **Key functions**: `ShowJSONEvents()`, `ShowPreviewDigest()`, `stateForJSONOutput()`, `MassageSecrets()`
- **Purpose**: Renders engine events as JSON. `ShowJSONEvents()` emits events incrementally (one JSON object per line). `ShowPreviewDigest()` accumulates all events and emits a single well-formed JSON document at the end. Handles secret masking.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/json.go)

### `jsonmessage.go`
- **Key types**: `Progress` (struct with `ID`, `Message`, `Action`), `messageRenderer` (struct)
- **Key functions**: `Progress.Display()`, `newInteractiveMessageRenderer()`, `newNonInteractiveRenderer()`
- **Purpose**: Forked from Docker's jsonmessage package. Manages the rendering of progress messages to the terminal — both interactive (with cursor control) and non-interactive (simple line output). The `messageRenderer` is the legacy progress renderer (before the tree renderer).
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/jsonmessage.go)

### `progress.go`
- **Key types**: `ProgressDisplay` (struct), `progressRenderer` (interface), `DiagInfo` (struct), `CaptureProgressEvents` (struct)
- **Key interface methods**: `progressRenderer` — `initializeDisplay()`, `tick()`, `rowUpdated()`, `systemMessage()`, `progress()`, `done()`, `println()`
- **Key functions**: `ShowProgressEvents()`, `NewCaptureProgressEvents()`, `processEvents()`, `processNormalEvent()`, `processEndSteps()`
- **Purpose**: Core progress display engine. `ProgressDisplay` maintains a map of resource URNs to `ResourceRow`s, processes engine events into row updates, and delegates rendering to a `progressRenderer` implementation (either `treeRenderer` for interactive or `messageRenderer` for non-interactive). Tracks diagnostics, policy violations, operation timing, and resource hierarchy.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/progress.go)

### `progress_bar.go`
- **Key functions**: `renderProgress()`, `renderUnicodeProgressBar()`, `renderASCIIProgressBar()`
- **Purpose**: Renders progress bar widgets (e.g., for Docker image pulls or long-running operations). Supports both Unicode (▓░) and ASCII ([===]) styles.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/progress_bar.go)

### `rows.go`
- **Key types**: `Row` (interface), `ResourceRow` (interface), `headerRowData` (struct), `resourceRowData` (struct)
- **Key interface methods**: `Row` — `DisplayOrderIndex()`, `ColorizedColumns()`, `ColorizedSuffix()`, `HideRowIfUnnecessary()`; `ResourceRow` — `Step()`, `SetStep()`, `IsDone()`, `SetFailed()`, `DiagInfo()`, `RecordDiagEvent()`
- **Purpose**: Defines the row abstraction for the progress display grid. Each resource being operated on gets a `resourceRowData` that tracks its step metadata, diagnostic info, policy payloads, and completion status. The header row provides column titles.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/rows.go)

### `tableutil.go`
- **Key functions**: `renderRow()`, `removeInfoColumnIfUnneeded()`
- **Purpose**: Utility functions for rendering tabular data with column alignment and padding.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/tableutil.go)

### `tree.go`
- **Key types**: `treeRenderer` (struct)
- **Key functions**: `newInteractiveRenderer()`, `frame()`, `render()`, `handleKey()`, `pollInput()`
- **Purpose**: The modern interactive terminal renderer. Renders resources as a scrollable tree with keyboard navigation (↑↓, PgUp/PgDn, Home/End, Ctrl+C to cancel, Ctrl+O to open permalink in browser). Uses raw terminal mode for cursor control, redraws at 60fps (16ms ticker). Falls back to `messageRenderer` on non-raw terminals.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/tree.go)

### `object_diff.go`
- **Key types**: `propertyPrinter` (struct)
- **Key functions**: `PrintObject()`, `PrintObjectDiff()`, `PrintResourceReference()`, `getResourcePropertiesDetails()`, `getResourceOutputsPropertiesString()`
- **Purpose**: Renders property-level diffs for resources. Handles nested objects, arrays, secrets, resource references, and output properties. The `propertyPrinter` recursively walks property trees to produce colorized diff output with proper indentation.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/object_diff.go)

### `query.go`
- **Key functions**: `ShowQueryEvents()`
- **Purpose**: Renders events from `pulumi query` operations. Similar to diff display but tailored for query results.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/query.go)

### `watch.go`
- **Key functions**: `ShowWatchEvents()`
- **Purpose**: Renders events in watch mode (`pulumi watch`). Displays resource changes as they happen in a continuous monitoring loop.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/watch.go)

### `ai.go`
- **Key types**: `NeoErrorSummary` (struct)
- **Key functions**: `RenderNeoErrorSummary()`, `RenderNeoTaskCreated()`, `RenderExplainPreview()`
- **Purpose**: Renders Pulumi Copilot (Neo) AI-generated error summaries and explanations. Integrates with the Pulumi Cloud AI features to provide human-readable error analysis.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/ai.go)

### `wasm/main.go`
- **Purpose**: WASM build target that imports the display package. Placeholder for running display logic in WebAssembly contexts.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/wasm/main.go)

### `internal/terminal/term.go`
- **Key types**: `Terminal` (interface)
- **Key interface methods**: `IsRaw()`, `Size()`, `ClearLine()`, `ClearEnd()`, `CarriageReturn()`, `CursorUp()`, `CursorDown()`, `HideCursor()`, `ShowCursor()`, `ReadKey()`
- **Key functions**: `Open()`
- **Purpose**: Core terminal abstraction. The `Terminal` interface wraps raw terminal I/O with cursor control, screen clearing, and keyboard input. `Open()` creates a real terminal instance that can optionally enter raw mode for interactive rendering.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/internal/terminal/term.go)

### `internal/terminal/info.go`
- **Key types**: `Info` (interface), `info` (struct using terminfo), `defaultInfo` (struct using ANSI fallbacks)
- **Key functions**: `OpenInfo()`
- **Purpose**: Abstracts terminal escape codes. Uses the `terminfo` database when available, falls back to standard ANSI escape sequences. Provides `ClearLine`, `CursorUp`, `HideCursor`, etc.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/internal/terminal/info.go)

### `internal/terminal/simple.go`
- **Key types**: `SimpleTerminal` (struct)
- **Purpose**: A terminal implementation that ignores all escape codes and writes directly to a buffer. Used for testing and non-interactive capture (e.g., `CaptureProgressEvents`).
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/internal/terminal/simple.go)

### `internal/terminal/mock.go`
- **Key types**: `MockTerminal` (struct)
- **Purpose**: A terminal implementation that renders escape codes as explicit strings (e.g., `<%clear-to-end%>`) for test assertions. Supports programmatic key injection via `SendKey()`.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/display/internal/terminal/mock.go)

---

## `pkg/backend/httpstate/` — Pulumi Cloud Backend

This package implements the `backend.Backend` interface for the Pulumi Cloud (SaaS) service. It handles all communication with the Pulumi Service API for stack management, updates, state storage, and policy enforcement.

### `doc.go`
- **Purpose**: Package documentation. States this implements the Pulumi Cloud backend.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/doc.go)

### `backend.go` (~1800 lines)
- **Key types**: `cloudBackend` (struct), `cloudBackendReference` (struct), `displayEvent` (struct), `updateMetadata` (struct)
- **Key fields in `cloudBackend`**: `client *client.Client`, `currentProject *workspace.Project`, `neoEnabledForCurrentProject *bool`
- **Key functions**:
  - `New()` — Constructor, creates a `cloudBackend` connected to a Pulumi Cloud URL
  - `Name()`, `URL()`, `CurrentUser()` — Backend identity
  - `ParseStackReference()`, `ValidateStackName()` — Stack reference parsing
  - `GetStack()`, `CreateStack()`, `RemoveStack()`, `ListStacks()`, `RenameStack()` — Stack CRUD
  - `Preview()`, `Update()`, `Refresh()`, `Destroy()` — Update operations (all delegate to `apply()`)
  - `apply()` — Core update execution: creates update, starts it, runs engine, persists events/checkpoints, completes update
  - `createAndStartUpdate()` — Creates and starts an update via the API
  - `waitForUpdate()` — Polls for update completion (used for imports)
  - `ExportDeployment()`, `ImportDeployment()` — State import/export
  - `Capabilities()` — Queries backend capabilities (delta checkpoints, etc.)
  - `Explain()`, `IsExplainPreviewEnabled()` — Neo/Copilot AI integration
  - `renderAndSummarizeOutput()` — Post-update AI error summarization
- **Purpose**: The main backend implementation. Orchestrates the entire update lifecycle: authentication, stack management, update creation/execution/completion, event persistence, checkpoint management, and AI-powered error analysis.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/backend.go)

### `stack.go`
- **Key types**: `cloudStack` (struct), `cloudStackSummary` (struct)
- **Key fields in `cloudStack`**: `ref cloudBackendReference`, `orgName string`, `currentOperation *apitype.OperationStatus`, `tags map[string]string`, `snapshot atomic.Pointer`, `escConfigEnv *string`
- **Key functions**:
  - `newStack()` — Constructs a `cloudStack` from API response
  - `Ref()`, `Backend()`, `OrgName()`, `Tags()`, `CurrentOperation()` — Accessors
  - `Snapshot()` — Lazily loads and caches the stack's deployment snapshot
  - `SnapshotStackOutputs()` — Lazily loads stack outputs
  - `DefaultSecretManager()` — Returns a service-backed secrets manager
  - `ConfigLocation()`, `LoadRemoteConfig()`, `SaveRemoteConfig()` — ESC (Environments, Secrets, Config) integration
  - `cloudStackSummary.Name()`, `.LastUpdate()`, `.ResourceCount()` — Summary accessors
- **Purpose**: Implements the `backend.Stack` interface for cloud-backed stacks. Wraps API stack data with lazy snapshot loading and ESC config support.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/stack.go)

### `state.go`
- **Key functions**:
  - `recordEngineEvents()` — Sends engine events to the Pulumi Service API
  - `persistEngineEvents()` — Reads from engine event channel, batches events, and persists them concurrently (up to N goroutines)
  - `getSnapshot()` — Exports and deserializes a stack's deployment snapshot
  - `getSnapshotStackOutputs()` — Gets just the stack outputs from a snapshot
  - `getTarget()` — Builds a `deploy.Target` from stack state
  - `newUpdate()` — Creates a `tokenSource` and `engine.UpdateInfo` for an update
  - `completeUpdate()` — Completes an update and closes the token source
- **Key constants**: `maxEventsToTransmit = 50`, `maxConcurrentRequests = 3`, `maxTransmissionDelay = 4s`
- **Purpose**: Manages the runtime state of an active update — event batching/persistence, snapshot retrieval, and update lifecycle coordination.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/state.go)

### `snapshot.go`
- **Key types**: `cloudSnapshotPersister` (struct)
- **Key fields**: `update client.UpdateIdentifier`, `tokenSource tokenSourceCapability`, `backend *cloudBackend`, `deploymentDiffState *deploymentDiffState`
- **Key functions**: `Save()`, `saveDiff()`, `saveFullVerbatim()`
- **Purpose**: Implements `backend.SnapshotPersister` for saving deployment checkpoints to the Pulumi Service. Supports both full checkpoint uploads and delta-based updates (when the backend supports `DeltaCheckpointUpdates` capability) to reduce bandwidth for large stacks.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/snapshot.go)

### `token_source.go`
- **Key types**: `tokenSourceCapability` (interface), `tokenSource` (struct), `tokenRequest`, `tokenResponse`, `expiredTokenError`
- **Key functions**: `newTokenSource()`, `handleRequests()`, `GetToken()`, `Close()`
- **Purpose**: Manages update lease token renewal. Runs a background goroutine that periodically renews the lease token (every `duration/8`) and serves token requests via a channel. If renewal fails, returns an `expiredTokenError`. Uses `clockwork.Clock` for testability.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/token_source.go)

### `diffs.go`
- **Key types**: `deploymentDiffState` (struct), `deployment` (struct), `deploymentDiff` (struct)
- **Key functions**: `newDeploymentDiffState()`, `computeEdits()`, `Diff()`, `Saved()`
- **Purpose**: Implements the delta checkpoint protocol. Computes text diffs between consecutive deployment JSON snapshots using LCS (Longest Common Subsequence) to produce minimal edit operations. This dramatically reduces bandwidth for large stacks where only a few resources change per update.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/diffs.go)

### `policypack.go`
- **Key types**: `cloudPolicyPack` (struct)
- **Key functions**: `Publish()`, `Enable()`, `Disable()`, `Validate()`, `Remove()`
- **Purpose**: Implements `backend.PolicyPack` for managing policy packs in the Pulumi Cloud. Handles publishing policy pack code, enabling/disabling policy packs on organizations, and validation.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/policypack.go)

### `environments.go`
- **Key functions**: `OpenEnvironment()`, `CheckEnvironment()`
- **Purpose**: Integrates with Pulumi ESC (Environments, Secrets, and Configuration). Provides methods to open and validate ESC environments associated with stacks.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/environments.go)

### `cloud_registry.go`
- **Key types**: `cloudRegistry` (struct)
- **Key functions**: `newCloudRegistry()`, `Publish()`, `GetPackage()`
- **Purpose**: Implements the `backend.CloudRegistry` interface for interacting with the Pulumi Package Registry. Supports publishing and retrieving packages.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/cloud_registry.go)

### `mock.go`
- **Key types**: `MockHTTPBackend` (struct, embeds `backend.MockBackend`)
- **Key function fields**: `FClient`, `FCloudURL`, `FSearch`, `FNaturalLanguageSearch`, `FPromptAI`, `FStackConsoleURL`, `FRunDeployment`, `FGetCloudRegistry`
- **Purpose**: Test double for the cloud backend. Allows tests to inject custom behavior for all backend operations.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/mock.go)

---

## `pkg/backend/httpstate/client/` — HTTP API Client

This sub-package provides the low-level HTTP client for communicating with the Pulumi Service REST API.

### `doc.go`
- **Purpose**: Package documentation for the API client.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/client/doc.go)

### `client.go` (~1500 lines)
- **Key types**: `Client` (struct), `StackIdentifier`, `UpdateIdentifier`, `NeoTaskRequest`, `NeoTaskResponse`, `CreateUpdateDetails`, `LatestConfiguration`
- **Key fields in `Client`**: `apiURL string`, `apiToken apiAccessToken`, `apiUser string`, `diag diag.Sink`, `restClient restClient`
- **Key functions**:
  - `NewClient()` — Constructor
  - **Stack CRUD**: `CreateStack()`, `GetStack()`, `DeleteStack()`, `ListStacks()`, `RenameStack()`, `UpdateStackTags()`
  - **Crypto**: `EncryptValue()`, `DecryptValue()`, `BatchEncrypt()`, `BatchDecrypt()`
  - **Updates**: `CreateUpdate()`, `StartUpdate()`, `CompleteUpdate()`, `CancelUpdate()`, `GetUpdateEvents()`
  - **Checkpoints**: `PatchUpdateCheckpoint()`, `PatchUpdateCheckpointVerbatim()`, `PatchUpdateCheckpointDelta()`
  - **Lease**: `RenewUpdateLease()`
  - **Events**: `PostEngineEventBatch()`
  - **Journal**: `SaveJournalEntry()`, `SaveJournalEntries()`
  - **Import/Export**: `ExportStackDeployment()`, `ImportStackDeployment()`
  - **Policy**: `PublishPolicyPack()`, `ListPolicyGroups()`, `ListPolicyPacks()`
  - **Search**: `GetSearchQueryResults()`, `NaturalLanguageSearch()`
  - **AI/Neo**: `CreateNeoTask()`, `StreamEvents()`
  - **Registry**: `PublishPackage()`, `GetPackage()`, `PublishTemplate()`, `DownloadTemplate()`
  - **Auth**: `GetPulumiAccountDetails()`, `GetDefaultOrg()`
  - **Capabilities**: `GetCapabilities()`
- **Purpose**: The comprehensive HTTP client wrapping every Pulumi Service API endpoint. All methods use `restCall()` or `updateRESTCall()` which handle JSON serialization, authentication, retries, and error handling.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/client/client.go)

### `api.go`
- **Key types**: `restClient` (interface), `defaultRESTClient` (struct), `httpClient` (interface), `defaultHTTPClient` (struct), `accessToken` (interface), `apiAccessToken`, `updateToken`, `httpCallOptions`, `retryPolicy`
- **Key functions**: `pulumiAPICall()`, `defaultRESTClient.Call()`, `defaultHTTPClient.Do()`, `readBody()`, `decodeError()`
- **Purpose**: Low-level HTTP request infrastructure. Handles request construction (JSON marshaling, gzip compression, auth headers), response parsing (gzip decompression, error decoding), retry logic (exponential backoff, configurable per-method), and OpenTelemetry/OpenTracing instrumentation.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/client/api.go)

### `api_endpoints.go`
- **Key functions**: `getEndpointName()`, `init()` (registers all routes)
- **Purpose**: Maps HTTP method+path pairs to friendly endpoint names for tracing/logging. Registers ~50+ API routes using `gorilla/mux` for pattern matching. Covers stacks, updates, checkpoints, events, policy packs, search, registry, templates, deployments, and GitHub app integration.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/client/api_endpoints.go)

### `console.go`
- **Key constants**: `ConsoleDomainEnvVar`, `PulumiCloudURL` (`https://api.pulumi.com`)
- **Key functions**: `CloudConsoleURL()`
- **Purpose**: Converts API URLs to Pulumi Console (web UI) URLs. Handles the `api.` → `app.` domain prefix transformation, `PULUMI_CONSOLE_DOMAIN` override, and localhost development mapping (`:8080` → `:3000`).
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/client/console.go)

### `marshal.go`
- **Key functions**: `marshalDeployment()`, `marshalVerbatimCheckpointRequest()`
- **Purpose**: JSON serialization helpers for deployment data. `marshalDeployment()` wraps a `DeploymentV3` into an `UntypedDeployment` envelope.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/client/marshal.go)

### `ai.go`
- **Key functions**: `CreateNeoTask()`, `StreamEvents()`
- **Purpose**: Client methods for Pulumi Copilot (Neo) AI integration. `CreateNeoTask()` sends error context to the AI service for analysis. `StreamEvents()` opens a gRPC stream for real-time event streaming to the Pulumi Cloud.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/client/ai.go)

---

## `pkg/backend/httpstate/journal/` — Snapshot Journaling

### `snapshot.go`
- **Key types**: `Journaler` (struct)
- **Key functions**: `NewJournaler()`, `RecordOp()`, `RecordCheckpoint()`, `Errors()`
- **Purpose**: Implements snapshot journaling — an alternative to full checkpoint uploads. Instead of sending the entire deployment state on every change, the journaler records individual operations (create, update, delete) as journal entries and sends them to the service via `SaveJournalEntries()`. This is more efficient for incremental updates. Controlled by the `JournalVersion` capability flag.
- [Permalink](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/httpstate/journal/snapshot.go)

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────┐
│                    pulumi CLI                            │
│                                                          │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │   display/    │    │        httpstate/             │   │
│  │              │    │                              │   │
│  │ ShowEvents() │◄───│ apply() → engine events      │   │
│  │ ProgressDisp │    │                              │   │
│  │ TreeRenderer │    │ cloudBackend                  │   │
│  │ DiffDisplay  │    │  ├─ CreateStack/GetStack      │   │
│  │ JSONDisplay  │    │  ├─ Preview/Update/Destroy    │   │
│  │              │    │  ├─ persistEngineEvents()     │   │
│  │ Terminal     │    │  └─ Capabilities/AI           │   │
│  │  ├─ Raw      │    │                              │   │
│  │  ├─ Simple   │    │ cloudStack                    │   │
│  │  └─ Mock     │    │  ├─ Snapshot() (lazy)         │   │
│  └──────────────┘    │  └─ ESC config                │   │
│                      │                              │   │
│                      │ tokenSource                   │   │
│                      │  └─ lease renewal goroutine   │   │
│                      │                              │   │
│                      │ cloudSnapshotPersister         │   │
│                      │  ├─ full checkpoint            │   │
│                      │  └─ delta checkpoint (diffs)   │   │
│                      │                              │   │
│                      │ journal/Journaler             │   │
│                      │  └─ incremental ops           │   │
│                      │                              │   │
│                      │ client/                       │   │
│                      │  ├─ Client (HTTP REST)        │   │
│                      │  ├─ api.go (request infra)    │   │
│                      │  ├─ api_endpoints.go (routes) │   │
│                      │  └─ console.go (URL mapping)  │   │
│                      └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Pulumi Cloud Service API
```
