---
title: "Bridging DHIS2 & FHIR: Practical Health Data Interoperability in .NET"
description: "Map DHIS2 tracker/event data to FHIR resources (Patient, Observation, DiagnosticReport) using a .NET adapter: architecture, mappers, failure modes, checklist."
pubDate: 2025-08-26
draft: false
tags: [".net","fhir","dhis2","interoperability","healthtech"]
---

> **Hook:** “Why can’t my EMR just see the TB test result already in DHIS2?” Because DHIS2 isn’t natively FHIR and nothing was translating.

## Problem

| Aspect | DHIS2 Strength | Gap for FHIR Interop |
| ------ | -------------- | -------------------- |
| Aggregation | Strong analytics / reporting | FHIR expects resource-level semantics |
| Tracker Data | Rich program events | Not exposed as FHIR resources |
| Coding | Local option sets | Needs SNOMED / LOINC mapping |
| Time | Often local times | FHIR prefers normalized (UTC) timestamps |
| Exchange | Pull/report centric | Other systems want push / subscription style |

Challenges:
* Inconsistent codes (local vs SNOMED/LOINC)
* Incremental sync (lastUpdated) vs bulk bootstrap
* Time zone normalization (store / emit UTC)
* Idempotent upserts (avoid duplicates)

## Architecture Sketch

```
[DHIS2 API] --> [Adapter Service (.NET)] --> [FHIR Resources JSON] --> [National / EMR FHIR Server]
                    |                        \
                    |                         +--> Metrics / Logs / Dead-letter
                    +--> Code Mapping Store
```

Roles:
* **Adapter Service**: Periodically pulls tracker/events (paged + lastUpdated filter), maps to FHIR, upserts.
* **Code Mapping Store**: Local config (JSON / DB) or terminology service for code translation.
* **Observability**: Metrics (mapped %, unmapped codes), structured logs, retry queue (optional).

---

## Mapping Strategy

1. Define explicit mapping contracts per DHIS2 program → FHIR resource(s).
2. Normalize attributes (dates → UTC, gender enumerations, identifier formats).
3. Translate option set codes to standard terminologies (LOINC / SNOMED) via dictionary.
4. Construct FHIR resources using a typed SDK (Firely .NET SDK or HAPI FHIR for other stacks).
5. Upsert (PUT) using stable IDs to ensure idempotency.

### Mapper Interface

```csharp
public interface IFhirMapper<TSource>
{
    Resource Map(TSource source);
}
```

### Patient Mapper (Tracked Entity → Patient)

```csharp
public class PatientMapper : IFhirMapper<Dhis2TrackedEntity>
{
    public Resource Map(Dhis2TrackedEntity e) => new Patient
    {
        Id = e.Id,
        Identifier = new List<Identifier>
        {
            new Identifier("http://mohp.gov.np/patient-id", e.Attributes["nationalId"])
        },
        Name = new List<HumanName>
        {
            new HumanName { Family = e.Attributes["lastName"], Given = new[] { e.Attributes["firstName"] } }
        },
        Gender = e.Attributes["gender"].Equals("male", StringComparison.OrdinalIgnoreCase)
            ? AdministrativeGender.Male : AdministrativeGender.Female,
        BirthDate = e.Attributes["dob"]
    };
}
```

### Observation Mapper (Lab Event → Observation)

```csharp
public class ObservationMapper : IFhirMapper<Dhis2Event>
{
    public Resource Map(Dhis2Event ev) => new Observation
    {
        Id = ev.EventId,
        Status = ObservationStatus.Final,
        Subject = new ResourceReference($"Patient/{ev.TrackedEntityId}"),
        Code = new CodeableConcept("http://loinc.org", "94531-1", "SARS-CoV-2 RNA Pnl"),
        Effective = new FhirDateTime(ev.EventDate.ToUniversalTime()),
        Value = new CodeableConcept(
            "http://snomed.info/sct",
            ev.DataValues["resultCode"],
            ev.DataValues["resultText"])
    };
}
```

### Upload (Idempotent Upsert)

```csharp
public class FhirClientService
{
    private readonly FhirClient _client;
    public FhirClientService(string baseUrl) => _client = new FhirClient(baseUrl);

    public async Task UpsertAsync(Resource resource)
        => await _client.UpdateAsync(resource); // PUT ensures idempotency
}
```

---

## Failure Modes & Mitigations

| Failure | Cause | Mitigation | Metric |
| ------- | ----- | ---------- | ------ |
| Code mismatch | Local option not mapped | Mapping dictionary + alert on unknown | Unmapped code count |
| Time drift | Local timezones | Always convert to UTC at ingestion | % events w/ UTC normalized |
| Partial sync | API timeout / paging stop | LastUpdated checkpoint & resume tokens | Gap minutes since last sync |
| Duplicate resources | Re-sent events | Stable FHIR IDs (PUT) | Duplicate reject count |
| Invalid FHIR | Schema / required fields missing | Pre-upload validation (`Validator.Validate`) | Validation failure count |

Observability additions:
* **Metrics**: mapped_ratio, unmapped_codes, sync_latency_seconds, validation_failures.
* **Logs**: correlation id per sync batch, counts (fetched/processed/failed), first failing event id.
* **Alerts**: unmapped_codes > threshold; validation_failures spike; sync latency SLA breach.

---

## What I’d Do Differently

* Build a small mapping DSL (YAML/JSON) to externalize transformations.
* Integrate a terminology service (SNOMED CT / LOINC) instead of static dictionaries.
* Add FHIR validation gate early (fail fast before sending invalid resources).
* Support streaming / subscription (e.g., DHIS2 change notifications) to cut latency.

## Checklist (Apply Tomorrow)

- [ ] Identify DHIS2 programs → target FHIR resource types.
- [ ] Create mapping dictionaries (local → SNOMED / LOINC).
- [ ] Implement Patient / Observation mappers.
- [ ] Normalize all timestamps to UTC.
- [ ] Idempotent upsert via stable IDs (PUT) + retry policy.
- [ ] Pre-upload validation & metrics instrumentation.
- [ ] Dashboards: mapped %, unmapped codes, sync latency, failures.
- [ ] Alert policies (unmapped surge, validation failures, latency breach).

## Resources

* DHIS2 Developer Docs: https://docs.dhis2.org/
* HL7 FHIR R4 Spec: https://www.hl7.org/fhir/
* Firely .NET SDK: https://github.com/FirelyTeam/firely-net-sdk
* LOINC Codes: https://loinc.org
* SNOMED CT: https://www.snomed.org/snomed-ct

👉 Start small: map one tracker program to one FHIR resource, measure, then expand.