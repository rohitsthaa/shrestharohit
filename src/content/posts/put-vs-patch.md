---
title: "PATCH vs PUT in the Real World: Lessons from a Broken Update"
description: "Designing efficient PUT vs PATCH strategies for very large JSON payloads in ASP.NET Core: when to send full documents, when to send partials, and how to reduce bandwidth & write amplification."
pubDate: 2025-08-27
updatedDate: 2025-08-27
tags: [".net","aspnet-core","rest","http","patch","put","jsonpatch","concurrency","etag"]
draft: false
---

When objects are small (a few KB) the distinction between PUT and PATCH is mostly semantic. When objects are large (hundreds of KB to multi‑MB JSON) the choice directly affects:

| Axis | PUT (full replace) | PATCH (partial) |
|------|--------------------|-----------------|
| Bandwidth | Scales with full object size every update | Scales with changed fields only |
| Latency | Larger upload & serialization cost | Typically lower (smaller payload) |
| Server cost | Full revalidation + full model binding | Targeted validation; smaller model binding surface |
| Write amplification | Overwrites unchanged columns / JSON blobs | Touches only modified data (if applied carefully) |
| Simplicity | Easier for clients (send whole doc) | Slightly harder (compute diff) |
| Risk on omission | Accidental data loss if field omitted | Safer (omit means unchanged) |

## Core Guidance (Large Payloads)

1. Use **PATCH** for frequent small changes to large documents (e.g., updating 1 field in a 600KB profile).
2. Use **PUT** when clients naturally maintain a full canonical snapshot (e.g., config editors saving entire form).
3. Never send unchanged large arrays/blobs in PUT if you can instead issue a PATCH for the single field.
4. Compress over the wire (`Content-Encoding: gzip` or `br`) for both verbs.
5. Accept only one PATCH style (recommend JSON Merge Patch) to keep surface area small.

## Choosing a PATCH Format

| Format | Media Type | Pros | Cons | Payload Size Impact |
|--------|------------|------|------|---------------------|
| JSON Merge Patch | `application/merge-patch+json` | Minimal diff authoring; natural for simple objects | Null means delete/clear; entire sub-object replace | Small (only changed branches) |
| JSON Patch | `application/json-patch+json` | Explicit operations (`add`, `remove`, `replace`) | Verbose; path correctness overhead | Slightly larger than merge patch for trivial updates |

For most large JSON documents with shallow updates, **merge patch is enough**.

## Example Domain – Large Profile

Imagine a Customer Profile (~450KB) containing nested preferences, large address arrays, and audit info. We update only the notification preferences (~2KB) 30 times a day.

### Inefficient (PUT)

```http
PUT /profiles/123
Content-Type: application/json

{ /* 450KB JSON (mostly unchanged) */ }
```

### Efficient (Merge PATCH)

```http
PATCH /profiles/123
Content-Type: application/merge-patch+json

{ "notificationSettings": { "marketing": false, "product": true } }
```

Bandwidth reduction ≈ 450KB → 0.6–2KB per update.

## ASP.NET Core Minimal Example (Merge Patch Only)

We avoid concurrency/ETag detail here; focus on payload handling.

```csharp
public sealed class Profile
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public NotificationSettings NotificationSettings { get; set; } = new();
    public List<string> Addresses { get; set; } = new();
}

public sealed class NotificationSettings
{
    public bool Marketing { get; set; }
    public bool Product { get; set; }
    public bool Security { get; set; } = true;
}

// DbContext & boilerplate omitted

// PUT – full replace (reject if required fields missing)
app.MapPut("/profiles/{id:guid}", async (Guid id, Profile input, AppDbContext db) =>
{
    var entity = await db.Profiles.FindAsync(id);
    if (entity is null) return Results.NotFound();

    // Full replace (only example fields shown)
    entity.Name = input.Name;
    entity.Email = input.Email;
    entity.NotificationSettings = input.NotificationSettings;
    entity.Addresses = input.Addresses;
    await db.SaveChangesAsync();
    return Results.NoContent();
});

// PATCH – merge patch for large doc (only changed fields supplied)
app.MapMethods("/profiles/{id:guid}", new[]{"PATCH"}, async (Guid id, HttpRequest req, AppDbContext db) =>
{
    if (!req.ContentType?.Contains("application/merge-patch+json", StringComparison.OrdinalIgnoreCase) ?? true)
        return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);

    var entity = await db.Profiles.FindAsync(id);
    if (entity is null) return Results.NotFound();

    using var reader = new StreamReader(req.Body);
    var json = await reader.ReadToEndAsync();
    using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = false });
    var root = doc.RootElement;

    if (root.TryGetProperty("notificationSettings", out var notifEl))
    {
        if (notifEl.TryGetProperty("marketing", out var m)) entity.NotificationSettings.Marketing = m.GetBoolean();
        if (notifEl.TryGetProperty("product", out var p)) entity.NotificationSettings.Product = p.GetBoolean();
        if (notifEl.TryGetProperty("security", out var s)) entity.NotificationSettings.Security = s.GetBoolean();
    }

    // Add more targeted field updates (avoid deserializing full large object)

    await db.SaveChangesAsync();
    return Results.NoContent();
});
```

