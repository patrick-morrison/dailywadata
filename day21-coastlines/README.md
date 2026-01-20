# Australia Coastline Map

An interactive web map displaying historical high tide coastline data for Australia from 2016-2022.

**Live Demo:** https://wrignj08.github.io/Aus_Coastline_Map/

## Features

- Interactive map powered by Leaflet with Esri World Imagery basemap
- Historical coastline layers for years 2016-2022, each with a distinct color
- Toggle individual years on/off via checkboxes
- Animated playback to cycle through years automatically

## Data Source

Coastline data is sourced from the WA SLIP (Shared Location Information Platform) WFS service:
- Dataset: DPIRD-094 High Tide Coastline
- Provider: Department of Primary Industries & Regional Development

## Usage

Open `index.html` in a web browser. The map will load coastline data for the visible area.

- Use the checkboxes in the Controls panel to show/hide specific years
- Click "Play Animation" to automatically cycle through each year
- Pan and zoom the map to explore different coastal areas

## Files

- `index.html` - Main HTML structure
- `styles.css` - Styling for the map and UI components
- `app.js` - Map initialization and interaction logic