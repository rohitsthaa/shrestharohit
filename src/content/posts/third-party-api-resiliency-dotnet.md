---
title: "Third‑Party APIs in Production: Pragmatic Resiliency Patterns in .NET"
description: "Keep .NET services stable (and polite) when partners rate‑limit, flake, or change contracts: retries, idempotency, backpressure, observability."
pubDate: 2025-08-25T09:00:00+05:45
draft: false
tags: [".net","azure-service-bus","retry","resiliency","qbo","fhir"]
---

> **Takeaway**: Build for *polite persistence*—bounded jittered retries, idempotency, back‑pressure, and first‑class observability—so third‑party API failures never cascade.

## Problem Framing

Third‑party APIs fail in ways your test suite won’t: throttling (429), flaky 5xx, long latency tails, partial truths, silent contract drift.

Constraints:

* You don’t control capacity or deploy cadence on the other side.
* You must avoid duplicated financial actions (payments, invoices, journals).
* You must meet your SLAs without DDoSing partners.
* OAuth lifetimes + clock skew complicate token refresh.

## Architecture Sketch

```
[Producers] → (Command messages) → [Worker Service]
                │                    │
                │                    ├─ Resilient HttpClient (timeouts + retries + idempotency)
                │                    └─ Schedules retryable work
                ↓
        [Azure Service Bus Queue] ⇄ (Scheduled Retries / Backpressure)
                          │
                          └─ [Third‑Party API]
```

Key elements: resilient outbound client, queue‑mediated backpressure, idempotency layer, structured telemetry.

---

## Step‑by‑Step

### 1. Start with Correct `HttpClient` Defaults

```csharp
// Program.cs
builder.Services.AddHttpClient("ExternalApi", client =>
{
    client.Timeout = TimeSpan.FromSeconds(15); // end-to-end per request
    client.DefaultRequestHeaders.UserAgent.ParseAdd("integrations/1.0");
})
.ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
{
    PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
    MaxConnectionsPerServer = 8 // cap host concurrency
})
.AddHttpMessageHandler(() => new RetryHandler(
    maxAttempts: 5,
    baseDelay: TimeSpan.FromSeconds(1),
    maxDelay: TimeSpan.FromMinutes(2)));
```

### 2. Retry Handler (Jitter + Retry-After)

Retry only idempotent operations (GET/HEAD or those explicitly marked). Honor `Retry-After` for 429/503.

```csharp
public sealed class RetryHandler : DelegatingHandler
{
    private readonly int _maxAttempts;
    private readonly TimeSpan _baseDelay;
    private readonly TimeSpan _maxDelay;
    private static readonly HttpStatusCode[] Transient =
    {
        HttpStatusCode.RequestTimeout,
        HttpStatusCode.TooManyRequests,
        HttpStatusCode.BadGateway,
        HttpStatusCode.ServiceUnavailable,
        HttpStatusCode.GatewayTimeout
    };

    public RetryHandler(int maxAttempts, TimeSpan baseDelay, TimeSpan maxDelay)
        => (_maxAttempts, _baseDelay, _maxDelay) = (maxAttempts, baseDelay, maxDelay);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        bool idempotent = request.Method == HttpMethod.Get ||
            request.Options.TryGetValue(new HttpRequestOptionsKey<bool>("Idempotent"), out var idem) && idem;

        for (int attempt = 1; ; attempt++)
        {
            var response = await base.SendAsync(request, ct);
            if (!ShouldRetry(response, idempotent) || attempt >= _maxAttempts)
                return response;

            var delay = ComputeDelay(response, attempt);
            await Task.Delay(delay, ct);
        }
    }

    private static bool ShouldRetry(HttpResponseMessage resp, bool idempotent)
        => idempotent && Transient.Contains(resp.StatusCode);

    private TimeSpan ComputeDelay(HttpResponseMessage resp, int attempt)
    {
        if (resp.Headers.RetryAfter is { } ra)
        {
            if (ra.Delta is not null) return Cap(ra.Delta.Value);
            if (ra.Date is not null)
            {
                var delta = ra.Date.Value - DateTimeOffset.UtcNow;
                if (delta > TimeSpan.Zero) return Cap(delta);
            }
        }
        var max = Math.Min(_maxDelay.TotalMilliseconds, _baseDelay.TotalMilliseconds * Math.Pow(2, attempt));
        return TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * max); // full jitter
    }

    private TimeSpan Cap(TimeSpan v) => v > _maxDelay ? _maxDelay : v;
}
```

> For POSTs that are idempotent on *your* side (e.g. payment with deterministic key), set `Idempotent=true` via `request.Options`.

### 3. Idempotency End‑to‑End

Outbound — deterministic key:

