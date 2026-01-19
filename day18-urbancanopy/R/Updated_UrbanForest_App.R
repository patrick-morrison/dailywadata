# ==============================================================================
# PERTH VEGETATION RATING MAP - INTERACTIVE
# Tree canopy + grass + shrub coverage analysis
# Data from GDB
# ==============================================================================

library(leaflet)
library(leaflet.extras)
library(sf)
library(dplyr)
library(httr)
library(jsonlite)
library(htmlwidgets)
library(RColorBrewer)
library(lubridate)

# ==============================================================================
# STEP 1: LOAD PRE-CALCULATED RANKINGS
# ==============================================================================

cat("\n=== LOADING PRE-CALCULATED RANKINGS ===\n")

# Load rankings - use relative paths
rankings_lookup <- read.csv("data/processed/perth_canopy_rankings.csv", 
                            stringsAsFactors = TRUE)
rankings_lookup_SA2 <- read.csv("data/processed/perth_summary_SA2.csv", 
                                stringsAsFactors = TRUE)

#Perth Stats
perth_stats <- list(
  total_mesh_blocks = nrow(rankings_lookup),
  avg_canopy = round(mean(rankings_lookup$totalpcent, na.rm = TRUE), 1),
  avg_total_veg = round(mean(rankings_lookup$Total_Veg_Pct, na.rm = TRUE), 1),
  avg_shrub= round(mean(rankings_lookup$Shrub_Pct, na.rm = TRUE), 1),
  avg_grass= round(mean(rankings_lookup$Grass_Pct, na.rm = TRUE), 1)
)

# ==============================================================================
# STEP 1.5: SETUP REGIONS AND SOURCE FUNCTIONS
# ==============================================================================

source("R/arcgis_rest_fetch.R")

# Define which regions to display
# Set to NULL to generate all regions, or specify a single region for testing
regions_to_generate <- c(
  "Mandurah",
  "Perth - Inner",
  "Perth - North East",
  "Perth - North West",
  "Perth - South East",
  "Perth - South West"
)

# For testing, uncomment to generate just one region:
# regions_to_generate <- "Perth - South East"

# Create output directory if it doesn't exist
if (!dir.exists("docs/maps")) {
  dir.create("docs/maps", showWarnings = FALSE)
}

# ==============================================================================
# STEP 2: GENERATE MAPS FOR EACH REGION
# ==============================================================================

