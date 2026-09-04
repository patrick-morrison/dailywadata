/**
 * Western Australia Tides 2026 - Interactive Tide Calendar
 * Sourced from Bureau of Meteorology & Department of Transport WA
 */

let LOCATIONS = null;

const MONTH_NAMES = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'
];

const DAY_ABBRS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

let tideData = null;
let currentLocation = 'fremantle';
let neapDaysSet = new Set();
let filters = {
    heightMin: 0,
    heightMax: 1.5,
    timeMin: 0,
    timeMax: 1440,
    showHighs: true,
    showLows: true,
    neapsOnly: false
};

// DOM Elements
const calendarGrid = document.getElementById('calendar-grid');
const locationSelect = document.getElementById('location');
const heightMinInput = document.getElementById('height-min');
const heightMaxInput = document.getElementById('height-max');
const timeMinInput = document.getElementById('time-min');
const timeMaxInput = document.getElementById('time-max');
const heightDisplay = document.getElementById('height-display');
const timeDisplay = document.getElementById('time-display');
const filterSummary = document.getElementById('filter-summary');
const showHighsCheckbox = document.getElementById('show-highs');
const showLowsCheckbox = document.getElementById('show-lows');
const neapsOnlyCheckbox = document.getElementById('neaps-only');
const headerTitle = document.querySelector('.header-title h1');
const headerSubtitle = document.querySelector('.header-title .subtitle');

async function init() {
    try {
        const resp = await fetch('locations.json');
        LOCATIONS = await resp.json();
    } catch (e) {
        console.warn('Could not load locations.json, using fallback dictionary', e);
        LOCATIONS = {
            fremantle: {
                id: 'fremantle',
                name: 'Fremantle',
                file: 'tides_fremantle.json',
                title: 'FREMANTLE – WESTERN AUSTRALIA',
                subtitle: "LAT 32° 03' S    LONG 115° 44' E",
                minHeight: 0.0,
                maxHeight: 1.6,
                heightStep: 0.1
            }
        };
    }

    if (locationSelect) {
        currentLocation = locationSelect.value || 'fremantle';
    }

    setupEventListeners();
    await loadData(currentLocation);
}

function computeNeapDays(tides) {
    // Calculates daily tidal range and identifies the fortnightly neap windows (local range minima)
    const byDate = {};
    tides.forEach(t => {
        if (!byDate[t.date]) byDate[t.date] = [];
        byDate[t.date].push(t.height);
    });

    const dates = Object.keys(byDate).sort();
    const dailyRanges = dates.map(d => {
        const hs = byDate[d];
        return hs.length > 0 ? (Math.max(...hs) - Math.min(...hs)) : 0;
    });

    const neaps = new Set();
    for (let i = 0; i < dates.length; i++) {
        const wStart = Math.max(0, i - 6);
        const wEnd = Math.min(dates.length, i + 7);
        const minRange = Math.min(...dailyRanges.slice(wStart, wEnd));

        // Peak neap day (local minimum of water movement)
        if (dailyRanges[i] === minRange) {
            for (let offset = -1; offset <= 1; offset++) {
                const idx = i + offset;
                if (idx >= 0 && idx < dates.length) {
                    neaps.add(dates[idx]);
                }
            }
        }
    }
    return neaps;
}

async function loadData(locationId) {
    calendarGrid.innerHTML = '<div class="loading">Loading tide data...</div>';
    try {
        const loc = LOCATIONS && LOCATIONS[locationId] ? LOCATIONS[locationId] : {
            file: `tides_${locationId}.json`,
            title: locationId.toUpperCase(),
            subtitle: ''
        };

        const response = await fetch(loc.file);
        tideData = await response.json();

        headerTitle.textContent = tideData.title || loc.title || 'WESTERN AUSTRALIA';
        headerSubtitle.textContent = tideData.subtitle || loc.subtitle || '';

        // Detect neap days for this port's tidal cycle
        neapDaysSet = computeNeapDays(tideData.tides);

        // Dynamically adjust height slider range based on port data
        configureHeightSlider(tideData, loc);

        renderCalendar();
    } catch (error) {
        calendarGrid.innerHTML = '<div class="loading">Error loading tide data</div>';
        console.error('Failed to load tide data:', error);
    }
}

function configureHeightSlider(data, locMeta) {
    if (!data.tides || data.tides.length === 0) return;

    let minH, maxH;
    if (locMeta && typeof locMeta.minHeight === 'number' && typeof locMeta.maxHeight === 'number') {
        minH = locMeta.minHeight;
        maxH = locMeta.maxHeight;
    } else {
        const heights = data.tides.map(t => t.height);
        minH = Math.max(0.0, Math.floor(Math.min(...heights) * 10) / 10);
        maxH = Math.ceil((Math.max(...heights) + 0.1) * 10) / 10;
    }

    heightMinInput.min = minH;
    heightMinInput.max = maxH;
    heightMinInput.step = "0.1";
    heightMinInput.value = minH;

    heightMaxInput.min = minH;
    heightMaxInput.max = maxH;
    heightMaxInput.step = "0.1";
    heightMaxInput.value = maxH;

    filters.heightMin = minH;
    filters.heightMax = maxH;

    heightDisplay.textContent = `${minH.toFixed(1)}m – ${maxH.toFixed(1)}m`;
    updateSliderVisuals(heightMinInput.parentElement);
}

