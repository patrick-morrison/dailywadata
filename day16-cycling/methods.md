# Day 16 - Cycle Routes

**Author:** Coen Arrow

### Source Data
Data comes from [data.wa.gov.au](https://data.wa.gov.au/)

- [Metro Cycle Routes](https://catalogue.data.wa.gov.au/dataset/ltcn-dot-043) - Long Term Cycle Network (LTCN) for Perth metropolitan area
- [Regional Cycle Routes](https://catalogue.data.wa.gov.au/en/dataset/regional-long-term-cycle-network-ltcn-dot-036) - Regional cycling infrastructure across Western Australia

**Licence (map & data):** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

The different types of cycle routes can be found [here](https://www.transport.wa.gov.au/getmedia/54bb61d7-856e-4690-ac49-09708a138780/AT_P_WA_CycleNetwork_Hierarchy-FINAL-ua.pdf)

## Data Overview

### Metro Network
- **Features:** 7,531 route segments
- **Coverage:** Perth metropolitan area (33 local government areas)
- **Geometry Type:** LineString (route lines)
- **Key Attributes:**
  - Route_ID: Unique identifier for each route segment
  - LTCN_Name: Status (Draft LTCN or Final LTCN)
  - LGA_Name: Local government area
  - Hierarchy: Route type classification (Primary, Secondary, Local, Transport Trail)
  - Endorsed: Whether route has been endorsed (Yes/No)
  - Shape_Length: Route segment length in degrees

### Regional Network
- **Features:** 3,750 route segments
- **Coverage:** Entire Western Australia
- **Geometry Type:** LineString (route lines)
- **Key Attributes:**
  - Name: Descriptive route name with start/end points
  - Hierarchy: Route type classification (includes Road Cycling Route)
  - Class: Infrastructure class (A, B, or C)
  - Strategy: Regional strategy area (e.g., Bunbury-Wellington 2050)
  - Infra_Clas: Infrastructure status (Existing adequate, Existing needs improvement, Proposed)
  - Shape_Length: Route segment length in degrees

---

## Visualization Design

### Route Hierarchy Types

The map visualizes five distinct hierarchy levels using both color and line width differentiation:

| Hierarchy Type | Color | Width | Description |
|----------------|-------|-------|-------------|
| **Primary Route** | Blue (#1F78B4) | 4px | Major regional corridors connecting key destinations |
| **Secondary Route** | Green (#33A02C) | 3px | Important connecting routes linking communities |
| **Local Route** | Red (#E31A1C) | 2px | Neighborhood access and local connections |
| **Transport Trail** | Orange (#FF7F00) | 3px | Multi-use paths for recreation and transport |
| **Road Cycling Route** | Purple (#6A3D9A) | 2.5px | Regional on-road cycling routes (regional network only) |

### Route Status Indication

Line style indicates the planning and implementation status of routes:

- **Solid lines:** Final LTCN routes (metro) or Existing routes (regional) - currently implemented infrastructure
- **Dashed lines:** Draft LTCN routes (metro) or Proposed routes (regional) - planned future infrastructure

This dual encoding (color + line style) ensures accessibility and provides multiple visual cues for understanding the cycling network.

### Interactive Features

The map includes several interactive features:

- **Network Toggles:** Independently toggle metro and regional networks on/off
- **Hierarchy Filters:** Show/hide specific route types using the legend
- **Route Information:** Click any route to view detailed information including:
  - Route identifier or name
  - Hierarchy type
  - Planning status
  - Geographic area (council or regional strategy)
  - Route segment length in kilometers
- **Zoom & Pan:** Full map navigation with zoom levels 6-18
- **Dark/Light Mode:** Toggle between Carto light and dark basemaps
- **Geolocation:** Optional user location tracking

---

## Processing

1. **Data Conversion:** GeoDataBase to GeoJSON format via [MyGeoData Cloud](https://mygeodata.cloud/)
2. **Geometry Preservation:** No simplification applied to maintain route accuracy
3. **Attribute Retention:** All original properties preserved for comprehensive route information

---

## Technical Implementation

### Mapping Technology
- **MapLibre GL** (v4.7.1) - Open-source map rendering library
- **Deck.gl** (v9.0.16) - WebGL-powered visualization layer
- **Basemap:** Carto (light and dark modes)

### Visualization Approach
- **Layer Type:** GeoJsonLayer with native LineString support
- **Dashed Lines:** Implemented using `getLineDashArray` property ([6, 4] pattern for draft/proposed routes)
- **Color Coding:** RGB values mapped to hierarchy types
- **Line Width:** Pixel-based width with min/max constraints for consistent visibility
- **Opacity:** 78% (200/255) for all routes to show overlapping infrastructure

### Data Architecture
- **Dual Layers:** Metro and regional networks rendered as separate toggleable layers
- **Client-Side Filtering:** Real-time filtering by network type and hierarchy
- **Total Route Segments:** 11,281 features (7,531 metro + 3,750 regional)

---

## Data Quality Notes

- **Length Fields:** Both datasets contain two length fields:
  - `Shape_Leng`: Appears to be route length in meters (requires conversion to km: value ÷ 1000)
  - `Shape_Length`: Appears to be route length in degrees (approximate conversion: value × 111 ≈ km)
  - The popup displays both values for comparison - `Shape_Leng` generally provides more accurate lengths
- **Route Naming:** Some regional routes have generic names (e.g., "Secondary Routes")
- **Overlapping Routes:** Draft/Proposed routes may overlap with Final/Existing routes in areas of planned improvements

---

## Attribution

- **Map Data:** © OpenStreetMap contributors
- **Basemap Tiles:** © CARTO
- **Cycling Route Data:** © Government of Western Australia (Data WA)
- **Visualization:** Coen Arrow 2026