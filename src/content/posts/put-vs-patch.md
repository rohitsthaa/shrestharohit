---
title: "PATCH vs PUT in the Real World: Lessons from a Broken Update"
description: "Designing correct PUT vs PATCH strategies in ASP.NET Core: full replace semantics, partial updates with merge patch, ETag-based concurrency, and how to avoid silent data loss."
pubDate: 2025-08-27
updatedDate: 2025-08-27
tags: [".net","aspnet-core","rest","http","patch","put","jsonpatch","concurrency","etag"]
draft: false
---

When objects are small (a few KB) the distinction between PUT and PATCH is mostly semantic. When objects are large—or when multiple clients write concurrently—the choice directly affects data integrity.

| Axis | PUT (full replace) | PATCH (partial) |
|------|--------------------|-----------------|
| Bandwidth | Scales with full object size every update | Scales with changed fields only |
| Latency | Larger upload & serialization cost | Typically lower (smaller payload) |
| Server cost | Full revalidation + full model binding | Targeted validation; smaller model binding surface |
| Write amplification | Overwrites unchanged columns / JSON blobs | Touches only modified data (if applied carefully) |
| Simplicity | Easier for clients (send whole doc) | Slightly harder (compute diff) |
| Risk on omission | Accidental data loss if field omitted | Safer (omit means unchanged) |

## Core Guidance

1. Use **PATCH** for frequent small changes to large documents (e.g., updating one field in a 600KB profile).
2. Use **PUT** when clients naturally maintain a full canonical snapshot (e.g., config editors saving an entire form).
3. Never send unchanged large arrays or blobs in PUT if a PATCH for the single field would do.
4. Compress over the wire (`Content-Encoding: gzip` or `br`) for both verbs.
5. Require `If-Match` on both PUT and PATCH to prevent lost-update races.
6. Accept only one PATCH media type per endpoint to keep the surface area small.

## Choosing a PATCH Format

| Format | Media Type | Pros | Cons |
|--------|------------|------|------|
| JSON Merge Patch | `application/merge-patch+json` | Minimal diff authoring; natural for shallow objects | `null` means delete; entire sub-object gets replaced |
| JSON Patch | `application/json-patch+json` | Explicit operations (`add`, `remove`, `replace`, `test`) | Verbose; path correctness overhead |

For most large JSON documents with shallow updates, **merge patch is the right default**.

## Example Domain

A `Client` resource — small enough to reason about, but the patterns scale to 500KB documents.

### 1. Entities and DTOs

```csharp
// Entity
public sealed class Client
{
    public Guid Id { get; set; }
    public string DisplayName { get; set; } = default!;
    public string Email { get; set; } = default!;
    public string? Phone { get; set; }
    public bool IsActive { get; set; } = true;

    [Timestamp]
    public byte[] RowVersion { get; set; } = Array.Empty<byte>();
}

// Full-replace DTO (for PUT)
public sealed class ClientReplaceDto
{
    public string DisplayName { get; set; } = default!;
    public string Email { get; set; } = default!;
    public string? Phone { get; set; }
    public bool IsActive { get; set; }
}

// Partial DTO (for PATCH — nullable = "not provided")
public sealed class ClientPatchDto
{
    public string? DisplayName { get; set; }
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public bool? IsActive { get; set; }
}
```

### 2. DbContext with Concurrency

```csharp
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
```

### 3. ETag Helpers

```csharp
public static class ETag
{
    public static string FromRowVersion(byte[] rowVersion) =>
        $"W/\"{Convert.ToBase64String(rowVersion)}\"";

    public static bool TryParseIfMatch(string? ifMatchHeader, out byte[]? expectedRowVersion)
    {
        expectedRowVersion = null;
        if (string.IsNullOrWhiteSpace(ifMatchHeader)) return false;

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
```

### 4. GET with ETag

```csharp
app.MapGet("/clients/{id:guid}", async (Guid id, AppDbContext db, HttpResponse resp) =>
{
    var entity = await db.Clients.FindAsync(id);
    if (entity is null) return Results.NotFound();

    resp.Headers.ETag = ETag.FromRowVersion(entity.RowVersion);

    return Results.Ok(new ClientReplaceDto
    {
        DisplayName = entity.DisplayName,
        Email = entity.Email,
        Phone = entity.Phone,
        IsActive = entity.IsActive
    });
});
```

### 5. PUT — Full Replace

Rules: caller must send `If-Match`; body must include all required fields; no upsert unless you have a strong reason.

```csharp
app.MapPut("/clients/{id:guid}", async (Guid id, HttpRequest req, AppDbContext db, ClientReplaceDto body) =>
{
    if (!ETag.TryParseIfMatch(req.Headers.IfMatch, out var expected))
        return Results.Problem(
            title: "Missing or invalid If-Match header",
            statusCode: StatusCodes.Status428PreconditionRequired);

    var entity = await db.Clients.FindAsync(id);
    if (entity is null) return Results.NotFound();

    if (!entity.RowVersion.SequenceEqual(expected!))
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);

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

    return Results.NoContent();
});
```

### 6. PATCH — Merge Patch

```csharp
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

    using var sr = new StreamReader(req.Body);
    var json = await sr.ReadToEndAsync();
    var patch = JsonSerializer.Deserialize<ClientPatchDto>(json, new JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true
    });
    if (patch is null) return Results.BadRequest("Invalid patch payload");

    if (patch.DisplayName is not null) entity.DisplayName = patch.DisplayName;
    if (patch.Email is not null)       entity.Email = patch.Email;
    if (patch.Phone != null)           entity.Phone = patch.Phone;
    if (patch.IsActive.HasValue)       entity.IsActive = patch.IsActive.Value;

    if (patch.Email is not null && !patch.Email.Contains('@'))
        return Results.UnprocessableEntity(new { field = "email", error = "Invalid email" });

    try { await db.SaveChangesAsync(); }
    catch (DbUpdateConcurrencyException) { return Results.StatusCode(409); }

    return Results.NoContent();
});
```