### Why Parse Manually?

For very large JSON you can avoid allocating a full object graph by walking `JsonDocument` and touching only relevant sections. This reduces:

- Deserialization CPU
- LOH / large object allocations
- GC pressure

If you need more complex partial application, map changed subtrees to small DTOs instead of the entire root model.

## Performance Techniques

| Technique | Applies To | Benefit |
|-----------|-----------|---------|
| Gzip/Brotli | PUT & PATCH | 60–90% size reduction on text JSON |
| Merge Patch | Partial updates | Only send changed branches |
| Streaming read (JsonDocument) | Large PATCH | Avoid full model binding cost |
| Field-level validation | PATCH | Skip validating untouched sections |
| Split large binary fields | PUT | Upload binaries separately (object stores) to shrink JSON |
| Pagination of nested arrays | PUT & PATCH | Update slices instead of whole large arrays |

## Anti‑Patterns (Large Payloads)

| Anti‑Pattern | Why it Hurts | Fix |
|--------------|--------------|-----|
| Partial PUT (omits large arrays) | Accidental data loss | Use PATCH or send full, validated snapshot |
| Sending whole 500KB doc for 1 flag | Wastes bandwidth & CPU | Use PATCH with 1–2KB diff |
| Mixing JSON Patch & Merge Patch | Client confusion, inconsistent tooling | Pick one (prefer Merge Patch) |
| Re-deserializing full doc for PATCH | Unnecessary CPU / allocations | Targeted subtree parsing |
| Embedding large base64 blobs inline | Inflates document | Store externally, reference IDs |

## Decision Heuristic

| Scenario | Preferred | Rationale |
|----------|----------|-----------|
| Initial create | POST (full) | Need entire representation |
| Bulk structural change (many fields) | PUT | Simpler than huge patch diff |
| Single flag/setting toggles | PATCH | Small payload |
| Clearing one optional field | PATCH | Explicit and minimal |
| Client always holds full source of truth | PUT | Simpler client; accept bandwidth cost if infrequent |
| High-frequency tiny modifications | PATCH | Network & CPU savings |

## Checklist

- [ ] Decide primary PATCH media type (merge patch)|
- [ ] Add server enforcement for Content-Type on PATCH |
- [ ] Implement targeted JSON parsing for very large objects |
- [ ] Document partial update examples (before/after sizes) |
- [ ] Reject partial PUT bodies (require full shape) |
- [ ] Enable compression (server + clients) |
- [ ] Avoid embedding big binaries in JSON |

## Further Reading

- RFC 7396 – JSON Merge Patch: https://www.rfc-editor.org/rfc/rfc7396
- RFC 6902 – JSON Patch: https://www.rfc-editor.org/rfc/rfc6902
- ASP.NET Core performance docs: https://learn.microsoft.com/aspnet/core/performance

---

Focus the effort where size & frequency meet. If a payload is huge and updates are small, make PATCH cheap; if updates rewrite the whole structure, embrace PUT and optimize serialization.

1) The entity and DTOs
// Entity
public sealed class Client
{
    public Guid Id { get; set; }
    public string DisplayName { get; set; } = default!;
    public string Email { get; set; } = default!;
    public string? Phone { get; set; }
    public bool IsActive { get; set; } = true;

    // Concurrency token
    [Timestamp]
    public byte[] RowVersion { get; set; } = Array.Empty<byte>();
}

// Replace DTO (for PUT)
public sealed class ClientReplaceDto
{
    public string DisplayName { get; set; } = default!;
    public string Email { get; set; } = default!;
    public string? Phone { get; set; }
    public bool IsActive { get; set; }
}

// Partial DTO (for PATCH - merge patch shape)
public sealed class ClientPatchDto
{
    public string? DisplayName { get; set; }
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public bool? IsActive { get; set; }
}

2) DbContext with concurrency
public sealed class AppDbContext : DbContext
{
    public DbSet<Client> Clients => Set<Client>();

    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Client>()
            .Property(c => c.RowVersion)
            .IsRowVersion()
            .IsConcurrencyToken();
    }
}

3) ETag helpers
public static class ETag
{
    public static string FromRowVersion(byte[] rowVersion) =>
        $"W/\"{Convert.ToBase64String(rowVersion)}\""; // weak ETag is fine

