/**
 * WA Birdsong Archive
 * Randomly displays birdsong recordings from the SLWA collection
 */

let csvData = [];

/**
 * Parse CSV data
 */
function parseCSV(text) {
    const lines = text.split('\n');
    const headers = lines[0].split(',');
    const data = [];

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;

        // Simple CSV parsing - handles basic cases
        // For a production app, you'd want a more robust parser
        const values = parseCSVLine(lines[i]);

        if (values.length === headers.length) {
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index];
            });
            data.push(row);
        }
    }

    return data;
}

/**
 * Parse a single CSV line, handling quoted fields
 */
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                // Escaped quote
                current += '"';
                i++;
            } else {
                // Toggle quote state
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            // Field separator
            values.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    values.push(current);
    return values;
}

/**
 * Get a random recording from the dataset
 */
function getRandomRecording() {
    return csvData[Math.floor(Math.random() * csvData.length)];
}

/**
 * Display a recording
 */
function displayRecording(recording) {
    const content = document.getElementById('content');

    // Parse subject headings into individual tags
    const subjects = recording['Subject headings: Topical']
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

    content.innerHTML = `
        <div class="recording-info">
            <div class="date">${recording['Date']}</div>

            <div class="summary">${recording['Summary']}</div>

            <div class="subjects">
                <span class="subjects-label">Subject Headings</span>
                <div class="subject-tags">
                    ${subjects.map(subject => `<span class="subject-tag">${subject}</span>`).join('')}
                </div>
            </div>

            <div class="audio-section">
                <audio controls preload="metadata">
                    <source src="${recording['URL']}" type="audio/mpeg">
                    Your browser does not support the audio element.
                </audio>
                <a href="${recording['URL']}" target="_blank" class="audio-link">Open recording in new tab →</a>
            </div>
        </div>
    `;
}

/**
 * Load and display a random recording
 */
function loadRandomRecording() {
    if (csvData.length === 0) {
        console.error('No data loaded');
        return;
    }

    const recording = getRandomRecording();
    displayRecording(recording);
}

/**
 * Initialize the application
 */
async function init() {
    try {
        // Load CSV data
        const response = await fetch('birdsongonlinefinal2021.csv');
        const text = await response.text();
        csvData = parseCSV(text);

        console.log(`Loaded ${csvData.length} recordings`);

        // Display initial random recording
        loadRandomRecording();

        // Set up shuffle button
        const shuffleBtn = document.getElementById('shuffle-btn');
        shuffleBtn.addEventListener('click', loadRandomRecording);
    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('content').innerHTML = `
            <div class="loading" style="color: #c00;">
                Error loading recordings. Please check the console for details.
            </div>
        `;
    }
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
