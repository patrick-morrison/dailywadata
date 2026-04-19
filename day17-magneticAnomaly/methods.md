# Day 17 — Geomagnetic Data

**Author:** Aren Leishman

The Geologic Survey of Western Australia has compiled 80m, 40m, and 20m geomagnetic intensity grids by combining a number of state and federal surveys. This geomagnetic data is used in a number of industries, particularly mining, where it is used to locate ferrous materials such as iron. From the 80m dataset, the Geologic Survey of Western Australia also provides the RTP (Reduced to Pole) and 1VD (1st Vertical Derivative) values for the 80m and 40m grids, the 80m grids are also hosted on a WMS server for easy use.

One of the more recent applications of this data has been in the location of shipwrecks, as their steel and iron hulls picked up a magnetic signature during their voyages. However the 80m grid size still results in a large searchable area when trying to locate these shipwrecks. Therefore a 1VD dataset (which emphasizes rapid changes in intensity, such as from a small magentic wreck) was rendered from the 20m grid data, allowing for much higher positional accuracy in these wreck locations.

To help use this visualization, the data from [day 2](https://dailywadata.com/day2-shipwrecks/) has been included, as well as the MINEDEX database of operating resource mines.

[Download magnetic data from the Geologic Survey of Western Australia](https://geodownloads.dmp.wa.gov.au/downloads/geophysics/72204/)

[Download mine data from Department of Mines, Petroleum, and Exploration](https://dasc.dmirs.wa.gov.au/home?productAlias=MINEDEXOperatingMines)

[Download well data from Department of Mines, Petroleum, and Exploration](https://dasc.dmirs.wa.gov.au/home?productAlias=WAPetroleumWells)

[Download wreck data from the Western Australian Museum](https://catalogue.data.wa.gov.au/dataset/shipwrecks)

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

## Processing

**80m Grid Data**: Served by the [SLIP WMS server](https://catalogue.data.wa.gov.au/en/dataset/total-magnetic-intensity-80m-of-wa-v1-2020/resource/4040b30b-6a6c-4dfa-b6ac-52521a7354e2), the Intensity, RTP, and 1VD data are directly imported to the maps as layers with adjustable transparency.

**20m Grid Data**: As 1VD data is not provided for the 20m dataset, this had to be calculated from the raw ERS data which is available. As this raw dataset is over 50 gigabytes, the processing of this dataset takes significant time and computational resources, the peak ram usage during the processing of the data was over 100 gigabytes. This data was firstly downloaded, and rendered as a GEOTIFF, in order to speed up future processing steps. The data was then processed using `gdal raster neighbors` command using a vertical derivative kernel with a 3x3 size, this produces a 1VD dataset. This was then loaded into QGIS and styled with a singleband spectral pseudocolor, with the minimum bound being -1 and the maximum being +1, this results in a very high contrast image so that even minor variations in magnetic fields are visible. On wrecks this results in a clear dipole or quadrupole signature, at the expense of saturation throughout most of the onshore imagery.

This styled data was then rendered as a GEOTIFF and reprojected from its native EPSG:7844 (GDA2020) format into EPSG:3857 for rendering within the mapping maplibre COG implementation (a protocol necessary to manage the large filesize), and this reprojected file was rendered as a compressed COG file. As the file, even after processing, was still over 8 gigabytes, it has been hosted on an external CDN rather than within the repository.

**MINEDEX**: The mine data was retrieved on 2025-01-13 as a csv file. This is instead of the WMS server, which also provides this data, so that it can be better rendered in the map as an interactive vector layer, rather than a tileserver.

**WA Petroleum Wells (DMIRS-025)**: Downloaded from data WA as a KMZ, this data was then converted to a csv to utilize the existing data pipeline.

**Shipwrecks**: This project directly references the day 2 dataset, however it also has manual entries for the [HNLMS K XI](https://wrecksploration.au/projects/kxi/), the [Thornliebank](https://wrecksploration.au/projects/thornliebank/), the [Langstone](https://museum.wa.gov.au/maritime-archaeology-db/sites/default/files/langston_site_inspection_report_f7a344fc-927e-4530-acb4-8c517fcca6d5.pdf), and a number of other wrecksploration wrecks have been added. These wrecks have all been relatively recent discoveries and hence do not appear in the published museum dataset.

## Implementation

HTML/CSS/JS webmap using MapLibre GL. The @geomatico/maplibre-cog-protocol library reads the Cloud Optimized GeoTIFF directly. 

## Sources

**Magnetic Data**: [The Geologic Survey of Western Australia](https://geodownloads.dmp.wa.gov.au/downloads/geophysics/72204/)

**Mine Data**: [Department of Mines, Petroleum, and Exploration](https://dasc.dmirs.wa.gov.au/home?productAlias=MINEDEXOperatingMines)

**Well Data**: [Department of Mines, Petroleum, and Exploration](https://dasc.dmirs.wa.gov.au/home?productAlias=WAPetroleumWells)

**Wreck Data**: [Western Australian Museum](https://catalogue.data.wa.gov.au/dataset/shipwrecks), [Wrecksploration](https://wrecksploration.au/)

**Basemap:** Esri World Imagery

**Libraries:** [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause), [@geomatico/maplibre-cog-protocol](https://github.com/geomatico/maplibre-cog-protocol) (ISC)