function setupEventListeners() {
    locationSelect.addEventListener('change', (e) => {
        currentLocation = e.target.value;
        loadData(currentLocation);
    });

    function handleSlider(e) {
        const isMin = e.target.id.includes('min');
        const parent = e.target.parentElement;
        const minInput = parent.querySelector('input[id$="-min"]');
        const maxInput = parent.querySelector('input[id$="-max"]');
        const minVal = parseFloat(minInput.value);
        const maxVal = parseFloat(maxInput.value);

        if (minVal > maxVal - (parseFloat(minInput.step) || 0)) {
            if (isMin) minInput.value = maxVal;
            else maxInput.value = minVal;
        }

        updateSliderVisuals(parent);
        updateFilters();
    }

    [heightMinInput, heightMaxInput, timeMinInput, timeMaxInput].forEach(input => {
        input.addEventListener('input', handleSlider);
    });

    showHighsCheckbox.addEventListener('change', updateFilters);
    showLowsCheckbox.addEventListener('change', updateFilters);
    if (neapsOnlyCheckbox) {
        neapsOnlyCheckbox.addEventListener('change', updateFilters);
    }

    updateSliderVisuals(heightMinInput.parentElement);
    updateSliderVisuals(timeMinInput.parentElement);
}

function updateSliderVisuals(container) {
    const minInput = container.querySelector('input[id$="-min"]');
    const maxInput = container.querySelector('input[id$="-max"]');
    const track = container.querySelector('.slider-track');
    if (!track) return;

    const min = parseFloat(minInput.min);
    const max = parseFloat(maxInput.max);
    const valMin = parseFloat(minInput.value);
    const valMax = parseFloat(maxInput.value);
    const percentMin = ((valMin - min) / (max - min)) * 100;
    const percentMax = ((valMax - min) / (max - min)) * 100;

    track.style.background = `linear-gradient(to right, #ddd ${percentMin}%, #000 ${percentMin}%, #000 ${percentMax}%, #ddd ${percentMax}%)`;
}

function updateFilters() {
    filters.heightMin = parseFloat(heightMinInput.value);
    filters.heightMax = parseFloat(heightMaxInput.value);
    filters.timeMin = parseInt(timeMinInput.value);
    filters.timeMax = parseInt(timeMaxInput.value);
    filters.showHighs = showHighsCheckbox.checked;
    filters.showLows = showLowsCheckbox.checked;
    filters.neapsOnly = neapsOnlyCheckbox ? neapsOnlyCheckbox.checked : false;

    heightDisplay.textContent = `${filters.heightMin.toFixed(1)}m – ${filters.heightMax.toFixed(1)}m`;
    const maxTimeDisplay = filters.timeMax >= 1439 ? '23:59' : formatMinutes(filters.timeMax);
    timeDisplay.textContent = `${formatMinutes(filters.timeMin)} – ${maxTimeDisplay}`;

    updateHighlights();
    updateFilterSummary();
}

function formatMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

function renderCalendar() {
    const tidesByDate = groupTidesByDate(tideData.tides);
    calendarGrid.innerHTML = '';

    for (let month = 0; month < 12; month++) {
        const monthEl = createMonthElement(month, tidesByDate);
        calendarGrid.appendChild(monthEl);
    }

    updateFilterSummary();
}

function groupTidesByDate(tides) {
    const grouped = {};
    tides.forEach(tide => {
        if (!grouped[tide.date]) grouped[tide.date] = [];
        grouped[tide.date].push({
            ...tide,
            displayTime: tide.time,
            displayHeight: tide.height
        });
    });
    return grouped;
}

