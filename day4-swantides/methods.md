# Day 4 — Swan River Tides 2026

**Author:** Patrick Morrison

## Purpose

We often have fieldwork that requires specific tide conditions—high or low tide, ideally falling within business hours or a good time after work. Scanning through PDF tide charts page by page is tedious. This tool provides a quick way to filter the entire year's tides by height, time of day, and tide type.

## Data Source

Tide predictions from the **Bureau of Meteorology** (Australian Government).

- Fremantle: [IDO59001_2026_WA_TP015.pdf](https://www.bom.gov.au/oceanography/projects/ntc/wa_tide_tables.shtml)
- Barrack Street Jetty: [IDO59001_2026_WA_TP062.pdf](https://www.bom.gov.au/oceanography/projects/ntc/wa_tide_tables.shtml)

**Datum:** Chart Datum  
**Times:** Local standard time (UTC+08:00)

---

## Processing

Unfortunately, BOM publishes tide predictions as PDF charts rather than machine-readable data files. To extract the data:

1. **PDF Extraction:** A Python script (`extract_tides.py`) using `pdfplumber` parses the PDF pages, identifies column positions, and extracts day numbers, times, and heights.

2. **Text Merging:** The PDF sometimes merges text tokens (e.g., "TU1413" instead of "TU 1413"). The script handles these edge cases with regex pattern matching.

3. **Tide Classification:** High/low tide types are inferred from the height relative to neighbouring values.

4. **Validation:** The script checks for 365 days of coverage and flags any suspicious tide counts.

This extraction process was prone to mistakes and required significant tweaking and verification. Some days with 5+ tides (typical of complex diurnal/semi-diurnal patterns) still trigger warnings but are valid data.

---

## Tech Stack

HTML/CSS/JS calendar interface with:
- Dual-handle range sliders for filtering by height and time
- Location switcher loading separate JSON data files
- Responsive grid layout (2 columns on mobile, auto-fit on desktop)
- Sticky filter controls for scanning long month lists

---

## Attribution & Disclaimer

This product is based on Bureau of Meteorology information that has subsequently been modified. The Bureau does not necessarily support or endorse, or have any connection with, the product.

In respect of that part of the information which is sourced from the Bureau, and to the maximum extent permitted by law:

> (i) The Bureau makes no representation and gives no warranty of any kind whether express, implied, statutory or otherwise in respect to the availability, accuracy, currency, completeness, quality or reliability of the information or that the information will be fit for any particular purpose or will not infringe any third party Intellectual Property rights; and
>
> (ii) The Bureau's liability for any loss, damage, cost or expense resulting from use of, or reliance on, the information is entirely excluded.

**© Commonwealth of Australia 2025, Bureau of Meteorology**