### 7. JSON Options (Optional Strictness)

```csharp
builder.Services.ConfigureHttpJsonOptions(opts =>
{
    opts.SerializerOptions.ReadCommentHandling = JsonCommentHandling.Disallow;
    opts.SerializerOptions.AllowTrailingCommas = false;
});
```

## Performance Techniques for Large Payloads

| Technique | Applies To | Benefit |
|-----------|-----------|---------|
| Gzip/Brotli | PUT & PATCH | 60–90% size reduction on text JSON |
| Merge Patch | Partial updates | Only send changed branches |
| Streaming read (`JsonDocument`) | Large PATCH | Avoid full model binding cost |
| Field-level validation | PATCH | Skip validating untouched sections |
| Split large binary fields | PUT | Upload binaries separately to shrink JSON |
| Pagination of nested arrays | PUT & PATCH | Update slices instead of whole large arrays |

For very large JSON you can avoid allocating a full object graph by walking `JsonDocument` and touching only relevant sections. This reduces deserialization CPU, LOH allocations, and GC pressure. If you need more complex partial application, map changed subtrees to small DTOs instead of the entire root model.

## Anti‑Patterns

| Anti‑Pattern | Why it Hurts | Fix |
|--------------|--------------|-----|
| Partial PUT (omits required fields) | Silent data loss | Use PATCH or send full validated snapshot |
| Sending whole 500KB doc for 1 flag | Wastes bandwidth & CPU | Use PATCH with 1–2KB diff |
| No `If-Match` on mutations | Lost-update races | Require ETag round-trip |
| Mixing JSON Patch & Merge Patch | Client confusion | Pick one per endpoint |
| Re-deserializing full doc for PATCH | Unnecessary allocations | Targeted subtree parsing |
| Embedding large base64 blobs inline | Inflates document | Store externally, reference IDs |

## Decision Heuristic

| Scenario | Preferred | Rationale |
|----------|----------|-----------|
| Initial create | POST (full) | Need entire representation |
| Bulk structural change (many fields) | PUT | Simpler than huge patch diff |
| Single flag/setting toggle | PATCH | Small payload |
| Clearing one optional field | PATCH | Explicit and minimal |
| Client always holds full source of truth | PUT | Simpler client; accept bandwidth cost if infrequent |
| High-frequency tiny modifications | PATCH | Network & CPU savings |

## Failure Modes & Observability

**Failure modes to guard against:**

- **Silent field nulling** — PUT with partial body overwrites fields to null. Fix: reject PUT bodies missing required fields; enforce schema validation.
- **Lost-update races** — No `If-Match`. Fix: require `If-Match` on PUT/PATCH; return `412 Precondition Failed` on mismatch.
- **Ambiguous PATCH media type** — Treating any JSON as a patch. Fix: enforce `Content-Type: application/merge-patch+json`; otherwise return `415`.
- **Invalid JSON Patch operations** — Bad paths or writes to immutable fields. Fix: whitelist paths; reject forbidden ops with `422`.
- **Double-apply on retry** — PATCH retried on network failure may apply twice. Fix: use `If-Match` always; consider idempotency keys for side-effectful operations.
- **Over-validation** — Treating partials like a full replace. Fix: separate validation profiles for replace vs. partial.

**Metrics to track:**

- Rate of `412`/`409` per route (trend and sudden spikes signal contention)
- `415` count (indicates misconfigured clients)
- `422` validation failures by field (data quality signal)
- Average patch document size (operational complexity)
- Mean time between conflicting writes (proxy for write contention)

**Structured log fields:** `requestId`, `route`, `verb`, `contentType`, `etag_in`, `etag_out`, `status`, `conflictReason`. For JSON Patch: `opsCount`, `paths` (limited, no PII).

## What I'd Do Differently

- **Pick one PATCH style per boundary.** For partner APIs, merge patch is simpler and safer. Internally, JSON Patch is fine if you enforce strict path rules.
- **Ban partial PUTs in CI.** Contract tests that send incomplete bodies to PUT endpoints should fail builds.
- **Document with examples and cURL.** Show both success and failure flows, including the full ETag round-trip.
- **Guard rails in clients.** Provide a thin SDK that always sets `If-Match` and the correct `Content-Type`.

## Checklist

- [ ] Return `ETag` on GET; require `If-Match` on PUT/PATCH
- [ ] PUT = full replace; reject missing required fields
- [ ] Choose one PATCH style and enforce `Content-Type`
- [ ] Separate validation profiles: replace vs. partial
- [ ] Enable Gzip/Brotli compression on the server
- [ ] Emit structured logs and track `412`/`409`/`415`/`422`
- [ ] Write contract tests to prevent partial PUTs from passing
- [ ] Document ETag round-trip examples for client teams

## Further Reading

- [RFC 7396 – JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396)
- [RFC 6902 – JSON Patch](https://www.rfc-editor.org/rfc/rfc6902)
- [RFC 7232 – HTTP Conditional Requests (ETags)](https://www.rfc-editor.org/rfc/rfc7232)
- [RFC 7231 – HTTP Semantics](https://www.rfc-editor.org/rfc/rfc7231)
- [ASP.NET Core JsonPatchDocument docs](https://learn.microsoft.com/en-us/aspnet/core/web-api/jsonpatch)
- [MDN – HTTP Conditional Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Conditional_requests)

---

Focus the effort where size and frequency meet. If a payload is huge and updates are small, make PATCH cheap. If updates rewrite the whole structure, embrace PUT and enforce `If-Match` to keep concurrent writers honest.
