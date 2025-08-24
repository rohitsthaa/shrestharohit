---
title: "From HTML Pain to QuestPDF: Cleaner Invoice Generation in .NET"
description: "Why we replaced brittle HTML-to-PDF templates with a fluent C# document pipeline using QuestPDF—example, observability, migration checklist."
pubDate: 2025-08-24
draft: false
tags: [".net","pdf","questpdf","invoices"]
---

For years, our invoice PDFs were born from the **HTML → PDF pipeline**. It worked, but it was brittle. A tiny CSS tweak could break layout. Rendering engines behaved differently. Designing a custom invoice meant bending HTML into shapes it was never meant to take.

We needed more control. Enter **[QuestPDF](https://www.questpdf.com/)**.

Instead of hacking CSS, QuestPDF lets you describe a document directly in C#. Layouts are fluent, composable, and predictable. No headless browsers. No pixel‑perfect fights. Just a library designed to produce PDFs.

---

## Why QuestPDF Worked

1. **Flexibility** – invoices are documents, not web pages.
2. **Maintainability** – layout logic lives in versioned C# code.
3. **Performance** – no headless Chrome startup tax.
4. **Reusability** – shared components (headers, tables, footers) compose cleanly.

---

## Minimal Example

Here’s a stripped‑down invoice using QuestPDF:

```csharp
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

public class InvoiceDocument : IDocument
{
    public void Compose(IDocumentContainer container)
    {
        container.Page(page =>
        {
            page.Margin(40);
            page.Size(PageSizes.A4);

            page.Header().Text("Invoice").FontSize(20).Bold();

            page.Content().Column(col =>
            {
                col.Spacing(10);

                col.Item().Text("Client: Example Corp");
                col.Item().Text("Date: " + DateTime.UtcNow.ToShortDateString());

                col.Item().Table(table =>
                {
                    table.ColumnsDefinition(cols =>
                    {
                        cols.RelativeColumn(3);
                        cols.RelativeColumn();
                    });

                    table.Cell().Text("Description");
                    table.Cell().Text("Amount");

                    table.Cell().Text("Consulting Services");
                    table.Cell().Text("$500");
                });
            });

            page.Footer().AlignCenter().Text(text =>
            {
                text.Span("Page ");
                text.CurrentPageNumber();
                text.Span(" of ");
                text.TotalPages();
            });
        });
    }
}
```

This produces a clean, single‑page invoice with header, table, and footer—no HTML/CSS.

---

## Observability & Failure Modes

| Aspect | What to Track | Notes |
| ------ | ------------- | ----- |
| Logs | Start/finish events with correlation ID | Include template name & duration |
| Data Gaps | Empty sections / zero line items | Pre-render validation prevents blank PDFs |

Common failure: malformed or missing line items → empty tables. Mitigate by validating inputs (non-empty collection, numeric totals) before calling `Compose`.

---

## What I’d Do Differently (If Starting Again)

* Adopt QuestPDF earlier—weeks lost tweaking CSS.
* Factor components immediately (e.g. `InvoiceHeader()`, `Tables` helpers).
* Add metrics on day one (generation time, page count) to guard against regression.
* Property-driven tests for currency formatting & totals.

---

## Migration Checklist

- [ ] Pick one noisy HTML template (highest change rate) and port it.
- [ ] Wrap existing HTML pipeline behind an interface; introduce QuestPDF implementation.
- [ ] Add structured logging (template, duration, bytes).
- [ ] Create reusable components (header, table, totals, footer).
- [ ] Add validation layer (domain object → DTO for PDF).
- [ ] Benchmark generation (p95 latency vs legacy).
- [ ] Remove legacy HTML path after parity + burn-in period.


---

## Architecture Fit (Example Flow)

```
web-app/api  →  invoice-service  →  questpdf renderer  →  object storage (S3)  →  notification/email
                              ↘ metrics/logs  ↙
```

*Async generation* (queue trigger) helps if invoices can spike. Embed correlation ID through the chain.

---

## Resources

- QuestPDF Docs: https://www.questpdf.com/
- GitHub: https://github.com/QuestPDF/QuestPDF
- Performance Tips: Enable release builds + server GC.

---

If you’re still battling HTML‑to‑PDF conversions, try QuestPDF. It turned invoice generation from frustration into a straightforward, maintainable process.