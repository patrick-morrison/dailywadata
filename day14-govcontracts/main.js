/**
 * WA Government Contracts Sankey Diagram
 * Visualizes contract value flows: Total → Agencies → Budget Bins
 */

// ============================================
// Configuration
// ============================================

const CONFIG = {
    CSV_URL: 'TendersWARecentlyAwardedContracts2026-01-10.csv',

    // Budget bin thresholds (in dollars) - ordered Large to Micro
    BINS: [
        { name: 'Large', min: 1000000, max: Infinity, color: '#c85a3e' },
        { name: 'Medium', min: 500000, max: 1000000, color: '#4a7c94' },
        { name: 'Small', min: 100000, max: 500000, color: '#5b8a72' },
        { name: 'Micro', min: 0, max: 100000, color: '#d9c6a3' }
    ],

    // Sankey layout settings
    NODE_WIDTH: 20,
    NODE_PADDING: 14, // Increased for better spacing
    MIN_NODE_HEIGHT: 12, // Minimum height for clickability

    // Zoom settings
    ZOOM_MIN: 0.3,
    ZOOM_MAX: 3,
    ZOOM_STEP: 1.3,

    // Colors
    COLORS: {
        root: '#2d6a4f',
        agency: '#5b615c',
        link: '#4a7c94'
    }
};

// ============================================
// State
// ============================================

const state = {
    rawData: [],
    sankeyData: null,
    contracts: new Map(),
    expandedAgencies: new Set(),
    hasInitialized: false,
    zoom: null,
    currentTransform: null,
    initialTransform: null,
    popoverContracts: [],
    popoverDisplayCount: 50
};

// ============================================
// Utility Functions
// ============================================

/**
 * Parse currency string to number
 * "$ 157,185.00 " -> 157185
 */
function parseCurrency(str) {
    if (!str) return 0;
    return parseFloat(str.replace(/[$,\s]/g, '')) || 0;
}

/**
 * Format number as currency
 */
