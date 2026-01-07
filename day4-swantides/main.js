/**
 * Swan Tides 2026 - Interactive Tide Calendar
 */

const LOCATIONS = {
    fremantle: {
        file: 'tides_fremantle.json',
        title: 'FREMANTLE – WESTERN AUSTRALIA',
        subtitle: "LAT 32°03' S    LONG 115°44' E"
    },
    barrack: {
        file: 'tides_barrack.json',
        title: 'PERTH (BARRACK STREET JETTY) – WESTERN AUSTRALIA',
        subtitle: "LAT 31° 57' S LONG 115° 51' E"
    }
};

const MONTH_NAMES = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'
];

const DAY_ABBRS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

let tideData = null;
let currentLocation = 'fremantle';
let filters = {
    heightMin: 0,
    heightMax: 1.5,
    timeMin: 0,
    timeMax: 1440,
    showHighs: true,
    showLows: true
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
const headerTitle = document.querySelector('.header-title h1');
const headerSubtitle = document.querySelector('.header-title .subtitle');

async function init() {
    await loadData(currentLocation);
    setupEventListeners();
}

async function loadData(locationId) {
    calendarGrid.innerHTML = '<div class="loading">Loading tide data...</div>';
    try {
        const loc = LOCATIONS[locationId];
        const response = await fetch(loc.file);
        tideData = await response.json();
        headerTitle.textContent = loc.title;
        headerSubtitle.textContent = loc.subtitle;
        renderCalendar();
    } catch (error) {
        calendarGrid.innerHTML = '<div class="loading">Error loading tide data</div>';
        console.error('Failed to load tide data:', error);
    }
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
        const dayRow = createDayRow(day, dayOfWeek, dayTides);

        if (day <= 15) col1.appendChild(dayRow);
        else col2.appendChild(dayRow);
    }

    daysContainer.appendChild(col1);
    daysContainer.appendChild(col2);
    monthEl.appendChild(daysContainer);

    return monthEl;
}

function createDayRow(day, dayOfWeek, tides) {
    const row = document.createElement('div');
    row.className = 'day-row';
    row.innerHTML = `
        <div class="day-info">
            <span class="day-num">${day}</span>
            <span class="day-abbr">${DAY_ABBRS[dayOfWeek]}</span>
        </div>
        <div class="tides-list">
            ${tides.map(tide => createTideEntry(tide)).join('')}
        </div>
    `;
    return row;
}

function createTideEntry(tide) {
    const timeMinutes = timeToMinutes(tide.displayTime.replace(/(\d{2})(\d{2})/, '$1:$2'));
    const tideType = tide.type || 'unknown';
    const isMatch = matchesFilters(tide.displayHeight, timeMinutes, tideType);
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

function matchesFilters(height, timeMinutes, tideType) {
    const heightMatch = height >= filters.heightMin && height <= filters.heightMax;
    const timeMatch = timeMinutes >= filters.timeMin && timeMinutes <= filters.timeMax;
    const typeMatch = (tideType === 'high' && filters.showHighs) ||
        (tideType === 'low' && filters.showLows) ||
        (tideType === 'unknown');
    return heightMatch && timeMatch && typeMatch;
}

function hasActiveFilters() {
    return filters.heightMin > 0 ||
        filters.heightMax < 1.5 ||
        filters.timeMin > 0 ||
        filters.timeMax < 1440 ||
        !filters.showHighs ||
        !filters.showLows;
}

function updateHighlights() {
    const entries = document.querySelectorAll('.tide-entry');
    entries.forEach(entry => {
        const height = parseFloat(entry.dataset.height);
        const time = parseInt(entry.dataset.time);
        const tideType = entry.dataset.type || 'unknown';
        const isMatch = matchesFilters(height, time, tideType);

        entry.classList.toggle('highlighted', isMatch);
        entry.classList.toggle('dimmed', !isMatch && hasActiveFilters());
    });
}

function updateFilterSummary() {
    const entries = document.querySelectorAll('.tide-entry');
    const matching = document.querySelectorAll('.tide-entry:not(.dimmed)');
    filterSummary.textContent = `Showing ${matching.length} of ${entries.length} tides`;
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
