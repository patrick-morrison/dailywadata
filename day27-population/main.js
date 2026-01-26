const yearSlider = document.getElementById('myRange');
const yearValueDisplay = document.getElementById('yearValue');
const viewMode = document.getElementById('viewMode');
const modeHint = document.getElementById('modeHint');
const playButton = document.getElementById('playButton');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const stateSelect = document.getElementById('stateSelect');
const settingsCard = document.getElementById('settingsCard');
const mobileToggle = document.getElementById('mobileToggle');
const hideSettingsBtn = document.getElementById('hideSettingsBtn');
const container = document.getElementById('popup');

const MAP_CONFIGS = {
  pop: {
    hint: 'Total estimated resident population',
    stops: [
      { limit: 500000, color: '#48f0c0', label: '250k+' },
      { limit: 250000, color: '#3ccca3', label: '100k - 250k' },
      { limit: 100000, color: '#32a88d', label: '50k - 100k' },
      { limit: 50000, color: '#288577', label: '20k - 50k' },
      { limit: 25000, color: '#206b6b', label: '10k - 20k' },
      { limit: 10000, color: '#1a525a', label: '5k - 10k' },
      { limit: 5000, color: '#143d4a', label: '2.5k - 5k' },
      { limit: 2500, color: '#0e2b38', label: '1k - 2.5k' },
      { limit: 1000, color: '#0a1e28', label: '500 - 1k' },
      { limit: 500, color: '#06131c', label: '100 - 500' },
      { limit: 100, color: '#030a10', label: '25 - 100' },
      { limit: 0, color: '#010508', label: '0 - 25' }
    ]
  },
  growth: {
    hint: 'Year-on-year % change in population',
    stops: [
      { limit: 12, color: '#ffff00', label: '> 12%' },
      { limit: 8, color: '#e7e41e', label: '8% - 12%' },
      { limit: 6, color: '#fde725', label: '6% - 8%' },
      { limit: 3, color: '#b5de2b', label: '3% - 6%' },
      { limit: 1.5, color: '#6ece58', label: '1.5% - 3%' },
      { limit: 0.75, color: '#35b779', label: '0.75% - 1.5%' },
      { limit: -0.75, color: '#1f9e89', label: '0% - 0.75%' },
      { limit: -1.5, color: '#26828e', label: '-1.5% to 0%' },
      { limit: -3, color: '#31688e', label: '-3% to -1.5%' },
      { limit: -6, color: '#3e4989', label: '-6% to -3%' },
      { limit: -12, color: '#482878', label: '-12% to -6%' },
      { limit: -Infinity, color: '#440154', label: '< -12%' }
    ]
  },
  density: {
    hint: 'People per square kilometer',
    stops: [
      { limit: 1000, color: '#fcffa4', label: '1k+' },
      { limit: 750, color: '#fbe35a', label: '750 - 1k' },
      { limit: 500, color: '#f9d221', label: '500 - 750' },
      { limit: 250, color: '#fca50a', label: '250 - 500' },
      { limit: 100, color: '#f37819', label: '100 - 250' },
      { limit: 50, color: '#dd513a', label: '50 - 100' },
      { limit: 25, color: '#bc3754', label: '25 - 50' },
      { limit: 10, color: '#932667', label: '10 - 25' },
      { limit: 5, color: '#6a176e', label: '5 - 10' },
      { limit: 1, color: '#420a68', label: '1 - 5' },
      { limit: 0.1, color: '#160b39', label: '0.1 - 1' },
      { limit: -Infinity, color: '#000004', label: '< 0.1' }
    ]
  }
};

let activeFeature = null;
let isPlaying = false;
let playInterval;

function toggleSettingsPanel(forceCollapse = null) {
  const isCollapsed = forceCollapse !== null ? forceCollapse : !settingsCard.classList.contains('collapsed');

  if (isCollapsed) {
    settingsCard.classList.add('collapsed');
    if (openSettingsBtn) openSettingsBtn.classList.add('visible');
  } else {
    settingsCard.classList.remove('collapsed');
    if (openSettingsBtn) openSettingsBtn.classList.remove('visible');
  }
}

if (hideSettingsBtn) {
  hideSettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isCollapsed = settingsCard.classList.toggle('collapsed');
    hideSettingsBtn.classList.toggle('collapsed');
    hideSettingsBtn.setAttribute('aria-expanded', !isCollapsed);
  });
}