```csharp
using var request = new HttpRequestMessage(HttpMethod.Post, "/payments");
request.Content = JsonContent.Create(body);
request.Headers.Add("Idempotency-Key", $"{companyId}:{invoiceId}:{amountCents}");
request.Options.Set(new HttpRequestOptionsKey<bool>("Idempotent"), true);
```

Inbound — persist `(companyId, invoiceId, amount)` hash → canonical result; on replay return cached result.

### 4. Queue‑Based Backpressure (Azure Service Bus)

```csharp
public async Task HandleAsync(ServiceBusReceivedMessage msg, CancellationToken ct)
{
    try
    {
        await _processor.ProcessAsync(msg, ct);
        await _receiver.CompleteMessageAsync(msg, ct);
    }
    catch (TooManyRequestsException ex)
    {
        var delay = ex.RetryAfter ?? TimeSpan.FromMinutes(5);
        await _sender.ScheduleMessageAsync(new ServiceBusMessage(msg.Body)
        {
            Subject = msg.Subject,
            CorrelationId = msg.CorrelationId,
            ApplicationProperties = { ["retry"] = Increment(msg) }
        }, DateTimeOffset.UtcNow.Add(delay), ct);
        await _receiver.CompleteMessageAsync(msg, ct); // rescheduled
    }
}
```

### 5. OAuth Tokens Without Drama

Single‑flight refresh + slack for clock skew.

```csharp
public sealed class OAuthTokenCache
{
    private readonly SemaphoreSlim _refreshLock = new(1,1);
    private Token? _cached;

    public async ValueTask<string> GetAsync(Func<Task<Token>> refresh, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        if (_cached is { ExpiresAtUtc: var exp } && exp - now > TimeSpan.FromMinutes(2))
            return _cached.AccessToken;

        await _refreshLock.WaitAsync(ct);
        try
        {
            if (_cached is { ExpiresAtUtc: var exp2 } && exp2 - DateTimeOffset.UtcNow > TimeSpan.FromMinutes(2))
                return _cached.AccessToken;
            _cached = await refresh();
            return _cached.AccessToken;
        }
        finally { _refreshLock.Release(); }
    }

    public sealed record Token(string AccessToken, DateTimeOffset ExpiresAtUtc);
}
```

### 6. Prevent Silent Contract Drift

* Request/response validators (light schema assertions).
* Partner‑scoped feature flags for version pins & optional fields.
* Canary subset on new versions + sample payload archiving for diff.

### 7. Defensive Timeouts & Budgets

```csharp
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
await _invoiceGenerator.RunAsync(companyId, cts.Token);
```

Budget each unit of work; propagate a linked cancellation token.

---

## Failure Modes & Observability

| Dimension | Metric / Signal | Purpose |
| --------- | --------------- | ------- |
| Throttling | 429 rate per partner | Alert on sustained spikes |
| Availability | 5xx rate, p95 latency | Detect degradation |
| Retries | Attempts histogram | Tune backoff / spot storms |
| Queue | Age, scheduled backlog | Identify backpressure saturation |
| Tokens | Refresh count / failures | OAuth health |
| Idempotency | Cache hit ratio | Validate retry correctness |

**Alerts**: 429 rate > X% for Y minutes; backlog age threshold; token refresh failures > N/5m; circuit open > 2m.

**Logs**: CorrelationId, attempt, computed delay (ms), reason (429/503/timeout), idempotency key (hashed), redacted payload identifiers only.

**Traces**: span name `external.api/<provider>/<operation>` + attributes: `http.status_code`, `retry_attempt`, `retry_after_ms`, `idempotency_key`.

---

## What I’d Do Differently Next Time

* Introduce a token broker early (central OAuth for all finance connectors).
* Add a lightweight circuit breaker for noisy neighbours to protect shared pools.

## Checklist to Apply Tomorrow

- [ ] Cap `MaxConnectionsPerServer` & set client timeouts.
- [ ] Jittered retries that honor `Retry-After` (only idempotent ops).
- [ ] Send Idempotency-Key + dedupe on our side.
- [ ] Schedule retries (Service Bus) instead of hot loops.
- [ ] Cache OAuth tokens (single‑flight refresh + skew slack).
- [ ] Emit metrics: 429/5xx, retries, backlog age, token refresh.
- [ ] Correlate logs + annotate traces with retry metadata.
- [ ] Add schema checks & sample payload archiving.

## Resources

* Azure Service Bus scheduled messages: https://learn.microsoft.com/azure/service-bus-messaging/message-scheduling
* OpenTelemetry for .NET (getting started): https://opentelemetry.io/docs/languages/net/
* Idempotency patterns (Stripe docs): https://stripe.com/docs/idempotency
* Idempotent API design (AWS architecture blog): https://aws.amazon.com/blogs/architecture/best-practices-for-building-resilient-idempotent-apis/
