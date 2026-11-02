# WMS Query Tools

A browser-based tool for building WMS diagnostic queries. Paste data or fill in fields, pick a mode, and copy the ready-to-run output.

## Tools

| # | Tool | What it does |
|---|---|---|
| 1 | **PRTNUM Formatter** | Formats a pasted part-number list as SQL `in (...)`, plain comma, or a `prtmst` query |
| 2 | **PRTDSC Description Finder** | Generates a `prtdsc` description lookup from a pasted PRTNUM list (es-es or en-us) |
| 3 | **LOCMST Verification Tool** | Verification, operational, capacity, and strategy checks for one or more locations |
| 4 | **Receiving Queries** | Trailer/RDCK entry points with detail, line, inventory-split, and summary shapes |
| 5 | **Shipping Queries** | Trailer/shipment entry points with header, line, picked-LPN, combined, and summary shapes |
| 6 | **Multibox Created Boxes** | Looks up child LPNs created by the Multibox process, by inbound reference or by part |
| 7 | **Putaway Troubleshooting** | Diagnoses ERR 11125 (no storage location) gate by gate: LPN, part, search path, zones, locations |

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Putaway Troubleshooting (tool 7)

Fill in the fields and run one gate at a time in order. Every query returns a `*_check` or `*_result` column: **OK** means move on; anything else names the problem.

| Field | Used by |
|---|---|
| LPN | almost every step |
| Warehouse | almost every step |
| Building | 2C |
| Search path ID | 2B, 2C, 3A, O1 |
| Storage zone | 3B, O2 |

**Gate order:** 1A → 1B → 2A → 2B → 2C → 3A → 3B  
**Optional** (only if all gates say OK): O1 → O2 → O3 → O4 → O5  
**Result:** R2 to confirm the fix worked

`allocate location` (R1) is intentionally never generated because it creates a real allocation and changes data.
