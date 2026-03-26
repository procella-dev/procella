# Pulumi Backend Package — Core Interfaces & Type System

> Source: [`pulumi/pulumi`](https://github.com/pulumi/pulumi) @ `e6454076ac9b`
> Package: `pkg/backend/`

---

## Interface Relationship Map

```
Backend (core contract)
├── uses StackReference (opaque stack identity)
├── uses Stack (stack operations)
├── uses StackSummary (lightweight stack info)
├── uses PolicyPack / PolicyPackReference
├── uses UpdateOperation, UpdateOptions, UpdateInfo
├── uses StackConfiguration, LatestConfiguration
└── uses CancellationScopeSource → CancellationScope

SpecificDeploymentExporter (optional Backend capability)
EnvironmentsBackend (optional Backend capability for ESC)
CloudRegistry (optional, embeds registry.Registry)
Explainer (optional, for AI-powered explanations)

Stack.Backend() → Backend  (bidirectional reference)
Stack.Ref() → StackReference
StackSummary.Name() → StackReference

SnapshotPersister (backend-specific persistence)
SnapshotManager (engine.SnapshotManager implementation)
```

---

## 1. `Backend` Interface — The Core Abstraction

**File**: [`pkg/backend/backend.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/backend.go)

> "Backend is the contract between the Pulumi engine and pluggable backend implementations of the Pulumi Cloud Service."

Two implementations exist: **httpstate** (Pulumi Cloud/Service) and **diy** (local/S3 self-managed).

### Identity & Configuration
```go
Name() string                                    // Friendly backend name
URL() string                                     // Info URL for this backend
SetCurrentProject(proj *workspace.Project)        // Set ambient project
```

### Policy Management
```go
GetPolicyPack(ctx, policyPack string, d diag.Sink) (PolicyPack, error)
ListPolicyGroups(ctx, orgName string, inContToken ContinuationToken) (apitype.ListPolicyGroupsResponse, ContinuationToken, error)
ListPolicyPacks(ctx, orgName string, inContToken ContinuationToken) (apitype.ListPolicyPacksResponse, ContinuationToken, error)
GetStackPolicyPacks(ctx, stackRef StackReference) ([]engine.RequiredPolicy, error)
```

### Capability Flags
```go
SupportsOrganizations() bool    // Multi-org support
SupportsProgress() bool         // Operation-in-progress tracking
SupportsDeployments() bool      // Deployment management
SupportsTemplates() bool        // Template listing/downloading
```

### Organization & Project
```go
GetDefaultOrg(ctx) (string, error)
ParseStackReference(s string) (StackReference, error)
ValidateStackName(s string) error
DoesProjectExist(ctx, orgName, projectName string) (bool, error)
```

### Stack CRUD
```go
GetStack(ctx, stackRef StackReference) (Stack, error)
CreateStack(ctx, stackRef StackReference, root string, initialState *apitype.UntypedDeployment, opts *CreateStackOptions) (Stack, error)
RemoveStack(ctx, stack Stack, force, removeBackups bool) (bool, error)
ListStacks(ctx, filter ListStacksFilter, inContToken ContinuationToken) ([]StackSummary, ContinuationToken, error)
ListStackNames(ctx, filter ListStackNamesFilter, inContToken ContinuationToken) ([]StackReference, ContinuationToken, error)
RenameStack(ctx, stack Stack, newName tokens.QName) (StackReference, error)
```

### Update Operations (the core lifecycle)
```go
Preview(ctx, stack Stack, op UpdateOperation, events chan<- engine.Event) (*deploy.Plan, sdkDisplay.ResourceChanges, error)
Update(ctx, stack Stack, op UpdateOperation, events chan<- engine.Event) (sdkDisplay.ResourceChanges, error)
Import(ctx, stack Stack, op UpdateOperation, imports []deploy.Import) (sdkDisplay.ResourceChanges, error)
Refresh(ctx, stack Stack, op UpdateOperation) (sdkDisplay.ResourceChanges, error)
Destroy(ctx, stack Stack, op UpdateOperation) (sdkDisplay.ResourceChanges, error)
Watch(ctx, stack Stack, op UpdateOperation, paths []string) error
```

### History & Logs
```go
GetHistory(ctx, stackRef StackReference, pageSize, page int) ([]UpdateInfo, error)
GetLogs(ctx, secretsProvider secrets.Provider, stack Stack, cfg StackConfiguration, query operations.LogQuery) ([]operations.LogEntry, error)
GetLatestConfiguration(ctx, stack Stack) (LatestConfiguration, error)
```

### State Import/Export & Encryption
```go
ExportDeployment(ctx, stack Stack) (*apitype.UntypedDeployment, error)
ImportDeployment(ctx, stack Stack, deployment *apitype.UntypedDeployment) error
```

### User & Tags
```go
CurrentUser() (string, []string, *workspace.TokenInformation, error)
CancelCurrentUpdate(ctx, stackRef StackReference) error
UpdateStackTags(ctx, stack Stack, tags map[apitype.StackTagName]string) error
```

### Secrets & Templates & Registry
```go
DefaultSecretManager(ctx, ps *workspace.ProjectStack) (secrets.Manager, error)
ListTemplates(ctx, orgName string) (apitype.ListOrgTemplatesResponse, error)
DownloadTemplate(ctx, orgName, sourceURL string) (TarReaderCloser, error)
GetCloudRegistry() (CloudRegistry, error)
GetReadOnlyCloudRegistry() registry.Registry
```

---

## 2. `Stack` Interface

**File**: [`pkg/backend/stack.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/stack.go)

> "Stack is used to manage stacks of resources against a pluggable backend."

```go
type Stack interface {
    Ref() StackReference
    ConfigLocation() StackConfigLocation
    LoadRemoteConfig(ctx, project *workspace.Project) (*workspace.ProjectStack, error)
    SaveRemoteConfig(ctx, projectStack *workspace.ProjectStack) error
    Snapshot(ctx, secretsProvider secrets.Provider) (*deploy.Snapshot, error)
    SnapshotStackOutputs(ctx, secretsProvider secrets.Provider) (property.Map, error)
    Backend() Backend
    Tags() map[apitype.StackTagName]string
    DefaultSecretManager(ctx, info *workspace.ProjectStack) (secrets.Manager, error)
}
```

---

## 3. `StackReference` Interface

**File**: [`pkg/backend/backend.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/backend.go)

> "StackReference is an opaque type that refers to a stack managed by a backend."

```go
type StackReference interface {
    fmt.Stringer                          // String() for CLI display
    Name() tokens.StackName               // Engine-facing name (may not be unique)
    Project() (tokens.Name, bool)         // Project name (false for old diy backends)
    FullyQualifiedName() tokens.QName     // Fully qualified including org/project
}
```

---

## 4. `StackSummary` Interface

```go
type StackSummary interface {
    Name() StackReference
    LastUpdate() *time.Time
    ResourceCount() *int
}
```

---

## 5. `PolicyPackReference` Interface

```go
type PolicyPackReference interface {
    fmt.Stringer
    OrgName() string
    Name() tokens.QName
}
```

---

## 6. `PolicyPack` Interface

**File**: [`pkg/backend/policypack.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/policypack.go)

```go
type PolicyPack interface {
    Ref() PolicyPackReference
    Backend() Backend
    Publish(ctx, op PublishOperation) error
    Enable(ctx, orgName string, op PolicyPackOperation) error
    Disable(ctx, orgName string, op PolicyPackOperation) error
    Validate(ctx, op PolicyPackOperation) error
    Remove(ctx, op PolicyPackOperation) error
}
```

---

## 7. `SpecificDeploymentExporter` Interface (Optional Capability)

**File**: [`pkg/backend/backend.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/backend.go)

> "An additional capability of a Backend... should be checked for dynamically."

```go
type SpecificDeploymentExporter interface {
    ExportDeploymentForVersion(ctx, stack Stack, version string) (*apitype.UntypedDeployment, error)
}
```

---

## 8. `EnvironmentsBackend` Interface (Optional Capability for ESC)

**File**: [`pkg/backend/backend.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/backend.go)

```go
type EnvironmentsBackend interface {
    CreateEnvironment(ctx, org, projectName, envName string, yaml []byte) (apitype.EnvironmentDiagnostics, error)
    CheckYAMLEnvironment(ctx, org string, yaml []byte) (*esc.Environment, apitype.EnvironmentDiagnostics, error)
    OpenYAMLEnvironment(ctx, org string, yaml []byte, duration time.Duration) (*esc.Environment, apitype.EnvironmentDiagnostics, error)
}
```

---

## 9. `CloudRegistry` Interface

**File**: [`pkg/backend/cloud_registry.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/cloud_registry.go)

```go
type CloudRegistry interface {
    registry.Registry  // embeds read-only registry
    PublishPackage(ctx, op apitype.PackagePublishOp) error
    PublishTemplate(ctx, op apitype.TemplatePublishOp) error
    DeletePackageVersion(ctx, source, publisher, name string, version semver.Version) error
}
```

---

## 10. `CancellationScope` / `CancellationScopeSource` Interfaces

```go
type CancellationScope interface {
    Context() *cancel.Context
    Close()
}

type CancellationScopeSource interface {
    NewScope(ctx context.Context, events chan<- engine.Event, isPreview bool) CancellationScope
}
```

---

## 11. `Explainer` Interface

**File**: [`pkg/backend/apply.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/apply.go)

```go
type Explainer interface {
    Explain(ctx, stackRef StackReference, kind apitype.UpdateKind, op UpdateOperation, events []engine.Event) (string, error)
    IsExplainPreviewEnabled(ctx, opts display.Options) bool
}
```

---

## 12. `SnapshotPersister` Interface

**File**: [`pkg/backend/snapshot.go`](https://github.com/pulumi/pulumi/blob/e6454076ac9b983e740867d43f338fbf7dbaa496/pkg/backend/snapshot.go)

```go
type SnapshotPersister interface {
    Save(deployment apitype.TypedDeployment) error
}
```

---

## Key Structs (Value Types)

### `UpdateOperation`
```go
type UpdateOperation struct {
    Proj               *workspace.Project
    Root               string
    Imports            []deploy.Import
    M                  *UpdateMetadata
    Opts               UpdateOptions
    SecretsManager     secrets.Manager
    SecretsProvider    secrets.Provider
    StackConfiguration StackConfiguration
    Scopes             CancellationScopeSource
}
```

### `UpdateOptions`
```go
type UpdateOptions struct {
    Engine      engine.UpdateOptions
    Display     display.Options
    AutoApprove bool
    SkipPreview bool
    PreviewOnly bool
}
```

### `UpdateMetadata`
```go
type UpdateMetadata struct {
    Message     string            `json:"message"`
    Environment map[string]string `json:"environment"`
}
```

### `UpdateInfo`
```go
type UpdateInfo struct {
    Kind            apitype.UpdateKind              `json:"kind"`
    StartTime       int64                           `json:"startTime"`
    Message         string                          `json:"message"`
    Environment     map[string]string               `json:"environment"`
    Config          config.Map                      `json:"config"`
    Version         int                             `json:"version"`
    Result          UpdateResult                    `json:"result"`
    EndTime         int64                           `json:"endTime"`
    ResourceChanges display.ResourceChanges          `json:"resourceChanges,omitempty"`
}
```

### `UpdateResult` (enum)
```go
type UpdateResult string
const (
    InProgressResult UpdateResult = "in-progress"
    SucceededResult  UpdateResult = "succeeded"
    FailedResult     UpdateResult = "failed"
)
```

### `StackConfiguration`
```go
type StackConfiguration struct {
    EnvironmentImports []string
    Environment        esc.Value
    Config             config.Map
    Decrypter          config.Decrypter
}
```

### `LatestConfiguration`
```go
type LatestConfiguration struct {
    Config       config.Map
    Environments []string
}
```

### `StackConfigLocation`
```go
type StackConfigLocation struct {
    IsRemote bool
    EscEnv   *string
}
```

### `CreateStackOptions`
```go
type CreateStackOptions struct {
    Teams []string  // Teams who should have access
}
```

### Filter Types
```go
type ListStacksFilter struct {
    Organization, Project, TagName, TagValue *string
}

type ListStackNamesFilter struct {
    Organization, Project *string
}

type ContinuationToken *string  // Opaque pagination token
```

### `ApplierOptions`
```go
type ApplierOptions struct {
    DryRun   bool
    ShowLink bool
}
```

### `Applier` (function type)
```go
type Applier func(ctx context.Context, kind apitype.UpdateKind, stack Stack,
    op UpdateOperation, opts ApplierOptions, events chan<- engine.Event,
) (*deploy.Plan, sdkDisplay.ResourceChanges, error)
```

---

## Architecture Notes

1. **Two implementations**: `httpstate` (cloud) and `diy` (local/S3) — both implement `Backend`
2. **Optional capabilities** are checked via type assertion: `if exporter, ok := b.(SpecificDeploymentExporter); ok { ... }`
3. **`EnvironmentsBackend`** is only implemented by `httpstate` (Pulumi Cloud) for ESC integration
4. **`Stack` ↔ `Backend`** is bidirectional: `Stack.Backend()` returns the owning backend
5. **`StackReference`** is backend-specific: cloud backend includes org info, diy does not
6. **`SnapshotManager`** bridges the engine's snapshot mutations to backend-specific persistence via `SnapshotPersister`
7. **Pagination** uses opaque `ContinuationToken` — nil means no more results
