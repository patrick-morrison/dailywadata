# ==============================================================================
# FETCH URBAN FOREST DATA FROM LOCAL GEODATABASE
# ==============================================================================

library(sf)
library(dplyr)

#Key/description of columns
# monitorcat = "Urban Monitor Category"
# t3to8mpc =  "Percentage Tree 3 - 8m"
# t8to15mpc = "Percentage Tree 8 - 15m"
# t15mpluspc = "Percentage of Tree 15m+"
# t0to3mpc =   "Percentage Shrubs 0 - 3m"
# grasspc = "Percentage of Grass 0 - 50cm"
# totalpcent = "Total Canopy Percentage (% of Lot Area)"
# totalrange = "Canopy Coverage Range"
# SA4_NAME16 = "SA4_NAME16"

# ==============================================================================
# LOCAL GEODATABASE FUNCTIONS
# ==============================================================================

read_gpkg_layer <- function(gpkg_path, layer_name, bbox = NULL) {
  
  if (!file.exists(gpkg_path)) {
    cat("⚠ ERROR: GeoPackage not found at:", gpkg_path, "\n")
    return(NULL)
  }
  
  tryCatch({
    # Read the layer
    data <- st_read(
      gpkg_path,
      layer = layer_name,
      quiet = TRUE,
      stringsAsFactors = TRUE
    ) %>%
      st_make_valid()
    
    # Filter by SA4 if specified
    if (!is.null(bbox)) {
      data <- data %>% filter(SA4_NAME16 == bbox)
    }
    
    # Ensure WGS84
    if (st_crs(data) != st_crs(4326)) {
      cat("Transforming to WGS84.. .\n")
      data <- st_transform(data, 4326)
    }
    
    return(data)
    
  }, error = function(e) {
    cat("⚠ Error reading GeoPackage:", e$message, "\n")
    return(NULL)
  })
}


# ==============================================================================
# PROCESS URBAN FOREST DATA
# ==============================================================================

process_urban_forest_data <- function(raw_data) {
  cat("\n=== PROCESSING URBAN FOREST DATA ===\n")
  
  processed_data <- raw_data %>%
    select(-matches("^OBJECTID|^FID", ignore.case = TRUE)) %>%
    mutate(
      # KEEP THE MESH BLOCK CODE FOR JOINING
      mb_moncat = mb_moncat,  #UNIQUE ID
      
      # centroid = st_centroid(. ),
      Canopy_Pct = as.numeric(totalpcent),
      Canopy_Range = totalrange,
      monitorcat = monitorcat,
      ShrubGrass_Pct = as.numeric(t0to3mpc),
      Grass_Pct = as.numeric(grasspc),
      Shrub_Pct = ShrubGrass_Pct - Grass_Pct,
      sa2_name21 = sa2_name21,
      Total_Veg_Pct = Canopy_Pct + Shrub_Pct + Grass_Pct,
      
      # Clean up NA/Inf values
      ## If NA value, replace with 0. Only 6 meshblocks with this.
      Canopy_Pct = ifelse(is.na(Canopy_Pct) | is.infinite(Canopy_Pct), 0, Canopy_Pct),
      Shrub_Pct = ifelse(is.na(Shrub_Pct) | is.infinite(Shrub_Pct), 0, Shrub_Pct),
      Grass_Pct = ifelse(is.na(Grass_Pct) | is.infinite(Grass_Pct), 0, Grass_Pct),
      Total_Veg_Pct = ifelse(is.na(Total_Veg_Pct) | is.infinite(Total_Veg_Pct), 0, Total_Veg_Pct)
    )
  
  return(processed_data)
}

# ==============================================================================
# MAIN FUNCTION: FETCH URBAN FOREST FROM LOCAL GEODATABASE
# ==============================================================================
# Update main function
get_urban_forest_data <- function(bbox = NULL, data_path = NULL, layer_name = NULL) {
  
  cat("\n🌳 FETCHING URBAN FOREST CANOPY DATA\n")
  
  # Use relative path for portability
  if (is.null(data_path)) {
    data_path <- "data/processed/perth_data.gpkg"
  }
  
  if (is.null(layer_name)) {
    layer_name <- "uf_2024"
  }
  
  cat("Loading from:", data_path, "\n")
  
  # Read the data
  urban_forest_data <- read_gpkg_layer(data_path, layer_name, bbox = bbox)
  
  if (is.null(urban_forest_data) || nrow(urban_forest_data) == 0) {
    cat("\n❌ No data retrieved\n")
    return(NULL)
  }
  
  # Process the data
  processed_data <- process_urban_forest_data(urban_forest_data)
  
  return(processed_data)
}