function formatCurrency(num) {
    if (num >= 1000000000) {
        return '$' + (num / 1000000000).toFixed(1) + 'B';
    }
    if (num >= 1000000) {
        return '$' + (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return '$' + Math.round(num / 1000) + 'K';
    }
    return '$' + Math.round(num);
}

/**
 * Format full currency for display
 */
function formatFullCurrency(num) {
    return new Intl.NumberFormat('en-AU', {
        style: 'currency',
        currency: 'AUD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(num);
}

/**
 * Get bin for a contract value
 */
function getBin(value) {
    for (const bin of CONFIG.BINS) {
        if (value >= bin.min && value < bin.max) {
            return bin.name;
        }
    }
    return CONFIG.BINS[CONFIG.BINS.length - 1].name;
}

/**
 * Parse CSV with quoted fields handling
 */
function parseCSV(text) {
    const lines = text.trim().split('\n');
    const headers = parseCSVLine(lines[0]);

    return lines.slice(1).map(line => {
        const values = parseCSVLine(line);
        const obj = {};
        headers.forEach((h, i) => obj[h.trim()] = (values[i] || '').trim());
        return obj;
    }).filter(row => row['Reference #']);
}

function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
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
 * Shorten agency names for display
 */
function shortenAgencyName(name) {
    const abbrevs = {
        'Department of': 'Dept.',
        'Western Australia': 'WA',
        'Western Australian': 'WA',
        'Metropolitan': 'Metro.',
        'Health Service': 'Health',
        'and Environmental Regulation': '& Env. Reg.',
        'Primary Industries and Regional Development': 'DPIRD',
        'Biodiversity, Conservation and Attractions': 'DBCA',
        'Planning, Lands and Heritage': 'DPLH',
        'Local Government, Industry Regulation and Safety': 'DLGIRS',
        'Training and Workforce Development': 'DTWD',
        'Programmed Facility Management': 'Programmed FM'
    };

    let short = name;
    Object.entries(abbrevs).forEach(([full, abbr]) => {
        short = short.replace(full, abbr);
    });

    if (short.length > 30) {
        short = short.substring(0, 27) + '...';
    }

    return short;
}

// ============================================
// Data Processing
// ============================================

/**
 * Process raw data into Sankey-compatible format
 */
function processData(rawData) {
    // Aggregate by agency
    const agencyData = new Map();
    rawData.forEach(row => {
        const agency = row['Agency'];
        const value = parseCurrency(row['Contract Value']);
        const bin = getBin(value);

        if (!agencyData.has(agency)) {
            agencyData.set(agency, {
                total: 0,
                bins: new Map(),
                contracts: []
            });
        }

        const data = agencyData.get(agency);
        data.total += value;
        data.bins.set(bin, (data.bins.get(bin) || 0) + value);
        data.contracts.push(row);
    });

    // Sort agencies by total value
    const sortedAgencies = [...agencyData.entries()]
        .sort((a, b) => b[1].total - a[1].total);

    // Calculate grand total
    const grandTotal = sortedAgencies.reduce((sum, [, data]) => sum + data.total, 0);

    // Build nodes array
    const nodes = [];
    const nodeIndex = new Map();

    // Root node (index 0)
    nodeIndex.set('__ROOT__', 0);
    nodes.push({
        id: '__ROOT__',
        name: 'All Contracts',
        fullName: 'All Contracts',
        type: 'root',
        value: grandTotal,
        color: CONFIG.COLORS.root,
        sortIndex: 0
    });

    // Agency nodes - expand all by default on first load
    if (state.expandedAgencies.size === 0 && !state.hasInitialized) {
        sortedAgencies.forEach(([name]) => {
            state.expandedAgencies.add(name);
        });
        state.hasInitialized = true;
    }

    // Agency nodes
    sortedAgencies.forEach(([name, data], agencyIndex) => {
        const idx = nodes.length;
        nodeIndex.set(name, idx);
        nodes.push({
            id: name,
            name: shortenAgencyName(name),
            fullName: name,
            type: 'agency',
            value: data.total,
            bins: data.bins,
            contracts: data.contracts,
            expanded: state.expandedAgencies.has(name),
            color: CONFIG.COLORS.agency,
            sortIndex: agencyIndex // Preserve original sort order by total value
        });
    });

    // Bin nodes - only add if there are expanded agencies
    if (state.expandedAgencies.size > 0) {
        CONFIG.BINS.forEach((bin, binIndex) => {
            const idx = nodes.length;
            nodeIndex.set(bin.name, idx);
            nodes.push({
                id: bin.name,
                name: bin.name,
                fullName: `${bin.name} Contracts`,
                type: 'bin',
                color: bin.color,
                sortIndex: binIndex // Keep bins in config order (Large, Medium, Small, Micro)
            });
        });
    }

    // Build links
    const links = [];

    // Root → Agency links
    sortedAgencies.forEach(([name, data]) => {
        links.push({
            source: nodeIndex.get('__ROOT__'),
            target: nodeIndex.get(name),
            value: data.total
        });
    });

    // Agency → Bin links (only for expanded agencies)
    sortedAgencies.forEach(([name, data]) => {
        // Only show agency → bin links if agency is expanded
        if (state.expandedAgencies.has(name)) {
            const agencyIdx = nodeIndex.get(name);
            data.bins.forEach((value, binName) => {
                if (value > 0) {
                    links.push({
                        source: agencyIdx,
                        target: nodeIndex.get(binName),
                        value: value
                    });
                }
            });
        }
    });

    // Store contracts by node for popover
    state.contracts.clear();

    // Root contracts
    state.contracts.set('__ROOT__', rawData);

    // Agency contracts
    sortedAgencies.forEach(([name, data]) => {
        state.contracts.set(name, data.contracts);
    });

    // Bin contracts
    CONFIG.BINS.forEach(bin => {
        const binContracts = rawData.filter(row => getBin(parseCurrency(row['Contract Value'])) === bin.name);
        state.contracts.set(bin.name, binContracts);
    });

    return { nodes, links, nodeIndex };
}

// ============================================
// Rendering
// ============================================

function render() {
    const container = document.getElementById('sankey-container');
    const svg = d3.select('#sankey');

    // Get dimensions
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Calculate content dimensions based on number of agencies
    const numAgencies = state.sankeyData.nodes.filter(n => n.type === 'agency').length;
    const contentHeight = Math.max(height, numAgencies * 25 + 100);
    const contentWidth = Math.max(width, 1200);

    svg.attr('width', contentWidth).attr('height', contentHeight);

    // Clear previous content
    svg.selectAll('*').remove();

    // Create zoom group
    const g = svg.append('g').attr('class', 'zoom-group');

    // Margins for labels
    const margin = { top: 40, right: 120, bottom: 40, left: 40 };

    // Create Sankey layout with custom sort to maintain consistent order
    const sankey = d3.sankey()
        .nodeWidth(CONFIG.NODE_WIDTH)
        .nodePadding(CONFIG.NODE_PADDING)
        .nodeAlign(d3.sankeyLeft)
        .nodeSort((a, b) => {
            // Keep nodes in their original order using sortIndex
            // This ensures agencies stay sorted by total value regardless of expand state
            if (a.type === b.type) {
                return a.sortIndex - b.sortIndex;
            }
            // Different types: root first, then agencies, then bins
            const typeOrder = { root: 0, agency: 1, bin: 2 };
            return typeOrder[a.type] - typeOrder[b.type];
        })
        .extent([
            [margin.left, margin.top],
            [contentWidth - margin.right, contentHeight - margin.bottom]
        ]);

    // Apply layout
    const { nodes, links } = sankey({
        nodes: state.sankeyData.nodes.map(d => Object.assign({}, d)),
        links: state.sankeyData.links.map(d => Object.assign({}, d))
    });

    // Create gradient definitions
    const defs = svg.append('defs');

    links.forEach((link, i) => {
        const gradient = defs.append('linearGradient')
            .attr('id', `gradient-${i}`)
            .attr('gradientUnits', 'userSpaceOnUse')
            .attr('x1', link.source.x1)
            .attr('x2', link.target.x0);

        const sourceColor = link.source.color || CONFIG.COLORS.agency;
        const targetColor = link.target.color || CONFIG.COLORS.link;

        gradient.append('stop')
            .attr('offset', '0%')
            .attr('stop-color', sourceColor);

        gradient.append('stop')
            .attr('offset', '100%')
            .attr('stop-color', targetColor);
    });

    // Draw links
    const linkGroup = g.append('g').attr('class', 'links');

    linkGroup.selectAll('path')
        .data(links)
        .join('path')
        .attr('class', 'link')
        .attr('d', d3.sankeyLinkHorizontal())
        .attr('stroke', (d, i) => `url(#gradient-${i})`)
        .attr('stroke-width', d => Math.max(1, d.width))
        .attr('fill', 'none')
        .on('mouseenter', function() {
            d3.select(this).attr('stroke-opacity', 0.6);
        })
        .on('mouseleave', function() {
            d3.select(this).attr('stroke-opacity', 0.3);
        });

    // Draw nodes
    const nodeGroup = g.append('g').attr('class', 'nodes');

    const nodeRects = nodeGroup.selectAll('g')
        .data(nodes)
        .join('g')
        .attr('class', d => `node ${d.type}`)
        .attr('transform', d => `translate(${d.x0},${d.y0})`);

    nodeRects.append('rect')
        .attr('width', d => d.x1 - d.x0)
        .attr('height', d => Math.max(CONFIG.MIN_NODE_HEIGHT, d.y1 - d.y0))
        .attr('y', d => {
            // Center the minimum-height rect within the original bounds
            const actualHeight = d.y1 - d.y0;
            if (actualHeight < CONFIG.MIN_NODE_HEIGHT) {
                return -(CONFIG.MIN_NODE_HEIGHT - actualHeight) / 2;
            }
            return 0;
        })
        .attr('fill', d => d.color)
        .attr('rx', 2)
        .attr('cursor', d => d.type === 'agency' ? 'pointer' : 'default')
        .on('click', handleNodeClick);

    // Draw labels
    const labelGroup = g.append('g').attr('class', 'labels');

    // Root label (left side)
    nodes.filter(d => d.type === 'root').forEach(d => {
        labelGroup.append('text')
            .attr('class', 'node-label root')
            .attr('x', d.x0 - 8)
            .attr('y', (d.y0 + d.y1) / 2)
            .attr('dy', '0.35em')
            .attr('text-anchor', 'end')
            .text(`${d.name} (${formatCurrency(d.value)})`);
    });

    // Agency labels (right of node)
    nodes.filter(d => d.type === 'agency').forEach(d => {
        const labelX = d.x1 + 6;
        const labelY = (d.y0 + d.y1) / 2;

        // Expand indicator
        labelGroup.append('text')
            .attr('class', 'expand-indicator')
            .attr('x', labelX)
            .attr('y', labelY)
            .attr('dy', '0.35em')
            .text(state.expandedAgencies.has(d.fullName) ? '▼' : '▶');

        // Agency name
        labelGroup.append('text')
            .attr('class', 'node-label')
            .attr('x', labelX + 12)
            .attr('y', labelY)
            .attr('dy', '0.35em')
            .text(d.name);
    });

    // Bin labels (right side)
    nodes.filter(d => d.type === 'bin').forEach(d => {
        labelGroup.append('text')
            .attr('class', 'node-label bin')
            .attr('x', d.x1 + 8)
            .attr('y', (d.y0 + d.y1) / 2)
            .attr('dy', '0.35em')
            .text(d.name);
    });

    // Setup zoom
    setupZoom(svg, g, width, height, contentWidth, contentHeight);
}

function handleNodeClick(event, node) {
    event.stopPropagation();

    if (node.type === 'agency') {
        // Toggle expand/collapse
        if (state.expandedAgencies.has(node.fullName)) {
            state.expandedAgencies.delete(node.fullName);
        } else {
            state.expandedAgencies.add(node.fullName);
        }
        // Re-process data and re-render
        state.sankeyData = processData(state.rawData);
        render();
        return; // Don't show popover on expand/collapse
    }

    // Show popover for root and bin nodes
    let contracts = state.contracts.get(node.id || node.fullName) || [];

    // Filter to only show contracts from expanded agencies
    if (node.type === 'root' || node.type === 'bin') {
        contracts = contracts.filter(c => state.expandedAgencies.has(c['Agency']));
    }

    showPopover(node, contracts);
}

// ============================================
// Selection Controls
// ============================================

function showAllAgencies() {
    // Get all agency names from the data
    const agencies = new Set(state.rawData.map(row => row['Agency']));
    agencies.forEach(name => state.expandedAgencies.add(name));
    state.sankeyData = processData(state.rawData);
    render();
}

function hideAllAgencies() {
    state.expandedAgencies.clear();
    state.sankeyData = processData(state.rawData);
    render();
}

function invertSelection() {
    // Get all agency names
    const allAgencies = new Set(state.rawData.map(row => row['Agency']));

    // Toggle each agency
    allAgencies.forEach(name => {
        if (state.expandedAgencies.has(name)) {
            state.expandedAgencies.delete(name);
        } else {
            state.expandedAgencies.add(name);
        }
    });

    state.sankeyData = processData(state.rawData);
    render();
}

// ============================================
// Zoom
// ============================================

function setupZoom(svg, g, viewWidth, viewHeight, contentWidth, contentHeight) {
    // Calculate initial transform
    const scale = Math.min(
        viewWidth / contentWidth,
        viewHeight / contentHeight,
        1
    ) * 0.95;

    const tx = (viewWidth - contentWidth * scale) / 2;
    const ty = (viewHeight - contentHeight * scale) / 2;

    state.initialTransform = d3.zoomIdentity.translate(tx, ty).scale(scale);

    // Only create zoom behavior once
    if (!state.zoom) {
        state.zoom = d3.zoom()
            .scaleExtent([CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX])
            .on('zoom', (event) => {
                // Always select the current zoom-group (it gets recreated on re-render)
                d3.select('#sankey .zoom-group').attr('transform', event.transform);
                state.currentTransform = event.transform;
            });

        // Zoom control buttons (only attach once)
        document.getElementById('zoom-in').addEventListener('click', () => {
            d3.select('#sankey').transition().duration(300).call(
                state.zoom.scaleBy, CONFIG.ZOOM_STEP
            );
        });

        document.getElementById('zoom-out').addEventListener('click', () => {
            d3.select('#sankey').transition().duration(300).call(
                state.zoom.scaleBy, 1 / CONFIG.ZOOM_STEP
            );
        });

        document.getElementById('zoom-reset').addEventListener('click', () => {
            d3.select('#sankey').transition().duration(300).call(
                state.zoom.transform, state.initialTransform
            );
        });
    }

    svg.call(state.zoom);

    // Restore previous transform or use initial
    const zoomGroup = d3.select('#sankey .zoom-group');
    if (state.currentTransform) {
        svg.call(state.zoom.transform, state.currentTransform);
        zoomGroup.attr('transform', state.currentTransform);
    } else {
        svg.call(state.zoom.transform, state.initialTransform);
        state.currentTransform = state.initialTransform;
    }
}

// ============================================
// Popover
// ============================================

function showPopover(node, contracts) {
    const popover = document.getElementById('popover');
    const title = document.getElementById('popover-title');
    const stats = document.getElementById('popover-stats');
    const content = document.getElementById('popover-content');

    // Ensure backdrop exists
    let backdrop = document.querySelector('.popover-backdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = 'popover-backdrop';
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', hidePopover);
    }

    title.textContent = node.fullName || node.name;

    // Calculate stats
    const totalValue = contracts.reduce((sum, c) => sum + parseCurrency(c['Contract Value']), 0);

    stats.innerHTML = `
        <div class="stat-item">
            <span class="stat-value">${contracts.length.toLocaleString()}</span>
            <span class="stat-label">Contracts</span>
        </div>
        <div class="stat-item">
            <span class="stat-value">${formatCurrency(totalValue)}</span>
            <span class="stat-label">Total Value</span>
        </div>
    `;

    // Sort contracts by value
    const sortedContracts = [...contracts].sort((a, b) =>
        parseCurrency(b['Contract Value']) - parseCurrency(a['Contract Value'])
    );

    // Store for "show more" functionality
    state.popoverContracts = sortedContracts;
    state.popoverDisplayCount = 50;

    // Render contract list
    renderContractList(content, sortedContracts, state.popoverDisplayCount);

    backdrop.classList.add('visible');
    popover.classList.remove('hidden');
}

function renderContractList(container, contracts, displayCount) {
    const remaining = contracts.length - displayCount;

    container.innerHTML = `
        <div class="contract-list">
            ${contracts.slice(0, displayCount).map(c => `
                <div class="contract-item">
                    <div class="contract-title">${escapeHtml(c['Title'])}</div>
                    <div class="contract-meta">
                        <span class="contract-agency">${escapeHtml(c['Agency'])}</span>
                        <span class="contract-value">${c['Contract Value']}</span>
                    </div>
                    <div class="contract-ref">${escapeHtml(c['Reference #'])}</div>
                </div>
            `).join('')}
            ${remaining > 0 ? `
                <button class="more-contracts-btn" onclick="showMoreContracts()">
                    Show ${Math.min(remaining, 50)} more contracts (${remaining.toLocaleString()} remaining)
                </button>
            ` : ''}
        </div>
    `;
}

function showMoreContracts() {
    state.popoverDisplayCount += 50;
    const content = document.getElementById('popover-content');
    renderContractList(content, state.popoverContracts, state.popoverDisplayCount);
}

function hidePopover() {
    const popover = document.getElementById('popover');
    const backdrop = document.querySelector('.popover-backdrop');

    popover.classList.add('hidden');
    if (backdrop) {
        backdrop.classList.remove('visible');
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ============================================
// Stats
// ============================================

function updateStats() {
    const totalValue = state.rawData.reduce((sum, row) =>
        sum + parseCurrency(row['Contract Value']), 0);

    document.getElementById('total-value').textContent = formatCurrency(totalValue);
    document.getElementById('total-contracts').textContent = state.rawData.length.toLocaleString();
}

// ============================================
// Initialization
// ============================================

async function init() {
    try {
        // Load data
        const response = await fetch(CONFIG.CSV_URL);
        if (!response.ok) throw new Error('Failed to load CSV');

        const text = await response.text();
        state.rawData = parseCSV(text);

        // Process for Sankey
        state.sankeyData = processData(state.rawData);

        // Update stats
        updateStats();

        // Render
        render();

        // Hide loading
        document.getElementById('loading').classList.add('hidden');

        // Setup event listeners
        document.getElementById('popover-close').addEventListener('click', hidePopover);
        document.getElementById('show-all-btn').addEventListener('click', showAllAgencies);
        document.getElementById('hide-all-btn').addEventListener('click', hideAllAgencies);
        document.getElementById('invert-btn').addEventListener('click', invertSelection);

        // Handle window resize
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(render, 250);
        });

        // Close popover on escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') hidePopover();
        });

    } catch (error) {
        console.error('Failed to load data:', error);
        document.querySelector('.loading-text').textContent = 'Failed to load data';
    }
}

// Start
init();