for (display_region in regions_to_generate) {
  
  # cat("\n" %+% strrep("=", 70) %+% "\n")
  cat("GENERATING MAP FOR:", display_region, "\n")
  # cat(strrep("=", 70) %+% "\n")
  
  # Load ONLY the region we want to display
  urban_forest_data <- get_urban_forest_data(bbox = display_region)
  
  # ==============================================================================
  # JOIN RANKINGS TO DISPLAY DATA
  # ==============================================================================
  
  cat("\n=== JOINING RANKINGS ===\n")
  
  # Join rankings using mb_moncat
  
  urban_forest_data <- urban_forest_data %>%
    left_join(
      rankings_lookup %>% 
        select(mb_moncat,
               monitorcat_Count,  #Count of the type of LandType
               monitorcat_canopy_rank, 
               monitorcat_canopy_quintile,
               All_canopy_rank, All_canopy_decile, 
               Total_mesh_blocks),
      by = c("mb_moncat")
    )
  
  # Check for missing rankings
  missing_ranks <- urban_forest_data %>%
    filter(is.na(All_canopy_rank))
  
  if (nrow(missing_ranks) > 0) {
    cat("⚠️ Warning:", nrow(missing_ranks), "mesh blocks missing rankings\n")
  } else {
    cat("✅ All mesh blocks successfully matched with rankings\n")
  }
  
  
  # ==============================================================================
  # CALCULATE VEGETATION RATINGS (on filtered data with rankings)
  # ==============================================================================

cat("\n=== CALCULATING VEGETATION RATINGS ===\n")

current_datetime <- Sys.time()
current_date <- Sys.Date()

# Create comprehensive vegetation rating
urban_forest_ratings <- urban_forest_data %>%
  mutate(
    
    # Canopy category
    canopy_category = case_when(
      Canopy_Pct >= 40 ~ "High % Canopy",
      Canopy_Pct >= 25 ~ "Medium % Canopy",
      Canopy_Pct >= 15 ~ "Low % Canopy",
      TRUE ~ "Minimal Canopy"
    ),
    
    # Walking comfort
    walking_comfort = case_when(
      Total_Veg_Pct >= 75 & Canopy_Pct >= 40 ~ "😎 Excellent",
      Total_Veg_Pct >= 60 & Canopy_Pct >= 25 ~ "👍 Very Good",
      Total_Veg_Pct >= 45 ~ "🙂 Decent vegetation",
      Total_Veg_Pct >= 30 ~ "😐 Some vegetation",
      Total_Veg_Pct >= 15 ~ "😕 Limited vegetation",
      TRUE ~ "😞 Minimal vegetation"
    ),
    
    location_txt = sa2_name21,
    
    #Descriptions for quintiles
    # LandType_quintile_description = case_when(
    #   monitorcat_canopy_quintile == 5 ~ "Top 20% within Land Type",
    #   monitorcat_canopy_quintile == 4 ~ "60th-80th percentile within Land Type",
    #   monitorcat_canopy_quintile == 3 ~ "40th-60th percentile within Land Type",
    #   monitorcat_canopy_quintile == 2 ~ "20th-40th percentile within Land Type",
    #   monitorcat_canopy_quintile == 1 ~ "Bottom 20% of LandType",
    #   TRUE ~ "Unknown"
    # )
    
    # Create decile description
    decile_description = case_when(
      All_canopy_decile == 10 ~ "Top 10% of all meshblocks",
      All_canopy_decile == 9 ~ "Top 20% of all meshblocks",
      All_canopy_decile >= 7 ~ "Top 30% of all meshblocks",
      All_canopy_decile >= 5 ~ "Middle 40% of all meshblocks",
      TRUE ~ "Bottom 40% of all meshblocks"
    )
    
  )

# ==============================================================================
# STEP 3: CREATE INTERACTIVE MAP
# ==============================================================================

cat("\n=== CREATING INTERACTIVE MAP ===\n")

# Color palettes
veg_score_pal <- colorNumeric(
  palette = c("#d73027", "#fee08b", "#d9ef8b", "#66bd63", "#1a9850"),
  domain = c(0, 100)
)

canopy_pal <- colorNumeric(
  palette = "Greens",
  domain = c(0, 100)
)

## ADD this later
# walking_comfort_pal <- colorFactor(palette = c("#a50026", "#d73027", "#fee08b", "#d9ef8b", "#66bd63", "#1a9850"))


# Find best and worst Canopied areas
best_canopy_areas <- rankings_lookup_SA2 %>%
  arrange(desc(SA2_pcent_canopy))

worst_canopy_areas <- rankings_lookup_SA2 %>%
  arrange(SA2_pcent_canopy) %>%
  head(5)

# Create the map with Canvas renderer for better performance
perth_veg_map <- leaflet(data = urban_forest_ratings,
                         options = leafletOptions(preferCanvas = TRUE)) %>%

# =============================================================================
# BASE MAPS
# =============================================================================

  addProviderTiles("Esri.WorldImagery", group = "Satellite") %>%
  
# =============================================================================
# Canopy and Vegetation (PRIMARY)
# =============================================================================

 addPolygons(
  # data = urban_forest_ratings,
  fillColor = ~canopy_pal(Canopy_Pct),
  fillOpacity = 0.7,
  stroke = TRUE,
  color = "white",
  weight = 0.5,
  opacity = 0.3,
  group = "Canopy and Vegetation",
  popup = ~paste0(
    "<div style='font-family: Arial, sans-serif; min-width: 280px;'>",
    "<div style='background:    linear-gradient(135deg, #2e7d32 0%, #66bb6a 100%); ",
    "padding: 12px; margin: -10px -10px 10px -10px;'>",
    "<h4 style='color: white; margin:    0;'>🌳 Canopy and Vegetation</h4></div>",
    
    "<p style='font-size: 12px; color: #666; margin: 10px 0;'>",
    "Location: ", location_txt, " - Land Type: ", monitorcat, "</p>",
    
    "<div style='text-align: center; padding: 20px; background: ",
    ifelse(Canopy_Pct >= 40, "#e8f5e9",
           ifelse(Canopy_Pct >= 25, "#fff3e0", "#ffebee")),
    "; border-radius: 8px; margin:  10px 0;'>",  # ← Added missing semicolon here
    
    "<div style='font-size: 48px; font-weight: bold; color: ",
    ifelse(Canopy_Pct >= 40, "#2e7d32", 
           ifelse(Canopy_Pct >= 15, "#f57c00", "#d32f2f")),
    ";'>", round(Canopy_Pct, 0), "%</div>",
    
    "<p style='margin:   0; font-size: 12px; text-align: center;'>",
    ifelse(Canopy_Pct >= 40, "🌳 <strong>Excellent canopy</strong> - Significant shade & cooling",
           ifelse(Canopy_Pct >= 25, "🌤️ <strong>Good canopy</strong> - Moderate shade available",
                  ifelse(Canopy_Pct >= 15, "☀️ <strong>Low canopy</strong> - Limited shade",
                         "🏜️ <strong>Minimal canopy</strong> - Very exposed"))),
    "</p></div>",
    
    "<div style='padding: 12px; background: ",
    ifelse(Total_Veg_Pct >= 75, "#e8f5e9",
           ifelse(Total_Veg_Pct >= 60, "#f1f8e9",
                  ifelse(Total_Veg_Pct >= 45, "#f7fcf5",
                         ifelse(Total_Veg_Pct >= 30, "#fffef0",
                                ifelse(Total_Veg_Pct >= 15, "#fff5eb",
                                       "#fee5d9"))))),
    "; border-radius: 6px; margin:  10px 0; text-align: center;'>",
    
    "<p style='margin: 0; font-size: 16px; font-weight: bold; color: ",
    ifelse(Total_Veg_Pct >= 75, "#1a9850",
           ifelse(Total_Veg_Pct >= 60, "#66bd63",
                  ifelse(Total_Veg_Pct >= 45, "#91cf60",
                         ifelse(Total_Veg_Pct >= 30, "#fee08b",
                                ifelse(Total_Veg_Pct >= 15, "#fdae61",
                                       "#d73027"))))),
    ";'>", round(Total_Veg_Pct, 1), "% Total Vegetation</p>",
    "</div>",
    
    "<table style='width: 100%; font-size: 12px; margin: 10px 0;'>",
    "<tr><td style='padding: 6px;'>🌿 Shrub Cover:</td>",
    "<td style='padding: 6px; text-align: right;'><strong>", round(Shrub_Pct, 1), "%</strong></td></tr>",
    
    "<tr style='background: #f5f5f5;'><td style='padding: 6px;'>🌱 Grass Cover:</td>",
    "<td style='padding: 6px; text-align: right;'><strong>", round(Grass_Pct, 1), "%</strong></td></tr>",
    "</table>",
    
    "<div style='padding: 12px; background:  #e8f5e9; border-radius: 6px; margin-top: 10px;'>",
    "<p style='margin: 0 0 6px 0; font-size:    12px;'><strong>Walking Comfort:</strong></p>",
    "<p style='margin: 0; font-size:   12px;'>", walking_comfort, "</p>",
    "</div>",
    
    "<div style='padding:  12px; background: #e8f5e9; border-radius:   6px; margin-top:   10px;'>",
    "<p style='margin:  0 0 6px 0; font-size:  12px;'><strong>Relative Stats:  </strong></p>",
    "<p style='margin: 0; font-size: 12px;'>", decile_description, " and ranked ", 
    format(monitorcat_canopy_rank, big.mark=","), " of ", 
    format(monitorcat_Count, big.mark=","), " ", monitorcat, " Mesh Blocks in Perth</p>",
    "</div>",
    
    "</div>"
  ),
  highlightOptions = highlightOptions(
    weight = 2,
    bringToFront = TRUE
  ),
  label = ~lapply(paste0(
    "<div style='font-size: 12px; line-height: 1.6;'>",
    "<strong style='font-size: 13px;'>", location_txt, "</strong><br>",
    "<span style='color: #666;'>MeshBlock Type: ", monitorcat, "</span><br>",
    "🌲 Canopy: <strong>", round(Canopy_Pct, 0), "%</strong><br>",
    "🌿 Total Veg: <strong>", round(Total_Veg_Pct, 0), "%</strong>",
    "</div>"
  ), htmltools::HTML)
) %>%

# =============================================================================
# LAYER CONTROLS
# =============================================================================

addLayersControl(
  baseGroups = c("Satellite"),
  overlayGroups = c("Canopy and Vegetation"),
  options = layersControlOptions(collapsed = FALSE),
  position = "topright"
) %>%
  
# =============================================================================
# LEGENDS
# =============================================================================

addLegend(
    position = "bottomright",
    pal = canopy_pal,
    values = urban_forest_ratings$Canopy_Pct,
    title = "Tree Canopy %",
    opacity = 0.9,
    group = "Tree Canopy Coverage"
  ) %>%
  
  
# =============================================================================
# INFO PANEL
# =============================================================================

addControl(
  html = paste0(
    "<div style='background: rgba(255,255,255,0.97); padding: 18px; ",
    "border-radius: 12px; border-left: 5px solid #4CAF50; max-width: 360px; ",
    "box-shadow: 0 4px 12px rgba(0,0,0,0.15);'>",
    
    # Title
    "<div style='margin-bottom: 14px;'>",
    "<h4 style='margin: 0; color: #2e7d32; font-size: 18px;'>",
    "🌳 Perth Vegetation Analysis (2024)</h4>",
    "<p style='margin: 4px 0 0 0; font-size: 11px; color: #666;'>",
    "</p>",
    "</div>",
    
    # Summary statistics with Perth comparison
    "<div style='background: #e8f5e9; padding:   12px; border-radius:  8px; ",
    "margin-bottom: 12px;'>",
    "<p style='margin: 0 0 8px 0; font-size:  13px; color: #2e7d32; font-weight: 600;'>",
    "📊 Coverage Summary</p>",
    
    "<table style='width: 100%; font-size: 11px; color: #666;'>",
    
    # Header row
    "<tr style='font-weight: 600; border-bottom: 1px solid #ccc;'>",
    "<td style='padding: 4px 0;'></td>",
    "<td style='text-align: right; padding: 4px 4px;'>", display_region, "</td>",
    "<td style='text-align: right; padding: 4px 0;'>Greater Perth</td>",
    "</tr>",
    
    # Mesh blocks
    "<tr><td style='padding: 4px 0;'>Mesh blocks:</td>",
    "<td style='text-align: right; padding: 4px 4px;'>", 
    format(nrow(urban_forest_ratings), big.mark=","), "</td>",
    "<td style='text-align: right; padding: 4px 0;'>", 
    format(perth_stats$total_mesh_blocks, big.mark=","), "</td></tr>",
    
    # Avg canopy
    "<tr style='background: #f9fdf9;'><td style='padding: 4px 0;'>Avg canopy cover:</td>",
    "<td style='text-align: right; padding: 4px 4px;'>", 
    round(mean(urban_forest_ratings$Canopy_Pct, na.rm = TRUE), 1), "%</td>",
    "<td style='text-align:  right; padding: 4px 0;'>", 
    perth_stats$avg_canopy, "%</td></tr>",
    
    # Avg total vegetation
    "<tr><td style='padding: 4px 0;'>Avg total vegetation:</td>",
    "<td style='text-align: right; padding: 4px 4px;'>", 
    round(mean(urban_forest_ratings$Total_Veg_Pct, na.rm = TRUE), 1), "%</td>",
    "<td style='text-align: right; padding: 4px 0;'>", 
    perth_stats$avg_total_veg, "%</td></tr>",
    
    # Avg shrub cover
    "<tr style='background: #f9fdf9;'><td style='padding: 4px 0;'>Avg shrub cover:</td>",
    "<td style='text-align: right; padding: 4px 4px;'>", 
    round(mean(urban_forest_ratings$Shrub_Pct, na.rm = TRUE), 1), "%</td>",
    "<td style='text-align: right; padding: 4px 0;'>", 
    perth_stats$avg_shrub, "%</td></tr>",
    
    # Avg grass cover
    "<tr><td style='padding:  4px 0;'>Avg grass cover:</td>",
    "<td style='text-align: right; padding: 4px 4px;'>", 
    round(mean(urban_forest_ratings$Grass_Pct, na.rm = TRUE), 1), "%</td>",
    "<td style='text-align: right; padding: 4px 0;'>", 
    perth_stats$avg_grass, "%</td></tr>",
    
    "</table>",
    "</div>",
    
    
    # Best vegetated areas
    "<div style='background: #f0f7ff; padding: 12px; border-radius: 8px; margin:  12px 0;'>",
    "<p style='margin:  0 0 8px 0; font-size: 12px; font-weight: 600; color:  #0277bd;'>",
    "🌳 Best Canopy SA2 Areas (Perth): </p>",
    
    "<ol style='margin: 0; padding-left: 18px; font-size: 10px; color:  #555;'>",
    paste0(
      "<li>", best_canopy_areas$sa2_name21[1], " - ", 
      round(best_canopy_areas$SA2_pcent_canopy[1], 0), "% canopy</li>",
      "<li>", best_canopy_areas$sa2_name21[2], " - ", 
      round(best_canopy_areas$SA2_pcent_canopy[2], 0), "% canopy</li>",
      "<li>", best_canopy_areas$sa2_name21[3], " - ", 
      round(best_canopy_areas$SA2_pcent_canopy[3], 0), "% canopy</li>"
    ),
    "</ol>",
    "</div>",
    
    
    # Data info
    "<hr style='margin: 14px 0; border: none; border-top: 1px solid #e0e0e0;'>",
    
    "<div style='font-size: 10px; color: #999;'>",
    "<p style='margin: 0 0 4px 0; font-weight: 600;'>Data Source: </p>",
    "<p style='margin: 0; line-height: 1.6;'>",
    "• Urban Forest Mesh Blocks 2024 ",
    "<a href='https://catalogue.data.wa.gov.au/dataset/urban-forest-mesh-blocks-2024-dplh-109' target='_blank' ",
    "style='display: inline-block; padding: 4px 8px; background: #1976d2; color: white; ",
    "text-decoration: none; border-radius: 3px; font-size: 9px; font-weight: 600; ",
    "margin:  4px 0 4px 12px;' ",
    "onmouseover='this.style.background=\"#0d47a1\"' ",
    "onmouseout='this.style.background=\"#1976d2\"'>",
    "📊 DPLH-109 ↗",
    "</a><br>",
    "• Map tiles: Esri World Imagery<br>",
    "• Created with R + Leaflet</p>",
    "</div>",
    
    "<div style='font-size: 10px; color: #999; margin-top: 12px;'>",
    "<p style='margin: 0 0 4px 0; font-weight: 600;'>Limitations: </p>",
    "<p style='margin: 0; line-height: 1.6;'>",
    "• MANY: this is for 'fun' display<br>",
    "• Not meant scientific/planning purposes</p>",
    "• Some outer SA2s removed for speed/size purposes<br>",
    "</div>",
    
    "<div style='font-size: 10px; color: #999; margin-top: 12px;'>",
    "<p style='margin: 0 0 6px 0; font-weight:  600;'>Data Info:</p>",
    "<p style='margin: 0 0 6px 0; line-height:  1.6;'>",
    "Info on Statistical Areas (eg. SA2, SA4): ",
    "<a href='https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3/jul2021-jun2026/main-structure-and-greater-capital-city-statistical-areas' target='_blank' ",
    "style='display: inline-block; padding: 4px 8px; background: #1976d2; color: white; ",
    "text-decoration: none; border-radius: 3px; font-size: 9px; font-weight: 600; ",
    "margin-left: 4px;' ",
    "onmouseover='this.style.background=\"#0d47a1\"' ",
    "onmouseout='this. style.background=\"#1976d2\"'>",
    "ABS Info ↗",
    "</a>",
    "</p>",
    "</div>",
    
    
    "</div>"
  ),
  position = "bottomleft"
) %>%
  
# =============================================================================
# RATING SCALE GUIDE
# =============================================================================

addControl(
  html = paste0(
    "<div style='background: white; padding: 12px; border-radius: 8px; ",
    "box-shadow: 0 2px 8px rgba(0,0,0,0.15); max-width: 220px;'>",
    "<p style='margin: 0 0 8px 0; font-size: 12px; font-weight: 600;'>",
    "Total Vegetation Scale</p>",
    
    "<div style='font-size: 10px; line-height: 1.8;'>",
    "<div style='display: flex; align-items: center; margin: 4px 0;'>",
    "<div style='width: 16px; height: 16px; background: #1a9850; ",
    "border-radius: 3px; margin-right: 6px;'></div>",
    "<span><strong>75-100:</strong> Excellent</span>",
    "</div>",
    
    "<div style='display: flex; align-items: center; margin: 4px 0;'>",
    "<div style='width: 16px; height: 16px; background: #66bd63; ",
    "border-radius: 3px; margin-right: 6px;'></div>",
    "<span><strong>60-74:</strong> Very Good</span>",
    "</div>",
    
    "<div style='display: flex; align-items: center; margin: 4px 0;'>",
    "<div style='width: 16px; height: 16px; background: #d9ef8b; ",
    "border-radius: 3px; margin-right: 6px;'></div>",
    "<span><strong>45-59:</strong> Good</span>",
    "</div>",
    
    "<div style='display: flex; align-items: center; margin:  4px 0;'>",
    "<div style='width:  16px; height: 16px; background: #fee08b; ",
    "border-radius: 3px; margin-right: 6px;'></div>",
    "<span><strong>30-44:</strong> Moderate</span>",
    "</div>",
    
    "<div style='display: flex; align-items: center; margin:  4px 0;'>",
    "<div style='width:  16px; height: 16px; background: #fdae61; ",
    "border-radius: 3px; margin-right: 6px;'></div>",
    "<span><strong>15-29:</strong> Low</span>",
    "</div>",
    
    "<div style='display: flex; align-items: center; margin: 4px 0;'>",
    "<div style='width: 16px; height: 16px; background: #d73027; ",
    "border-radius: 3px; margin-right: 6px;'></div>",
    "<span><strong>0-14:</strong> Very Low</span>",
    "</div>",
    "</div>",
    "</div>"
  ),
  position = "topright"
) 
  
  # =============================================================================
# SET VIEW - CENTER ON EACH REGION
# =============================================================================

# Define region-specific center coordinates
region_coords <- list(
  "Mandurah" = list(lng = 115.73, lat = -32.53, zoom = 11),
  "Perth - Inner" = list(lng = 115.86, lat = -31.95, zoom = 12),
  "Perth - North East" = list(lng = 115.95, lat = -31.80, zoom = 11),
  "Perth - North West" = list(lng = 115.75, lat = -31.75, zoom = 11),
  "Perth - South East" = list(lng = 116.05, lat = -32.05, zoom = 11),
  "Perth - South West" = list(lng = 115.85, lat = -32.15, zoom = 11)
)

# Get coordinates for current region
coords <- region_coords[[display_region]]
if (!is.null(coords)) {
  perth_veg_map <- perth_veg_map %>%
    setView(lng = coords$lng, lat = coords$lat, zoom = coords$zoom)
} else {
  # Fallback to default if region not found
  perth_veg_map <- perth_veg_map %>%
    setView(lng = 116.05, lat = -31.95, zoom = 11)
}

# Display the map
# perth_veg_map

# ==============================================================================
# SAVE THE MAP
# ==============================================================================

# Create a filename-safe region name
region_filename <- tolower(gsub(" - ", "_", gsub(" ", "_", display_region)))
output_file <- paste0("docs/maps/", region_filename, ".html")

saveWidget(perth_veg_map, output_file, selfcontained = TRUE)

# Add custom styling
html_content <- readLines(output_file, warn = FALSE)
head_end <- grep("</head>", html_content)[1]

if (! is.na(head_end)) {
  
  custom_style <- paste0(
    '  <!-- Custom Styling -->',
    '\n  <style>',
    '\n    .leaflet-popup-content { padding: 10px !important; }',
    '\n    .leaflet-popup-content-wrapper { border-radius: 12px !important; }',
    '\n    .info.legend { background: white; padding: 10px; border-radius: 8px; }',
    '\n  </style>',
    '\n  <script>',
    '\n    // Console info',
    '\n  </script>'
  )
  
  html_content <- c(
    html_content[1:(head_end-1)],
    custom_style,
    html_content[head_end:length(html_content)]
  )
  
  writeLines(html_content, output_file)
}

cat("✅ Map saved to:", output_file, "\n")

} # End of region loop

cat("ALL MAPS GENERATED SUCCESSFULLY!\n")