    public static bool TryParseIfMatch(string? ifMatchHeader, out byte[]? expectedRowVersion)
    {
        expectedRowVersion = null;
        if (string.IsNullOrWhiteSpace(ifMatchHeader)) return false;

        // Accept W/"base64" or "base64"
        var token = ifMatchHeader.Trim();
        var firstQuote = token.IndexOf('"');
        var lastQuote  = token.LastIndexOf('"');
        if (firstQuote < 0 || lastQuote <= firstQuote) return false;

        var b64 = token[(firstQuote + 1)..lastQuote];
        try
        {
            expectedRowVersion = Convert.FromBase64String(b64);
            return true;
        }
        catch { return false; }
    }
}

4) GET with ETag
app.MapGet("/clients/{id:guid}", async (Guid id, AppDbContext db, HttpResponse resp) =>
{
    var entity = await db.Clients.FindAsync(id);
    if (entity is null) return Results.NotFound();

    resp.Headers.ETag = ETag.FromRowVersion(entity.RowVersion);

    var dto = new ClientReplaceDto
    {
        DisplayName = entity.DisplayName,
        Email = entity.Email,
        Phone = entity.Phone,
        IsActive = entity.IsActive
    };

    return Results.Ok(dto);
});

5) PUT (full replace, requires If-Match)

Rules:

Caller must send If-Match.

Body must include all required fields.

We reject any unknown properties via JSON options if you want stricter behaviour.

On missing resource, either create (upsert) or reject with 404. I recommend no upsert unless you have a strong reason.

app.MapPut("/clients/{id:guid}", async (Guid id, HttpRequest req, AppDbContext db, ClientReplaceDto body) =>
{
    if (!ETag.TryParseIfMatch(req.Headers.IfMatch, out var expected))
        return Results.Problem(
            title: "Missing or invalid If-Match header",
            statusCode: StatusCodes.Status428PreconditionRequired);

    var entity = await db.Clients.FindAsync(id);
    if (entity is null) return Results.NotFound();

    // Concurrency check upfront
    if (!entity.RowVersion.SequenceEqual(expected!))
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);

    // Replace semantics
    entity.DisplayName = body.DisplayName;
    entity.Email       = body.Email;
    entity.Phone       = body.Phone;
    entity.IsActive    = body.IsActive;

    try
    {
        await db.SaveChangesAsync();
    }
    catch (DbUpdateConcurrencyException)
    {
        return Results.StatusCode(StatusCodes.Status409Conflict);
    }

    return Results.NoContent(); // PUT is idempotent; 204 is fine
});


Note: If you must support upsert, require If-None-Match: * on create and return 201 Created with ETag.

6) PATCH (choose one style)
Option A: JSON Merge Patch (application/merge-patch+json)

Simple: fields omitted = untouched; fields present with null = explicitly null.

Good fit for most CRUD with predictable shapes.

app.MapMethods("/clients/{id:guid}", new[] { "PATCH" }, async (Guid id, HttpRequest req, AppDbContext db) =>
{
    if (!ETag.TryParseIfMatch(req.Headers.IfMatch, out var expected))
        return Results.Problem("Missing or invalid If-Match header", statusCode: 428);

    if (!req.ContentType?.Contains("application/merge-patch+json", StringComparison.OrdinalIgnoreCase) ?? true)
        return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);

    var entity = await db.Clients.FindAsync(id);
    if (entity is null) return Results.NotFound();

    if (!entity.RowVersion.SequenceEqual(expected!))
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);

    // Read patch document
    using var sr = new StreamReader(req.Body);
    var json = await sr.ReadToEndAsync();
    var patch = JsonSerializer.Deserialize<ClientPatchDto>(json, new JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true
    });
    if (patch is null) return Results.BadRequest("Invalid patch payload");

    // Apply partials
    if (patch.DisplayName is not null) entity.DisplayName = patch.DisplayName;
    if (patch.Email is not null)       entity.Email = patch.Email;
    if (patch.Phone != null)           entity.Phone = patch.Phone; // explicit null supported
    if (patch.IsActive.HasValue)       entity.IsActive = patch.IsActive.Value;

    // Example of domain validation only on changed fields
    if (patch.Email is not null && !patch.Email.Contains('@'))
        return Results.UnprocessableEntity(new { field = "email", error = "Invalid email" });

    try { await db.SaveChangesAsync(); }
    catch (DbUpdateConcurrencyException) { return Results.StatusCode(409); }

    return Results.NoContent();
});

Option B: JSON Patch (application/json-patch+json)

Powerful for targeted operations (add, remove, replace, test).

More to validate; easier to create foot-guns.