if (mobileToggle) {
  mobileToggle.addEventListener('click', () => {
    settingsCard.classList.toggle('collapsed');
    hideSettingsBtn.classList.toggle('collapsed');
    hideSettingsBtn.setAttribute('aria-expanded', !isCollapsed);
  });
}

window.addEventListener('resize', () => {
  if (window.innerWidth > window.innerHeight) {
    toggleSettingsPanel(false);
  }
});

const loader = document.getElementById('loader');

function showLoader() {
  if (loader) loader.style.display = 'flex';
}

function hideLoader() {
  if (loader) loader.style.display = 'none';
}

const geojsonSource = new ol.source.Vector({
  loader: function (extent, resolution, projection, success, failure) {
    fetch('population.geojson')
      .then(res => {
        if (!res.ok) throw new Error('Network response was not ok');
        return res.json();
      })
      .then(data => {
        const format = new ol.format.GeoJSON();
        const features = format.readFeatures(data, {
          dataProjection: 'EPSG:4326',
          featureProjection: projection
        });

        geojsonSource.addFeatures(features);
        hideLoader();
        if (success) success(features);
      })
      .catch(error => {
        console.error('Error loading GeoJSON:', error);
        hideLoader();
        alert('Failed to load map data.');
        if (failure) failure();
      });
  }
});

geojsonSource.on('featuresloaderror', () => hideLoader());

const getCategorizedColor = (val, mode) => {
  const config = MAP_CONFIGS[mode];
  const match = config.stops.find(s => val >= s.limit);
  return match ? match.color : config.stops[config.stops.length - 1].color;
};

const styleFunction = (feature) => {
  const year = parseInt(yearSlider.value);
  const mode = viewMode.value;
  const selectedState = stateSelect ? stateSelect.value : 'all';
  const props = feature.getProperties();
  const featureState = props['state_name_2021'];

  let val = 0;
  if (mode === 'density') {
    const pop = Number(props[`erp_${year}`]) || 0;
    const area = Number(props['area_km2']) || 0;
    val = area > 0 ? (pop / area) : 0;
  } else if (mode === 'growth' && year > 2001) {
    const current = Number(props[`erp_${year}`]);
    const previous = Number(props[`erp_${year - 1}`]);
    val = (current && previous) ? ((current - previous) / previous) * 100 : -999;
  } else {
    val = Number(props[`erp_${year}`]) || 0;
  }

  const isFocus = selectedState === 'all' || featureState === selectedState;

  if (!isFocus) {
    return new ol.style.Style({
      fill: new ol.style.Fill({ color: 'rgba(100, 100, 100, 0.08)' }),
      stroke: new ol.style.Stroke({ color: 'rgba(0, 0, 0, 0.03)', width: 0.5 })
    });
  }

  const finalColor = (mode === 'growth' && val === -999) ? 'rgba(0, 0, 0, 0.05)' : getCategorizedColor(val, mode);

  return new ol.style.Style({
    fill: new ol.style.Fill({ color: finalColor }),
    stroke: new ol.style.Stroke({ color: 'rgba(255, 255, 255, 0.5)', width: 0.8 }),
    zIndex: 1
  });
};

const geojsonLayer = new ol.layer.Vector({
  source: geojsonSource,
  style: styleFunction
});

const map = new ol.Map({
  target: 'map',
  layers: [geojsonLayer],
  view: new ol.View({
    center: ol.proj.fromLonLat([133.7751, -25.2744]),
    zoom: 4
  })
});

const overlay = new ol.Overlay({
  element: container,
  autoPan: true
});
map.addOverlay(overlay);

function updateLegendUI() {
  const mode = viewMode.value;
  const legendContainer = document.getElementById('discreteLegend');
  if (!legendContainer) return;

  legendContainer.innerHTML = '';
  MAP_CONFIGS[mode].stops.forEach(item => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'legend-item';
    itemDiv.innerHTML = `<div class="legend-color" style="background-color: ${item.color}"></div><span class="legend-label">${item.label}</span>`;
    legendContainer.appendChild(itemDiv);
  });
}

