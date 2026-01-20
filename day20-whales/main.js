/**
 * Day 20 - Whale Sightings Interactive Map
 * Western Australian Coast 2008-2011
 */

// ============================================
// State
// ============================================

const state = {
    map: null,
    deckOverlay: null,
    chart: null,
    data: [],           // All whale sighting records
    timepoints: [],     // Unique datetime points for timeline
    currentIndex: 0,
    rangeStart: 0,      // Start index of selected range
    rangeEnd: 0,        // End index of selected range (inclusive)
    isSelectingRange: false,  // Whether user is currently dragging to select
    isPlaying: false,
    animationInterval: null
};

// Whale marker color (Humpback blue)
const WHALE_COLOR = [59, 130, 246, 200];

// ============================================
// Initialization
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    initializeMap();
});

// ============================================
// Data Loading
// ============================================

async function loadData() {
    return new Promise((resolve, reject) => {
        Papa.parse('whales.csv', {
            download: true,
            header: true,
            dynamicTyping: true,
            complete: (results) => {
                console.log('CSV loaded, raw rows:', results.data.length);
                state.data = results.data.filter(d => d.lat && d.lng && d.date);
                console.log('Valid data rows:', state.data.length);
                if (state.data.length > 0) {
                    console.log('Sample record:', state.data[0]);
                }
                processDataForTimeline();
                resolve();
            },
            error: (err) => {
                console.error('CSV load error:', err);
                reject(err);
            }
        });
    });
}

function processDataForTimeline() {
    // Create datetime key for each record and sort
    state.data.forEach(d => {
        d.datetime = `${d.date}T${d.time}`;
        d.timestamp = new Date(d.datetime).getTime();
    });

    // Sort data by datetime
    state.data.sort((a, b) => a.timestamp - b.timestamp);

    // Get unique datetime points (each sighting is a timepoint)
    // Group sightings that happen at exact same datetime
    const timepointMap = {};
    state.data.forEach(d => {
        if (!timepointMap[d.datetime]) {
            timepointMap[d.datetime] = {
                datetime: d.datetime,
                date: d.date,
                time: d.time,
                timestamp: d.timestamp,
                sightings: []
            };
        }
        timepointMap[d.datetime].sightings.push(d);
    });

    state.timepoints = Object.values(timepointMap).sort((a, b) =>
        a.timestamp - b.timestamp
    );
    clearSelection();
}

// ============================================
// Map Initialization
// ============================================

function initializeMap() {
    // Initialize MapLibre with satellite basemap
    // Start centered on WA Kimberley coast, fitBounds will adjust
    state.map = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
            sources: {
                satellite: {
                    type: 'raster',
                    tiles: [
                        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                    ],
                    tileSize: 256
                }
            },
            layers: [{
                id: 'satellite',
                type: 'raster',
                source: 'satellite'
            }]
        },
        center: [123.35201658094138, -16.968302771286815],  // Kimberley coast, WA
        zoom: 6.443248335685459,
        maxZoom: 17,
        minZoom: 4,
        attributionControl: false
    });

    state.map.addControl(new maplibregl.NavigationControl(), 'top-right');
    state.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    state.map.on('load', () => {
        console.log('Map loaded, data length:', state.data.length);
        initializeDeckOverlay();
        initializeChart();
        setupPlayButton();
        updateVisualization();
    });
}

// ============================================
// Deck.gl Overlay
// ============================================

function initializeDeckOverlay() {
    state.deckOverlay = new deck.MapboxOverlay({
        layers: []
    });
    state.map.addControl(state.deckOverlay);
}

function updateDeckLayers(visibleData) {
    if (!state.deckOverlay) return;

    const scatterLayer = new deck.ScatterplotLayer({
        id: 'whale-sightings',
        data: visibleData,
        pickable: true,
        opacity: 0.8,
        stroked: true,
        filled: true,
        radiusScale: 1,
        radiusMinPixels: 6,
        radiusMaxPixels: 30,
        lineWidthMinPixels: 1,
        getPosition: d => [d.lng, d.lat],
        getRadius: d => Math.max(300, (d.total || 1) * 150),
        getFillColor: WHALE_COLOR,
        getLineColor: [255, 255, 255, 200],
        onClick: (info) => {
            if (info.object) {
                showPopup(info.object, info.x, info.y);
            }
        }
    });

    state.deckOverlay.setProps({ layers: [scatterLayer] });
}