function createMonthElement(monthIndex, tidesByDate) {
    const monthEl = document.createElement('div');
    monthEl.className = 'month';

    const header = document.createElement('div');
    header.className = 'month-header';
    header.innerHTML = `
        <span>${MONTH_NAMES[monthIndex]}</span>
        <div class="col-header">
            <span>Time</span>
            <span>m</span>
        </div>
    `;
    monthEl.appendChild(header);

    const daysContainer = document.createElement('div');
    daysContainer.className = 'month-days';

    const col1 = document.createElement('div');
    col1.className = 'month-col';
    const col2 = document.createElement('div');
    col2.className = 'month-col';

    const year = tideData.year;
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${(monthIndex + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
        const dayTides = tidesByDate[dateStr] || [];
        const dayOfWeek = new Date(year, monthIndex, day).getDay();
        const isNeap = neapDaysSet.has(dateStr);
        const dayRow = createDayRow(day, dayOfWeek, dayTides, isNeap, dateStr);

        if (day <= 15) col1.appendChild(dayRow);
        else col2.appendChild(dayRow);
    }

    daysContainer.appendChild(col1);
    daysContainer.appendChild(col2);
    monthEl.appendChild(daysContainer);

    return monthEl;
}

function createDayRow(day, dayOfWeek, tides, isNeap, dateStr) {
    const row = document.createElement('div');
    const isDimmedDay = filters.neapsOnly && !isNeap;
    row.className = `day-row ${isNeap ? 'is-neap' : ''} ${isDimmedDay ? 'dimmed-day' : ''}`;
    row.dataset.date = dateStr;
    row.dataset.isNeap = isNeap ? "true" : "false";

    row.innerHTML = `
        <div class="day-info">
            <span class="day-num">${day}</span>
            <span class="day-abbr">${DAY_ABBRS[dayOfWeek]}</span>
            ${isNeap ? '<span class="neap-badge" title="Neap window: minimum daily tidal movement">Neap</span>' : ''}
        </div>
        <div class="tides-list">
            ${tides.map(tide => createTideEntry(tide, isNeap)).join('')}
        </div>
    `;
    return row;
}

function createTideEntry(tide, isNeap) {
    const timeMinutes = timeToMinutes(tide.displayTime.replace(/(\d{2})(\d{2})/, '$1:$2'));
    const tideType = tide.type || 'unknown';
    const isMatch = matchesFilters(tide.displayHeight, timeMinutes, tideType, isNeap);
    const className = isMatch ? 'highlighted' : (hasActiveFilters() ? 'dimmed' : '');

    return `
        <div class="tide-entry ${className}" 
             data-height="${tide.displayHeight.toFixed(2)}" 
             data-time="${timeMinutes}"
             data-type="${tideType}">
            <span class="tide-time">${tide.displayTime}</span>
            <span class="tide-height">${tide.displayHeight.toFixed(2)}</span>
        </div>
    `;
}

function matchesFilters(height, timeMinutes, tideType, isNeap) {
    const heightMatch = height >= filters.heightMin && height <= filters.heightMax;
    const timeMatch = timeMinutes >= filters.timeMin && timeMinutes <= filters.timeMax;
    const typeMatch = (tideType === 'high' && filters.showHighs) ||
        (tideType === 'low' && filters.showLows) ||
        (tideType === 'unknown');
    const neapMatch = !filters.neapsOnly || isNeap;
    return heightMatch && timeMatch && typeMatch && neapMatch;
}

function hasActiveFilters() {
    const minH = parseFloat(heightMinInput.min);
    const maxH = parseFloat(heightMaxInput.max);
    return filters.heightMin > minH ||
        filters.heightMax < maxH ||
        filters.timeMin > 0 ||
        filters.timeMax < 1440 ||
        !filters.showHighs ||
        !filters.showLows ||
        filters.neapsOnly;
}

function updateHighlights() {
    const rows = document.querySelectorAll('.day-row');
    rows.forEach(row => {
        const isNeap = row.dataset.isNeap === "true";
        row.classList.toggle('dimmed-day', filters.neapsOnly && !isNeap);
    });

    const entries = document.querySelectorAll('.tide-entry');
    entries.forEach(entry => {
        const height = parseFloat(entry.dataset.height);
        const time = parseInt(entry.dataset.time);
        const tideType = entry.dataset.type || 'unknown';
        const dayRow = entry.closest('.day-row');
        const isNeap = dayRow && dayRow.dataset.isNeap === "true";
        const isMatch = matchesFilters(height, time, tideType, isNeap);

        entry.classList.toggle('highlighted', isMatch);
        entry.classList.toggle('dimmed', !isMatch && hasActiveFilters());
    });
}

function updateFilterSummary() {
    const entries = document.querySelectorAll('.tide-entry');
    const matching = document.querySelectorAll('.tide-entry.highlighted, .tide-entry:not(.dimmed)');
    const count = hasActiveFilters()
        ? document.querySelectorAll('.tide-entry.highlighted').length
        : entries.length;

    const neapNote = filters.neapsOnly ? ' (Neap days only)' : '';
    filterSummary.textContent = `Showing ${count} of ${entries.length} tides${neapNote}`;
}

// Sticky header offset observer
const controlsEl = document.querySelector('.controls');
if (controlsEl) {
    const resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            const height = entry.contentRect.height +
                parseFloat(getComputedStyle(entry.target).paddingTop) +
                parseFloat(getComputedStyle(entry.target).paddingBottom) +
                parseFloat(getComputedStyle(entry.target).borderBottomWidth);
            document.documentElement.style.setProperty('--controls-height', `${height}px`);
        }
    });
    resizeObserver.observe(controlsEl);
}

init();
