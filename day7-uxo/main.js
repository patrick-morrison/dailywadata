const hideDisclaimer = document.getElementById('close-disclaimer');
const disclaimer = document.getElementById('disclaimer');
const container = document.getElementById('popup');
const infoname = document.getElementById('popup-content-name');
const infodescription = document.getElementById('popup-content-description'); ``
const closer = document.getElementById('popup-closer');

let focusedUXO = "";
const getDotSize = () => (window.innerHeight > window.innerWidth ? 15 : 6);

const geojsonSource = new ol.source.Vector({
    url: 'DFES_UXO_Potential_DFES_034_WA_GDA2020_Public.geojson',
    format: new ol.format.GeoJSON()
});

const uxoStyles = {
    'substantial': { fill: '#ff44002e', stroke: '#ff4500ff' },
    'slight': { fill: '#ffb3002e', stroke: '#ffb300ff' },
    'other': { fill: '#e5ff002e', stroke: '#e5ff00ff' },
    'default': { fill: '#808080a8', stroke: '#808080ff' }
};

const styleFunction = function (feature) {
    const category = (feature.get('uxo_category') || '').toLowerCase();
    const styleConfig = uxoStyles[category] || uxoStyles['default'];

    return new ol.style.Style({
        fill: new ol.style.Fill({ color: styleConfig.fill }),
        stroke: new ol.style.Stroke({ color: styleConfig.stroke, width: 2 }),
        image: new ol.style.Circle({
            radius: getDotSize(),
            fill: new ol.style.Fill({ color: styleConfig.stroke }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 1.5 })
        })
    });
};

const geojsonLayer = new ol.layer.Vector({
    source: geojsonSource,
    style: styleFunction
});

const map = new ol.Map({
    target: 'map',
    layers: [
        new ol.layer.Tile({ source: new ol.source.OSM() }),
        geojsonLayer
    ],
    view: new ol.View({
        center: ol.proj.fromLonLat([121.0, -25.0]),
        zoom: 5
    })
});

const overlay = new ol.Overlay({
    element: container,
    autoPan: true,
    autoPanAnimation: { duration: 250 }
});
map.addOverlay(overlay);

if (hideDisclaimer) {
    hideDisclaimer.onclick = function () {
        disclaimer.style.display = 'none';
    }
}

closer.onclick = function () {
    overlay.setPosition(undefined);
    closer.blur();
    return false;
};

geojsonSource.once('change', () => {
    if (geojsonSource.getState() === 'ready') {
        const extent = geojsonSource.getExtent();
        map.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 1000 });
    }
});

map.on('singleclick', function (evt) {
    const feature = map.forEachFeatureAtPixel(evt.pixel, (feat) => feat, {
        hitTolerance: 10
    });

    if (feature) {
        const props = feature.getProperties();

        const name = props.site_name || props.NAME || "UXO Potential Area";
        const description = props.description || props.LEGEND || "Refer to DFES for details.";
        const link = props.hyperlink || props.url;
        const category = props.uxo_category || "Not Specified";

        focusedUXO = props.unique_id || props.unique_num || props.id;

        infoname.innerHTML = `<strong>${name}</strong>`;
        infodescription.innerHTML = `<p>${description}</p>`;

        overlay.setPosition(evt.coordinate);
    } else {
        overlay.setPosition(undefined);
    }
});

map.on('pointermove', (e) => {
    const pixel = map.getEventPixel(e.originalEvent);
    const hit = map.hasFeatureAtPixel(pixel);
    map.getTargetElement().style.cursor = hit ? 'pointer' : '';
});