// ============================================
// Popup
// ============================================

function showPopup(data, x, y) {
    const popup = document.getElementById('popup');
    const content = document.getElementById('popup-content');

    // Format species name
    const speciesName = {
        'HB': 'Humpback Whale',
        'SR': 'Southern Right Whale',
        'Unknown': 'Unknown Species'
    }[data.species] || data.species;

    // Format date
    const dateObj = new Date(data.date);
    const formattedDate = dateObj.toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });

    // Build popup content
    let html = `<div class="popup-date">${formattedDate}</div>`;
    html += `<div class="popup-species">${speciesName}</div>`;

    if (data.adults > 0 || data.calves > 0) {
        const parts = [];
        if (data.adults > 0) parts.push(`${data.adults} adult${data.adults > 1 ? 's' : ''}`);
        if (data.calves > 0) parts.push(`${data.calves} calf${data.calves > 1 ? 'ves' : ''}`);
        html += `<div class="popup-count">${parts.join(', ')}</div>`;
    } else if (data.total > 0) {
        html += `<div class="popup-count">${data.total} whale${data.total > 1 ? 's' : ''}</div>`;
    }

    if (data.location) {
        html += `<div class="popup-location">${data.location}</div>`;
    }

    content.innerHTML = html;

    // Position popup
    const mapContainer = document.getElementById('map');
    const rect = mapContainer.getBoundingClientRect();

    let popupX = x + 10;
    let popupY = y - 10;

    // Keep within viewport
    popup.classList.remove('hidden');
    const popupRect = popup.getBoundingClientRect();

    if (popupX + popupRect.width > rect.width - 20) {
        popupX = x - popupRect.width - 10;
    }
    if (popupY + popupRect.height > rect.height - 20) {
        popupY = y - popupRect.height - 10;
    }
    if (popupY < 10) popupY = 10;

    popup.style.left = popupX + 'px';
    popup.style.top = popupY + 'px';
}

function hidePopup() {
    document.getElementById('popup').classList.add('hidden');
}

// Setup popup close button
document.getElementById('popup-close')?.addEventListener('click', hidePopup);

// Close popup on map click (outside markers)
document.getElementById('map')?.addEventListener('click', (e) => {
    if (e.target.closest('.popup')) return;
    hidePopup();
});

// ============================================
// Timeline Chart
// ============================================

