# How to Download Population Data

## Steps:

1. **Go to Digital Atlas:**
   https://digital.atlas.gov.au/maps/digitalatlas::abs-australian-population-grid-2024/about

2. **Download the data:**
   - Look for the "Download" button or data access section
   - Select **GeoTIFF** format (not shapefile)
   - Download to your computer

3. **Place the file:**
   - Save it to: `day16-risingseas/data/ABS_Australian_Population_Grid_2024.tif`
   - Or update the `pop_path` variable in the R Markdown if you name it differently

4. **Knit the document:**
   - Open `rising_seas.Rmd` in RStudio
   - Click "Knit" to generate the HTML output
   - The population analysis will automatically run

## What the code will do with the data:

- Calculate total population above different sea levels
- Show percentage of population that would be "submerged" at +50m and +120m
- Create visualizations showing the archaeological visibility problem

## Alternative if download doesn't work:

If you can't find a direct download, the data might also be available through:
- ABS website directly
- data.gov.au
- Contact me and I can help troubleshoot
