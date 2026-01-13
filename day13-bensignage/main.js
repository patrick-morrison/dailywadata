proj4.defs("EPSG:7844","+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs");
ol.proj.proj4.register(proj4);

const geojsonSource = new ol.source.Vector({
  url: 'BEN_Signage_DPIRD_054_WA_GDA2020_Public.geojson',
  format: new ol.format.GeoJSON({
    dataProjection: 'EPSG:7844',
    featureProjection: 'EPSG:3857'
  })
});

const geojsonLayer = new ol.layer.Vector({
  source: geojsonSource,
  style: new ol.style.Style({
    image: new ol.style.Circle({
      radius: 5,
      fill: new ol.style.Fill({ color: '#0099ff' }),
      stroke: new ol.style.Stroke({ color: '#ffffff', width: 1.5 })
    })
  })
});

const map = new ol.Map({
  target: 'map',
  layers: [
    new ol.layer.Tile({
      source: new ol.source.OSM()
    }),
    geojsonLayer
  ],
  view: new ol.View({
    center: ol.proj.fromLonLat([121.5, -25.0]), 
    zoom: 5,
    constrainResolution: true
  })
});

const container = document.getElementById('popup');
const overlay = new ol.Overlay({
  element: container,
  autoPan: { animation: { duration: 250 } }
});
map.addOverlay(overlay);

map.on('singleclick', function (evt) {
  const feature = map.forEachFeatureAtPixel(evt.pixel, (f) => f, {
    hitTolerance: 10
  });

  if (feature) {
    const props = feature.getProperties();
    const coord = feature.getGeometry().getCoordinates();

    document.getElementById('popup-content-benid').innerHTML = `<strong>ID: ${props.ben_id}</strong>`;
    document.getElementById('popup-content-name').innerHTML = props.name_geographic || props.name_common_local || "Beach Access";
    document.getElementById('popup-content-lga').innerHTML = props.lga || "";

    overlay.setPosition(coord);
  } else {
    overlay.setPosition(undefined);
  }
});

map.on('pointermove', function (e) {
  const hit = map.hasFeatureAtPixel(map.getEventPixel(e.originalEvent));
  map.getTargetElement().style.cursor = hit ? 'pointer' : '';
});

document.getElementById('popup-closer').onclick = () => {
  overlay.setPosition(undefined);
  return false;
};