function initializeChart() {
    const ctx = document.getElementById('timeline-chart').getContext('2d');

    // Prepare chart data - use indices for even spacing
    const chartData = state.timepoints.map((tp, i) => {
        const totalWhales = tp.sightings.reduce((sum, s) => sum + (s.adults || 0) + (s.calves || 0), 0);
        return { x: i, y: totalWhales };
    });

    // Find significant time gaps (> 7 days) for break markers
    const GAP_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
    const breakAnnotations = {};

    let nAnnotations = 0;
    for (let i = 1; i < state.timepoints.length; i++) {
        const gap = state.timepoints[i].timestamp - state.timepoints[i - 1].timestamp;
        if (gap > GAP_THRESHOLD) {
            const gapDays = Math.round(gap / (24 * 60 * 60 * 1000));
            const prevDate = new Date(state.timepoints[i - 1].date);
            const nextDate = new Date(state.timepoints[i].date);

            // Create break marker annotation
            breakAnnotations[`break_${i}`] = {
                type: 'box',
                xMin: i - 0.5,
                xMax: i - 0.5,
                backgroundColor: 'rgba(0, 0, 0, 0.08)',
                borderColor: 'rgba(0, 0, 0, 0.2)',
                borderWidth: 1,
                borderDash: [4, 4],
                label: {
                    display: 'auto',
                    content: formatGapLabel(prevDate, nextDate, gapDays),
                    position: 'start',
                    font: { size: 9 },
                    color: 'rgba(0, 0, 0, 0.5)',
                    backgroundColor: 'rgba(255, 255, 255, 0.8)',
                    padding: 2,
                    yAdjust: (nAnnotations)*15
                }
            };
            nAnnotations++;
        }
    }

    state.chart = new Chart(ctx, {
        type: 'bar',
        data: {
            datasets: [{
                label: 'Whales',
                data: chartData,
                backgroundColor: 'rgba(59, 130, 246, 0.7)',
                borderColor: 'rgba(59, 130, 246, 1)',
                borderWidth: 0,
                borderRadius: 2,
                barPercentage: 0.9,
                categoryPercentage: 0.95
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            onClick: handleChartClick,
            scales: {
                x: {
                    type: 'linear',
                    min: -0.5,
                    max: state.timepoints.length - 0.5,
                    ticks: {
                        color: 'rgba(0,0,0,0.5)',
                        maxTicksLimit: 8,
                        font: { size: 10 },
                        callback: (value) => {
                            const idx = Math.round(value);
                            if (idx >= 0 && idx < state.timepoints.length) {
                                const tp = state.timepoints[idx];
                                const date = new Date(tp.date);
                                return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });
                            }
                            return '';
                        }
                    },
                    grid: { color: 'rgba(0,0,0,0.06)' }
                },
                y: {
                    min: 0,
                    ticks: {
                        color: 'rgba(0,0,0,0.5)',
                        font: { size: 10 }
                    },
                    grid: { color: 'rgba(0,0,0,0.06)' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    callbacks: {
                        title: (items) => {
                            if (items.length > 0) {
                                const idx = Math.round(items[0].parsed.x);
                                if (idx >= 0 && idx < state.timepoints.length) {
                                    const tp = state.timepoints[idx];
                                    const date = new Date(tp.date);
                                    return date.toLocaleDateString('en-AU', {
                                        day: 'numeric',
                                        month: 'long',
                                        year: 'numeric'
                                    }) + ' at ' + tp.time;
                                }
                            }
                            return '';
                        },
                        label: (item) => `${item.parsed.y} whale${item.parsed.y !== 1 ? 's' : ''}`
                    }
                },
                annotation: {
                    annotations: {
                        selectionBox: {
                            type: 'box',
                            xMin: -0.4,
                            xMax: 0.4,
                            backgroundColor: 'rgba(59, 130, 246, 0.2)',
                            borderColor: 'rgba(59, 130, 246, 0.8)',
                            borderWidth: 2,
                            borderRadius: 4,
                            z: 5
                        },
                        ...breakAnnotations
                    }
                }
            }
        }
    });

    setupChartDrag();
}

// Format the gap label for break markers
function formatGapLabel(prevDate, nextDate, days) {
    const prevYear = prevDate.getFullYear();
    const nextYear = nextDate.getFullYear();

    if (prevYear !== nextYear) {
        return `${prevYear} → ${nextYear}`;
    } else if (days > 30) {
        const months = Math.round(days / 30);
        return `${months}mo gap`;
    } else {
        return `${days}d`;
    }
}

function handleChartClick(event, elements, chart) {
    // Click handling is now done in setupChartDrag
    // This is kept for Chart.js but we handle selection ourselves
}

function setupChartDrag() {
    if (!state.chart) return;

    const canvas = state.chart.canvas;
    let dragStartIndex = null;

    const getIndexFromEvent = (e) => {
        const chartArea = state.chart.chartArea;
        if (!chartArea) return null;

        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX ?? e.touches?.[0]?.clientX;
        if (clientX == null) return null;

        const x = clientX - rect.left;
        if (x < chartArea.left || x > chartArea.right) return null;

        const clampedX = Math.max(chartArea.left, Math.min(chartArea.right, x));
        const xScale = state.chart.scales.x;
        const index = Math.round(xScale.getValueForPixel(clampedX));
        return Math.max(0, Math.min(state.timepoints.length - 1, index));
    };

    const handleStart = (e) => {
        const chartArea = state.chart.chartArea;
        if (!chartArea) return;

        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX ?? e.touches?.[0]?.clientX;
        const clientY = e.clientY ?? e.touches?.[0]?.clientY;
        if (clientX == null || clientY == null) return;

        const x = clientX - rect.left;
        const y = clientY - rect.top;

        if (x < chartArea.left || x > chartArea.right || y < chartArea.top || y > chartArea.bottom) {
            return;
        }

        const index = getIndexFromEvent(e);
        if (index === null) return;

        // Start range selection
        dragStartIndex = index;
        state.isSelectingRange = true;
        state.rangeStart = index;
        state.rangeEnd = index;
        canvas.style.cursor = 'col-resize';

        updateChartHighlight();
    };

    const handleMove = (e) => {
        if (!state.isSelectingRange || dragStartIndex === null) return;

        const index = getIndexFromEvent(e);
        if (index === null) return;

        // Update range - ensure start <= end
        state.rangeStart = Math.min(dragStartIndex, index);
        state.rangeEnd = Math.max(dragStartIndex, index);

        updateChartHighlight();
    };

    const handleEnd = () => {
        if (state.isSelectingRange) {
            state.isSelectingRange = false;
            canvas.style.cursor = '';
            // Update visualization with the selected range
            updateVisualization();
        }
        dragStartIndex = null;
    };

    canvas.addEventListener('mousedown', handleStart);
    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseup', handleEnd);
    canvas.addEventListener('mouseleave', handleEnd);

    canvas.addEventListener('touchstart', handleStart, { passive: true });
    canvas.addEventListener('touchmove', handleMove, { passive: true });
    canvas.addEventListener('touchend', handleEnd, { passive: true });
}

function updateChartHighlight() {
    if (!state.chart) return;

    const annotations = state.chart.options.plugins.annotation.annotations;
    annotations.selectionBox.xMin = state.rangeStart - 0.4;
    annotations.selectionBox.xMax = state.rangeEnd + 0.4;

    // Remove animation line when not playing
    if (annotations.animationLine) {
        delete annotations.animationLine;
    }

    state.chart.update('none');
}

// ============================================
// Visualization Update
// ============================================

function updateVisualization() {
    // Collect all sightings from rangeStart to rangeEnd
    const visibleData = [];
    for (let i = state.rangeStart; i <= state.rangeEnd; i++) {
        const tp = state.timepoints[i];
        if (tp) {
            visibleData.push(...tp.sightings);
        }
    }

    // Update deck layers
    updateDeckLayers(visibleData);

    // Update chart highlight
    updateChartHighlight();

    // Update info panel
    updateInfoPanel();
}

function updateInfoPanel() {
    const dateValue = document.getElementById('date-value');
    const adultsValue = document.getElementById('adults-value');
    const calvesValue = document.getElementById('calves-value');

    const startTp = state.timepoints[state.rangeStart];
    const endTp = state.timepoints[state.rangeEnd];

    if (!startTp) return;

    // Format date display
    if (dateValue) {
        const startDate = new Date(startTp.date);
        const startStr = startDate.toLocaleDateString('en-AU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });

        if (state.rangeStart === state.rangeEnd) {
            // Single timepoint selected
            dateValue.textContent = `${startStr} ${startTp.time}`;
        } else {
            // Range selected - show date range
            const endDate = new Date(endTp.date);
            const endStr = endDate.toLocaleDateString('en-AU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric'
            });

            if (startStr === endStr) {
                // Same day range
                dateValue.textContent = `${startStr}`;
            } else {
                dateValue.textContent = `${startStr} - ${endStr}`;
            }
        }
    }

    // Sum adults and calves across all sightings in the range
    let totalAdults = 0;
    let totalCalves = 0;
    for (let i = state.rangeStart; i <= state.rangeEnd; i++) {
        const tp = state.timepoints[i];
        if (tp) {
            totalAdults += tp.sightings.reduce((sum, s) => sum + (s.adults || 0), 0);
            totalCalves += tp.sightings.reduce((sum, s) => sum + (s.calves || 0), 0);
        }
    }

    if (adultsValue) {
        adultsValue.textContent = totalAdults;
    }

    if (calvesValue) {
        calvesValue.textContent = totalCalves;
    }
}

// ============================================
// Animation Controls
// ============================================

function setupPlayButton() {
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.addEventListener('click', () => {
            if (state.isPlaying) {
                stopAnimation();
            } else {
                startAnimation();
            }
        });
    }

    const clearBtn = document.getElementById('clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearSelection();
        });
    }

    const collapseBtn = document.getElementById('collapse-btn');
    const shelf = document.getElementById('shelf');
    if (collapseBtn && shelf) {
        // Start collapsed on mobile
        if (window.innerWidth <= 768) {
            shelf.classList.add('collapsed');
        }

        collapseBtn.addEventListener('click', () => {
            shelf.classList.toggle('collapsed');
            // Resize chart when expanding
            if (!shelf.classList.contains('collapsed') && state.chart) {
                setTimeout(() => state.chart.resize(), 50);
            }
        });
    }
}