function updatePopupContent(feature) {
  if (!feature) return;

  const year = parseInt(yearSlider.value);
  const props = feature.getProperties();
  const currentPop = Number(props[`erp_${year}`]) || 0;
  const area = Number(props['area_km2']) || 0;
  const density = area > 0 ? (currentPop / area < 0.01 && currentPop > 0 ? '< 0.01' : (currentPop / area).toFixed(2)) : 0;
  const lgaName = props.lga_name_2024 || "Unknown Area";

  document.getElementById('popup-content-name').textContent = lgaName;
  document.getElementById('pop-year-label').textContent = year;
  document.getElementById('stat-pop').textContent = currentPop.toLocaleString();
  document.getElementById('stat-density').textContent = density;
  document.getElementById('stat-area').textContent = Math.round(area).toLocaleString();

  const growthContainer = document.getElementById('growth-container');
  if (year > 2001) {
    const prevPop = Number(props[`erp_${year - 1}`]);
    if (prevPop && prevPop > 0) {
      const growth = (((currentPop - prevPop) / prevPop) * 100).toFixed(2);
      const growthEl = document.getElementById('stat-growth');
      growthContainer.classList.remove('hidden');
      document.getElementById('prev-year-label').textContent = year - 1;
      growthEl.textContent = `${growth >= 0 ? '+' : ''}${growth}%`;
      growthEl.style.color = growth >= 0 ? '#16a34a' : '#dc2626';
    } else {
      growthContainer.classList.add('hidden');
    }
  } else {
    growthContainer.classList.add('hidden');
  }
}

function updateYear(val) {
  const numericYear = parseInt(val);
  yearSlider.value = numericYear;
  yearValueDisplay.textContent = numericYear;

  if (numericYear === 2001 && viewMode.value === 'growth') {
    viewMode.value = 'pop';
    modeHint.textContent = MAP_CONFIGS['pop'].hint;
  }

  geojsonLayer.changed();
  updateLegendUI();
  if (activeFeature) updatePopupContent(activeFeature);
}

map.on('singleclick', (evt) => {
  const feature = map.forEachFeatureAtPixel(evt.pixel, (f) => f);
  if (feature) {
    activeFeature = feature;
    updatePopupContent(feature);
    overlay.setPosition(evt.coordinate);
  } else {
    activeFeature = null;
    overlay.setPosition(undefined);
  }
});

function togglePlay() {
  isPlaying = !isPlaying;
  playIcon.classList.toggle('hidden', isPlaying);
  pauseIcon.classList.toggle('hidden', !isPlaying);
  if (isPlaying) {
    playInterval = setInterval(() => {
      let val = parseInt(yearSlider.value);
      updateYear(val >= 2024 ? 2001 : val + 1);
    }, 1000);
  } else {
    clearInterval(playInterval);
  }
}

playButton.addEventListener('click', togglePlay);

viewMode.addEventListener('change', () => {
  const mode = viewMode.value;
  modeHint.textContent = MAP_CONFIGS[mode].hint;
  yearSlider.min = (mode === 'growth') ? 2002 : 2001;
  if (parseInt(yearSlider.value) < yearSlider.min) updateYear(yearSlider.min);
  updateLegendUI();
  geojsonLayer.changed();
  if (activeFeature) updatePopupContent(activeFeature);
});

stateSelect.addEventListener('change', () => {
  geojsonLayer.changed();
  const selectedState = stateSelect.value;
  let extent;

  if (selectedState === 'all') {
    extent = geojsonSource.getExtent();
  } else {
    const features = geojsonSource.getFeatures().filter(f => f.get('state_name_2021') === selectedState);
    if (features.length > 0) {
      const tempSource = new ol.source.Vector({ features: features });
      extent = tempSource.getExtent();
    }
  }

  if (extent) {
    const isPortrait = window.innerHeight > window.innerWidth;
    const padding = isPortrait ? [80, 20, window.innerHeight * 0.45, 20] : [100, 50, 50, 320];

    map.getView().fit(extent, {
      padding: padding,
      duration: 1200,
      easing: ol.easing.easeInOut,
      maxZoom: selectedState === 'Australian Capital Territory' ? 9 : 14
    });
  }
});

yearSlider.addEventListener('input', (e) => {
  if (isPlaying) togglePlay();
  updateYear(e.target.value);
});

document.getElementById('popup-closer').onclick = () => {
  overlay.setPosition(undefined);
  activeFeature = null;
  return false;
};

geojsonSource.once('change', () => {
  if (geojsonSource.getState() === 'ready') {
    map.getView().fit(geojsonSource.getExtent(), { padding: [50, 50, 50, 50] });
    updateLegendUI();
  }
});

map.on('pointermove', (e) => {
  map.getTargetElement().classList.toggle('cursor-pointer', map.hasFeatureAtPixel(e.pixel));
});

updateLegendUI();