using Microsoft.AspNetCore.JsonPatch;
using Microsoft.AspNetCore.Mvc;

app.MapMethods("/clients/{id:guid}/ops", new[] { "PATCH" }, async (
    Guid id, HttpRequest req, AppDbContext db, [FromBody] JsonPatchDocument<ClientReplaceDto> patch) =>
{
    if (!ETag.TryParseIfMatch(req.Headers.IfMatch, out var expected))
        return Results.Problem("Missing or invalid If-Match header", statusCode: 428);

    if (!req.ContentType?.Contains("application/json-patch+json", StringComparison.OrdinalIgnoreCase) ?? true)
        return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);

    var entity = await db.Clients.FindAsync(id);
    if (entity is null) return Results.NotFound();

    if (!entity.RowVersion.SequenceEqual(expected!))
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);

    // Map to “replace DTO” to keep validation rules coherent
    var dto = new ClientReplaceDto
    {
        DisplayName = entity.DisplayName,
        Email       = entity.Email,
        Phone       = entity.Phone,
        IsActive    = entity.IsActive
    };

    patch.ApplyTo(dto);

    // Validate post-apply
    if (string.IsNullOrWhiteSpace(dto.DisplayName))
        return Results.UnprocessableEntity(new { field = "displayName", error = "DisplayName is required" });

    entity.DisplayName = dto.DisplayName;
    entity.Email       = dto.Email;
    entity.Phone       = dto.Phone;
    entity.IsActive    = dto.IsActive;

    try { await db.SaveChangesAsync(); }
    catch (DbUpdateConcurrencyException) { return Results.StatusCode(409); }

    return Results.NoContent();
});

7) Wiring JSON options (optional strictness)
builder.Services.ConfigureHttpJsonOptions(opts =>
{
    opts.SerializerOptions.ReadCommentHandling = JsonCommentHandling.Disallow;
    opts.SerializerOptions.AllowTrailingCommas = false;
    // For PUT endpoints you can enable UnknownTypeHandling or custom validation to reject unknown props.
});

Failure modes & observability
Failure modes

Silent field nulling (what bit us): Using PUT with partial body.
Prevention: Reject PUT bodies missing required fields; provide schema examples; insist on PATCH for partials.

Lost update races: No If-Match.
Prevention: Require If-Match on PUT/PATCH; return 412 Precondition Failed on mismatch.

Ambiguous PATCH media type: Treating any JSON as a patch.
Prevention: Enforce Content-Type of application/merge-patch+json or application/json-patch+json; otherwise 415.

Invalid patch operations (JSON Patch): Bad paths or forbidden changes (e.g., immutable fields).
Prevention: Whitelist paths; reject ops on immutable fields with 422.

Idempotency regressions: PATCH retried on network failure may apply twice.
Prevention: Encourage clients to use test ops (JSON Patch) or include If-Match always; consider idempotency keys for side-effecty operations.

Over-validation: Treating partials like full replace.
Prevention: Different validation profiles; only validate fields that changed for merge-patch.

Metrics & alerts

Rate of 412/409 per route (trend and sudden spikes).

Unsupported media type (415) count (indicates misconfigured clients).

Validation failures (422) by field (data quality).

Average patch document size & op count (operational complexity).

Mean time between conflicting writes (proxy for contention).

Logs (structured)

requestId, route, verb, contentType, etag_in, etag_out, status, conflictReason.

For JSON Patch: opsCount, paths (limited, no PII).

Correlation IDs across your integration boundary (e.g., when calling QBO).

What I’d do differently next time

Pick one PATCH style per boundary. For partner APIs, merge-patch is simpler and safer. Internally, JSON Patch is fine if you enforce strict path rules.

Ban partial PUTs in CI. Contract tests that send incomplete bodies to PUT must fail builds.

Document with examples + cURL. Show both success and failure flows, including ETag round-trip.

Guard rails in clients. Provide a thin SDK that always sets If-Match and correct Content-Type.

Checklist to apply tomorrow

Return ETag on GET; require If-Match on PUT/PATCH.

PUT = full replace; reject missing required fields.

Choose one PATCH style and enforce Content-Type.

Separate validation profiles: replace vs partial.

Emit structured logs and track 412/409/415/422.

Write contract tests to prevent partial PUTs.

Document examples for ETag/If-Match and typical failures.

Meta

Links & further reading

RFC 7231 (HTTP Semantics): [link]

RFC 7396 (JSON Merge Patch): [link]

RFC 6902 (JSON Patch): [link]

ASP.NET Core JsonPatchDocument: [link]

ETags & conditional requests in REST: [link]

Call to action: If you maintain an API, tighten your PUT/PATCH semantics this week—your downstream integrations (and future you) will thank you.