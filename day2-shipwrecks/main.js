const geojsonSource = new ol.source.Vector({
  url: 'Shipwrecks_WAM_002_WA_GDA2020_Public.geojson',
  format: new ol.format.GeoJSON()
});

const getDotSize = () => {
  if (window.innerHeight > window.innerWidth) {
    return 20;
  }
  return 6;
};

const geojsonLayer = new ol.layer.Vector({
  source: geojsonSource,
  style: new ol.style.Style({
    fill: new ol.style.Fill({
      color: 'rgba(0, 153, 255, 0.3)'
    }),
    stroke: new ol.style.Stroke({
      color: '#0099ff',
      width: 2
    }),
    image: new ol.style.Circle({
      radius: getDotSize(),
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
    center: ol.proj.fromLonLat([0, 0]),
    zoom: 2
  })
});

geojsonSource.once('change', () => {
  if (geojsonSource.getState() === 'ready') {
    map.getView().fit(
      geojsonSource.getExtent(),
      { padding: [50, 50, 50, 50] }
    );
  }
});

const container = document.getElementById('popup');
const infoname = document.getElementById('popup-content-name');
const infoyear = document.getElementById('popup-content-year');
const infodescription = document.getElementById('popup-content-description');
const infourl = document.getElementById('popup-content-url');
const infocoordinates = document.getElementById('popup-content-coordinates');
const closer = document.getElementById('popup-closer');
var focusedShipwreck = "";

const overlay = new ol.Overlay({
  element: container,
  autoPan: true,
  autoPanAnimation: { duration: 250 }
});
map.addOverlay(overlay);

closer.onclick = function () {
  overlay.setPosition(undefined);
  closer.blur();
  return false;
};


const getHitTolerance = () => {
  if (window.innerHeight > window.innerWidth) {
    return 40;
  }
  return 1;
};

map.on('singleclick', function (evt) {
  const feature = map.forEachFeatureAtPixel(evt.pixel, (feat) => feat, {
    hitTolerance: getHitTolerance()
  });

  if (feature) {
    const coordinates = evt.coordinate;
    const props = feature.getProperties();
    const name = props.name || "Unnamed Shipwreck";
    const description = props.sinking || "";
    const year = props.when_lost || "";
    const url = props.url || "";
    const coordinatesY = props.lat || "";
    const coordinatesX = props.long || "";
    focusedShipwreck = props.unique_num;

    infoname.innerHTML = `<strong>${name}</strong>`;
    if (year !== "") { infoyear.innerHTML = `Lost ${year}` } else { infoyear.innerHTML = "" }
    if (description !== "") { infodescription.innerHTML = `${description}` } else { infodescription.innerHTML = "" }
    if (url !== "") { infourl.innerHTML = `<a href="${url}" target="_blank">More Information</a>` } else { infourl.innerHTML = "" }
    if (coordinatesX !== "" && coordinatesY !== "") { infocoordinates.innerHTML = `X: ${coordinatesY} Y: ${coordinatesX}` } else { infocoordinates.innerHTML = "" }
    overlay.setPosition(coordinates);
  } else {
    overlay.setPosition(undefined);
  }
});

map.on('pointermove', function (e) {
  const pixel = map.getEventPixel(e.originalEvent);
  const hit = map.hasFeatureAtPixel(pixel);
  const target = map.getTargetElement();
  target.style.cursor = hit ? 'pointer' : '';
});

const share = document.getElementById("popup-share");

share.addEventListener('click', async function (evt) {
  copyNotification = document.getElementById("copyNotification");
  const shareUrl = document.location.href.split('#')[0] + "#" + focusedShipwreck;
  if (navigator.canShare) {
    navigator.share({title: "Shipwrecks of Western Australia", text: "Check out this shipwreck!", url: shareUrl})
  } else {
    navigator.clipboard.writeText(shareUrl);
    copyNotification.style.animation = "fade 1.52s ease-out";
    await new Promise(r => setTimeout(r, 1500));
    copyNotification.style.animation = "";
  }
});

var type = window.location.hash.substring(1);

if (type !== "") {
  geojsonSource.once('change', () => {
    if (geojsonSource.getState() === 'ready') {
      const features = geojsonSource.getFeatures();
      const targetFeature = features.find(f => String(f.get('unique_num')) === type);

      if (targetFeature) {
        const geometry = targetFeature.getGeometry();
        if (geometry.getType() === 'Point') {
          map.getView().animate({
            center: geometry.getCoordinates(),
            zoom: 8,
            duration: 1000
          });

          const props = targetFeature.getProperties();
          infoname.innerHTML = `<strong>${props.name || "Unnamed Shipwreck"}</strong>`;
          infoyear.innerHTML = props.when_lost ? `Lost ${props.when_lost}` : "";
          infodescription.innerHTML = props.sinking || "";
          infourl.innerHTML = props.url ? `<a href="${props.url}" target="_blank">More Information</a>` : "";

          overlay.setPosition(geometry.getCoordinates());
          focusedShipwreck = props.unique_num;
        }
      }
    }
  });
}