function clearSelection() {
    // Stop any animation
    if (state.isPlaying) {
        stopAnimation();
    }

    // Select all timepoints
    state.rangeStart = 0;
    state.rangeEnd = state.timepoints.length - 1;

    updateVisualization();
}

function startAnimation() {
    state.isPlaying = true;
    document.getElementById('play-btn')?.classList.add('playing');

    // Start from the beginning of the selected range
    state.currentIndex = state.rangeStart;

    // Show initial frame
    updateAnimationFrame();

    state.animationInterval = setInterval(() => {
        // Stop at end of selected range
        if (state.currentIndex >= state.rangeEnd) {
            stopAnimation();
            return;
        }

        state.currentIndex++;
        updateAnimationFrame();
    }, 100); // 100ms per step
}

function stopAnimation() {
    state.isPlaying = false;
    document.getElementById('play-btn')?.classList.remove('playing');

    if (state.animationInterval) {
        clearInterval(state.animationInterval);
        state.animationInterval = null;
    }

    // When animation stops, show the full selected range again
    updateVisualization();
}

// Update display during animation (shows single timepoint)
function updateAnimationFrame() {
    const tp = state.timepoints[state.currentIndex];
    if (!tp) return;

    // Show only sightings at current animation frame
    updateDeckLayers(tp.sightings);

    // Update chart to show current position within selection
    if (state.chart) {
        const annotations = state.chart.options.plugins.annotation.annotations;
        // Keep selection box visible, add animation position indicator
        annotations.selectionBox.xMin = state.rangeStart - 0.4;
        annotations.selectionBox.xMax = state.rangeEnd + 0.4;

        // Add or update animation line
        if (!annotations.animationLine) {
            annotations.animationLine = {
                type: 'line',
                xMin: state.currentIndex,
                xMax: state.currentIndex,
                borderColor: '#000000',
                borderWidth: 2,
                z: 10
            };
        } else {
            annotations.animationLine.xMin = state.currentIndex;
            annotations.animationLine.xMax = state.currentIndex;
        }
        state.chart.update('none');
    }

    // Update info panel for current frame
    updateAnimationInfoPanel(tp);
}

// Update info panel during animation (single timepoint)
function updateAnimationInfoPanel(timepoint) {
    const dateValue = document.getElementById('date-value');
    const adultsValue = document.getElementById('adults-value');
    const calvesValue = document.getElementById('calves-value');

    if (dateValue) {
        const dateObj = new Date(timepoint.date);
        const dateStr = dateObj.toLocaleDateString('en-AU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });
        dateValue.textContent = `${dateStr} ${timepoint.time}`;
    }

    const totalAdults = timepoint.sightings.reduce((sum, s) => sum + (s.adults || 0), 0);
    const totalCalves = timepoint.sightings.reduce((sum, s) => sum + (s.calves || 0), 0);

    if (adultsValue) {
        adultsValue.textContent = totalAdults;
    }

    if (calvesValue) {
        calvesValue.textContent = totalCalves;
    }
}
