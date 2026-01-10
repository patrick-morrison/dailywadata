# Day 14 - Government Contracts

**Author:** Aren Leishman

Tenders.wa.gov.au is where the government publicizes all awarded contract. Visualising this data can provide insight into how government money gets spent and how resources are assigned. The last 3 months of contracts awarded are published in list form for anyone to download and analyze

[Download from tenders.wa.gov.au](https://www.tenders.wa.gov.au/watenders/contract/list.action?CSRFNONCE=989F6BA946A9238AB3BD6F56211D7A73&action=contract-view&noreset=yes)

**Licence (visualisation):** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

**Data used under fair use**

---

## Processing

The excel report of the last 3 months of contracts was retrieved on the 10-01-2026. THe unneeded columns were removed and the data exported as CSV for compact serving. This data was then sanitized to have newlines in contract names and other special characters removed.

In 2025 some public sector reform has taken place, with the transition period spanning the collected data. To ensure data consistency, the data was manually amended to place contracts listed under the departments old name with the new name. Data where this has occurred has a note next to it listing the old department.

## Tech Stack

- D3.js v7 with d3-sankey for Sankey diagram visualization
- d3-zoom for pan and zoom navigation
- Pure HTML/CSS/JavaScript (no build tools)
- CSV data parsed client-side with custom parser for quoted fields
