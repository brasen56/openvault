// @ts-check
/**
 * Graph Visualization Module
 *
 * Renders the entity-relationship graph as an interactive force-directed
 * layout inside the side panel's "Graph" tab.
 *
 * Architecture:
 * - Pure SVG rendering (no third-party library)
 * - Force simulation: repulsion between all nodes, attraction along edges
 * - Interactive: drag nodes, zoom/pan canvas, hover for tooltips, click for details
 * - Filterable: search by name/alias, filter by entity type
 * - Responsive: auto-resizes to container
 * - Performance: skips simulation when tab is hidden; caps at ~200 nodes
 */

import { getOpenVaultData } from '../store/chat-data.js';
import { escapeHtml } from '../utils/dom.js';

// =============================================================================
// Physics & Layout Constants
// =============================================================================

const REPULSION = 600;
const ATTRACTION = 0.003;
const DAMPING = 0.65;
const MIN_VELOCITY = 0.15;
const MAX_SIMULATION_TIME = 8000;
const MAX_NODES = 200;
const _NODE_RADIUS = 12;
const LABEL_MAX_LENGTH = 14;
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.25;

/** @type {{x: number, y: number, vx: number, vy: number, key: string, label: string, type: string, radius: number, fx: number|null, fy: number|null}[]} */
let nodes = [];
/** @type {{source: number, target: number, weight: number}[]} */
let edges = [];
/** @type {Map<string, number>} */
let nodeIndexMap = new Map();

let _simRunning = false;
let _animationId = null;
let _containerWidth = 400;
let _containerHeight = 400;
let _dragging = null;
let _dragOffsetX = 0;
let _dragOffsetY = 0;
let _hoveredIndex = -1;
let _selectedIndex = -1;
let _lastRenderTime = 0;
let _simulationStartTime = 0;

// View transform (zoom + pan)
let _scale = 1;
let _panX = 0;
let _panY = 0;

// Panning state (background drag)
let _panning = false;
let _panStartX = 0;
let _panStartY = 0;
let _panStartPanX = 0;
let _panStartPanY = 0;

// Filter state
let _searchQuery = '';
let _typeFilter = '';

// Event binding guard
let _eventsBound = false;

// =============================================================================
// Public API
// =============================================================================

/**
 * Render the graph visualization into the side panel container.
 */
export function renderGraphViz() {
    const $container = $('#openvault_side_graph');
    if (!$container.length || !$container.is(':visible')) {
        stopSimulation();
        return;
    }

    const data = getOpenVaultData();
    if (!data?.graph) {
        $container.html('<p class="openvault-side-placeholder">No chat loaded</p>');
        $('#openvault_graph_legend').empty();
        hideDetails();
        stopSimulation();
        return;
    }

    const graph = data.graph;
    const nodeEntries = Object.entries(graph.nodes || {});

    if (nodeEntries.length === 0) {
        $container.html('<p class="openvault-side-placeholder">No entities extracted yet</p>');
        $('#openvault_graph_legend').empty();
        hideDetails();
        stopSimulation();
        return;
    }

    // Cap nodes to prevent performance issues
    const capped = nodeEntries.slice(0, MAX_NODES);

    // Build layout data
    buildLayout(capped, graph.edges || {});

    // Update container dimensions
    _containerWidth = $container.width() || 400;
    _containerHeight = $container.height() || 400;

    // Render legend with type counts
    renderLegend();

    // Render search/type filter current values (in case tab was just opened)
    syncFilterControls();

    // Start simulation
    _simulationStartTime = performance.now();
    startSimulation();
}

/**
 * Stop the simulation and release resources.
 */
export function stopSimulation() {
    _simRunning = false;
    if (_animationId) {
        cancelAnimationFrame(_animationId);
        _animationId = null;
    }
    nodes = [];
    edges = [];
    nodeIndexMap = new Map();
    _dragging = null;
    _hoveredIndex = -1;
    _selectedIndex = -1;
}

/**
 * Handle window/drawer resize.
 */
export function handleGraphResize() {
    const $container = $('#openvault_side_graph');
    if ($container.length && $container.is(':visible')) {
        const newW = $container.width() || 400;
        const newH = $container.height() || 400;
        if (Math.abs(newW - _containerWidth) > 10 || Math.abs(newH - _containerHeight) > 10) {
            _containerWidth = newW;
            _containerHeight = newH;
            // Reset node positions to center after resize
            placeNodesRandom();
            resetView();
        }
    }
}

// =============================================================================
// Layout Construction
// =============================================================================

/**
 * Build node and edge arrays from graph data.
 * @param {[string, any][]} nodeEntries
 * @param {Object<string, any>} rawEdges
 */
function buildLayout(nodeEntries, rawEdges) {
    const edgeEntries = Object.entries(rawEdges);

    // Map node keys to indices
    nodeIndexMap = new Map();
    nodeEntries.forEach(([key], i) => nodeIndexMap.set(key, i));

    // Build nodes
    nodes = nodeEntries.map(([key, node]) => ({
        key,
        label: truncateLabel(node.name || key),
        type: node.type || 'CONCEPT',
        radius: getNodeRadius(node.type, node.mentions || 1),
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
    }));

    // Build edges (only between visible nodes)
    edges = [];
    for (const [_, edge] of edgeEntries) {
        const si = nodeIndexMap.get(edge.source);
        const ti = nodeIndexMap.get(edge.target);
        if (si !== undefined && ti !== undefined) {
            edges.push({ source: si, target: ti, weight: edge.weight || 1 });
        }
    }

    placeNodesRandom();
}

/**
 * Place nodes in a circle initially.
 */
function placeNodesRandom() {
    const cx = _containerWidth / 2;
    const cy = _containerHeight / 2;
    const radius = Math.min(cx, cy) * 0.7;

    nodes.forEach((n, i) => {
        const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
        n.x = cx + radius * Math.cos(angle) * (0.5 + 0.5 * Math.random());
        n.y = cy + radius * Math.sin(angle) * (0.5 + 0.5 * Math.random());
        n.vx = 0;
        n.vy = 0;
    });
}

// =============================================================================
// View Transform (Zoom & Pan)
// =============================================================================

/**
 * Convert screen (client) coordinates to graph (world) coordinates.
 * @param {number} clientX
 * @param {number} clientY
 * @param {Element} svg - The SVG element (or any element with getBoundingClientRect)
 * @returns {{x: number, y: number}}
 */
function screenToGraph(clientX, clientY, svg) {
    const rect = svg.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
        x: (sx - _panX) / _scale,
        y: (sy - _panY) / _scale,
    };
}

/**
 * Zoom around a given graph-space focal point.
 * @param {number} deltaScale - Scale multiplier to apply
 * @param {number} [focusX] - Graph-space x to zoom toward (defaults to center)
 * @param {number} [focusY] - Graph-space y to zoom toward
 */
function zoomAt(deltaScale, focusX, focusY) {
    const cx = focusX ?? _containerWidth / 2;
    const cy = focusY ?? _containerHeight / 2;

    // Convert focus to graph coords before zoom
    const gx = (cx - _panX) / _scale;
    const gy = (cy - _panY) / _scale;

    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, _scale * deltaScale));

    // Adjust pan so the graph point under the cursor stays put
    _panX = cx - gx * newScale;
    _panY = cy - gy * newScale;
    _scale = newScale;

    renderFrame();
}

/**
 * Reset zoom and pan to default.
 */
function resetView() {
    _scale = 1;
    _panX = 0;
    _panY = 0;
    _selectedIndex = -1;
    hideDetails();
    renderFrame();
}

// =============================================================================
// Force Simulation
// =============================================================================

function startSimulation() {
    if (_simRunning) return;
    _simRunning = true;
    requestAnimationFrame(simulateStep);
}

function simulateStep() {
    if (!_simRunning) return;

    // Hard-stop simulation after max time to guarantee settling
    if (performance.now() - _simulationStartTime > MAX_SIMULATION_TIME && !_dragging) {
        _simRunning = false;
        _animationId = null;
        renderFrame();
        return;
    }

    // Apply forces
    applyRepulsion();
    applyAttraction();
    applyCenterGravity();

    // Update positions
    let totalVelocity = 0;
    for (const n of nodes) {
        if (n.fx !== null) {
            n.x = n.fx;
            n.y = n.fy;
            n.vx = 0;
            n.vy = 0;
            continue;
        }
        n.x += n.vx;
        n.y += n.vy;
        n.vx *= DAMPING;
        n.vy *= DAMPING;

        // Clamp to bounds (generous — graph can extend beyond visible area,
        // user pans/zooms to explore)
        n.x = Math.max(n.radius, Math.min(_containerWidth * 2, n.x));
        n.y = Math.max(n.radius, Math.min(_containerHeight * 2, n.y));

        totalVelocity += Math.abs(n.vx) + Math.abs(n.vy);
    }

    // Render
    renderFrame();

    // Continue simulation if there's still energy or we're dragging
    const avgVelocity = totalVelocity / Math.max(1, nodes.length);
    if (avgVelocity > MIN_VELOCITY || _dragging) {
        _animationId = requestAnimationFrame(simulateStep);
    } else {
        _simRunning = false;
        _animationId = null;
    }
}

function applyRepulsion() {
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[i].x - nodes[j].x;
            const dy = nodes[i].y - nodes[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = REPULSION / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            nodes[i].vx += fx;
            nodes[i].vy += fy;
            nodes[j].vx -= fx;
            nodes[j].vy -= fy;
        }
    }
}

function applyAttraction() {
    for (const e of edges) {
        const s = nodes[e.source];
        const t = nodes[e.target];
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * ATTRACTION * Math.sqrt(e.weight);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        s.vx += fx;
        s.vy += fy;
        t.vx -= fx;
        t.vy -= fy;
    }
}

function applyCenterGravity() {
    const cx = _containerWidth / 2;
    const cy = _containerHeight / 2;
    const gravityStrength = 0.003;
    for (const n of nodes) {
        if (n.fx !== null) continue;
        n.vx += (cx - n.x) * gravityStrength;
        n.vy += (cy - n.y) * gravityStrength;
    }
}

// =============================================================================
// Filtering
// =============================================================================

/**
 * Determine whether a node matches the current search + type filters.
 * @param {{key: string, label: string, type: string}} node
 * @returns {{visible: boolean, highlighted: boolean}}
 */
function getNodeFilterState(node) {
    const data = getOpenVaultData();
    const entity = data?.graph?.nodes?.[node.key];

    let visible = true;
    if (_typeFilter && node.type !== _typeFilter) visible = false;

    let highlighted = false;
    if (_searchQuery) {
        const q = _searchQuery.toLowerCase();
        const name = (entity?.name || node.label || '').toLowerCase();
        const aliases = (entity?.aliases || []).map((a) => a.toLowerCase());
        highlighted = name.includes(q) || aliases.some((a) => a.includes(q));
        // When searching, hide non-matching nodes to reduce clutter
        if (!highlighted) visible = false;
    }

    return { visible, highlighted };
}

// =============================================================================
// SVG Rendering
// =============================================================================

function renderFrame() {
    const now = performance.now();
    if (now - _lastRenderTime < 16) return; // Cap at ~60fps
    _lastRenderTime = now;

    const $container = $('#openvault_side_graph');
    if (!$container.length) return;

    // Pre-compute filter state per node for rendering decisions
    const filterStates = nodes.map((n) => getNodeFilterState(n));
    const anyFilterActive = _searchQuery !== '' || _typeFilter !== '';

    // Build SVG string directly (faster than DOM manipulation for small graphs)
    let svg = `<svg width="${_containerWidth}" height="${_containerHeight}" class="openvault-graph-svg" viewBox="0 0 ${_containerWidth} ${_containerHeight}">`;

    // A group that applies the zoom/pan transform to all graph content
    svg += `<g class="openvault-graph-viewport" transform="translate(${_panX},${_panY}) scale(${_scale})">`;

    // Defs for arrow markers
    svg += `
        <defs>
            <marker id="ov-graph-arrow" viewBox="0 0 10 10" refX="10" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--SmartThemeBorderColor, #555)" />
            </marker>
        </defs>
    `;

    // Edge lines
    for (const e of edges) {
        const s = nodes[e.source];
        const t = nodes[e.target];
        const sFiltered = anyFilterActive && !filterStates[e.source].visible;
        const tFiltered = anyFilterActive && !filterStates[e.target].visible;
        // Hide edge if either endpoint is filtered out
        if (sFiltered || tFiltered) continue;

        const sw = Math.min(3, 0.5 + e.weight * 0.5);
        const opacity = 0.3 + Math.min(0.5, e.weight * 0.1);
        const isSelectedEdge = _selectedIndex >= 0 && (e.source === _selectedIndex || e.target === _selectedIndex);
        const strokeColor = isSelectedEdge ? 'var(--SmartThemeEmColor, #48c)' : 'var(--SmartThemeBorderColor, #555)';
        svg += `
            <line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}"
                stroke="${strokeColor}" stroke-width="${sw}" opacity="${isSelectedEdge ? 1 : opacity}"
                marker-end="url(#ov-graph-arrow)" />
        `;
    }

    // Decide label visibility: always show when zoomed in enough, when few
    // nodes, or when a filter is active (so the user can see what matched).
    const showAllLabels =
        nodes.length <= 50 || _scale > 1.6 || (anyFilterActive && filterStates.filter((f) => f.visible).length <= 50);

    // Node circles and labels
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const fs = filterStates[i];

        // Skip rendering filtered-out nodes entirely
        if (anyFilterActive && !fs.visible) continue;

        const isHovered = i === _hoveredIndex;
        const isSelected = i === _selectedIndex;
        const isHighlighted = fs.highlighted;
        const fillColor = getNodeColor(n.type, isSelected, isHovered || isHighlighted);
        const strokeWidth = isSelected ? 3 : isHovered || isHighlighted ? 2.5 : 1;
        const r = isHovered || isHighlighted ? n.radius + 3 : n.radius;

        // Highlight ring for search matches
        let highlightRing = '';
        if (isHighlighted && !isSelected) {
            highlightRing = `<circle cx="${n.x}" cy="${n.y}" r="${r + 5}" fill="none"
                stroke="#ffd93d" stroke-width="2" opacity="0.7" />`;
        }

        svg += `
            ${highlightRing}
            <g class="openvault-graph-node" data-index="${i}">
                <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${fillColor}"
                    stroke="var(--SmartThemeEmColor, #48c)" stroke-width="${strokeWidth}"
                    opacity="${isSelected || isHovered || isHighlighted ? 1 : 0.85}" />
        `;

        // Label
        if (showAllLabels || isHovered || isSelected || isHighlighted) {
            const fontSize = isHovered || isSelected ? '12px' : '10px';
            svg += `
                <text x="${n.x}" y="${n.y + n.radius + 13}" text-anchor="middle"
                    fill="var(--SmartThemeBodyColor, #ccc)" font-size="${fontSize}"
                    font-family="sans-serif" pointer-events="none">${escapeHtml(n.label)}</text>
            `;
        }

        svg += '</g>';
    }

    svg += '</g></svg>';

    // Update DOM
    $container.html(svg);

    // Bind events after first render
    bindGraphEvents();
}

// =============================================================================
// Legend & Details Panel
// =============================================================================

/**
 * Render the entity-type color legend with counts.
 */
function renderLegend() {
    const $legend = $('#openvault_graph_legend');
    if (!$legend.length) return;

    const typeCounts = {};
    for (const n of nodes) {
        typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
    }

    const types = Object.keys(typeCounts).sort();
    const items = types
        .map((type) => {
            const color = getTypeColor(type);
            return `<span class="openvault-graph-legend-item">
                <span class="openvault-graph-legend-dot" style="background:${color};"></span>
                ${escapeHtml(type.charAt(0) + type.slice(1).toLowerCase())} (${typeCounts[type]})
            </span>`;
        })
        .join('');

    const totalInGraph = Object.keys(getOpenVaultData()?.graph?.nodes || {}).length;
    const cappedNote = totalInGraph > MAX_NODES ? ` (showing first ${MAX_NODES} of ${totalInGraph})` : '';

    $legend.html(
        `${items}${totalInGraph > MAX_NODES ? `<span class="openvault-graph-legend-item" style="opacity:0.6;margin-left:auto;">${cappedNote}</span>` : ''}`
    );
}

/**
 * Show the details panel for a selected node.
 * @param {number} index
 */
function showDetails(index) {
    const $details = $('#openvault_graph_details');
    if (!$details.length || index < 0 || index >= nodes.length) {
        hideDetails();
        return;
    }

    const node = nodes[index];
    const data = getOpenVaultData();
    const entity = data?.graph?.nodes?.[node.key];
    if (!entity) {
        hideDetails();
        return;
    }

    const typeLabel = (entity.type || 'CONCEPT').charAt(0) + (entity.type || 'CONCEPT').slice(1).toLowerCase();
    const aliasesText =
        entity.aliases?.length > 0
            ? `<div class="openvault-graph-details-aliases">Also known as: ${escapeHtml(entity.aliases.join(', '))}</div>`
            : '';
    const desc = entity.description || 'No description';

    // Find connected edges
    const graph = data.graph;
    const connectedEdges = [];
    for (const [_, edge] of Object.entries(graph.edges || {})) {
        if (edge.source === node.key || edge.target === node.key) {
            const otherKey = edge.source === node.key ? edge.target : edge.source;
            const otherEntity = graph.nodes?.[otherKey];
            const direction = edge.source === node.key ? '→' : '←';
            connectedEdges.push({
                direction,
                name: otherEntity?.name || otherKey,
                type: otherEntity?.type || 'CONCEPT',
                desc: edge.description || '',
                weight: edge.weight || 1,
            });
        }
    }

    // Sort connected edges by weight desc
    connectedEdges.sort((a, b) => b.weight - a.weight);

    const edgesHtml =
        connectedEdges.length > 0
            ? connectedEdges
                  .slice(0, 8)
                  .map(
                      (e) => `
            <div class="openvault-graph-details-edge">
                <span class="openvault-graph-details-edge-target">${escapeHtml(e.direction)} ${escapeHtml(e.name)}</span>
                ${e.desc ? `<span class="openvault-graph-details-edge-desc">— ${escapeHtml(e.desc.length > 80 ? e.desc.slice(0, 80) + '…' : e.desc)}</span>` : ''}
            </div>
        `
                  )
                  .join('')
            : '<div class="openvault-graph-details-edge" style="opacity:0.6;">No connections</div>';

    const moreEdges =
        connectedEdges.length > 8
            ? `<div style="font-size:0.78em;opacity:0.6;margin-top:4px;">+${connectedEdges.length - 8} more</div>`
            : '';

    $details.html(`
        <div class="openvault-graph-details-header">
            <span class="openvault-graph-details-name">${escapeHtml(entity.name || node.key)}</span>
            <span class="openvault-graph-details-type">${escapeHtml(typeLabel)}</span>
            <button class="openvault-graph-details-close" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="openvault-graph-details-desc">${escapeHtml(desc)}</div>
        ${aliasesText}
        <div class="openvault-graph-details-meta">
            <span><i class="fa-solid fa-comment"></i> ${entity.mentions || 0} mentions</span>
            <span><i class="fa-solid fa-link"></i> ${connectedEdges.length} connections</span>
        </div>
        <div class="openvault-graph-details-edges">
            <div class="openvault-graph-details-edges-title">Connections</div>
            ${edgesHtml}
            ${moreEdges}
        </div>
    `);
    $details.addClass('open');
}

function hideDetails() {
    const $details = $('#openvault_graph_details');
    if ($details.length) {
        $details.removeClass('open');
        $details.empty();
    }
}

// =============================================================================
// Interaction
// =============================================================================

function bindGraphEvents() {
    if (_eventsBound) return;
    _eventsBound = true;

    // Bind on the panel so it persists across re-renders of the SVG
    const $panel = $('#openvault_side_panel');

    // -------------------------------------------------------------------------
    // Graph canvas events
    // -------------------------------------------------------------------------

    // Mouse move: hover detection + pan + drag
    $panel.on('mousemove', '#openvault_side_graph', function (e) {
        const $svg = $(this).find('.openvault-graph-svg');
        if (!$svg.length) return;
        const svg = $svg[0];

        const gpt = screenToGraph(e.clientX, e.clientY, svg);

        // Background panning
        if (_panning) {
            _panX = _panStartPanX + (e.clientX - _panStartX);
            _panY = _panStartPanY + (e.clientY - _panStartY);
            renderFrame();
            return;
        }

        // Node dragging
        if (_dragging !== null) {
            const n = nodes[_dragging];
            n.fx = gpt.x - _dragOffsetX;
            n.fy = gpt.y - _dragOffsetY;
            n.x = n.fx;
            n.y = n.fy;
            n.vx = 0;
            n.vy = 0;
            renderFrame();
            return;
        }

        // Hover detection — hit test all nodes (reverse order for z-index)
        let found = -1;
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            const dx = gpt.x - n.x;
            const dy = gpt.y - n.y;
            // Generous hit radius for easier selection (scales with zoom so
            // zoomed-out dots are still clickable)
            const hitR = (n.radius + 6) / _scale;
            if (dx * dx + dy * dy <= hitR * hitR) {
                found = i;
                break;
            }
        }

        if (found !== _hoveredIndex) {
            _hoveredIndex = found;
            $svg.css('cursor', found >= 0 ? 'pointer' : _panning ? 'grabbing' : 'grab');
            renderFrame();
        }
    });

    // Track mousedown position to distinguish clicks from drags/pans
    let _mouseDownPos = null;

    // Mouse down: start drag (node) or pan (background)
    $panel.on('mousedown', '#openvault_side_graph', function (e) {
        _mouseDownPos = { x: e.clientX, y: e.clientY };
        const $svg = $(this).find('.openvault-graph-svg');
        if (!$svg.length) return;
        const svg = $svg[0];
        const gpt = screenToGraph(e.clientX, e.clientY, svg);

        if (_hoveredIndex >= 0) {
            // Start dragging a node
            e.preventDefault();
            _dragging = _hoveredIndex;
            _selectedIndex = _hoveredIndex;
            showDetails(_selectedIndex);

            const n = nodes[_dragging];
            _dragOffsetX = gpt.x - n.x;
            _dragOffsetY = gpt.y - n.y;

            if (!_simRunning) startSimulation();
            renderFrame();
        } else {
            // Start panning the background
            _panning = true;
            _panStartX = e.clientX;
            _panStartY = e.clientY;
            _panStartPanX = _panX;
            _panStartPanY = _panY;
            $(this).css('cursor', 'grabbing');
        }
    });

    // Mouse up / leave: end drag or pan
    $(document).on('mouseup.graphviz', () => {
        if (_dragging !== null) {
            const n = nodes[_dragging];
            n.fx = null;
            n.fy = null;
            _dragging = null;
        }
        if (_panning) {
            _panning = false;
            $('#openvault_side_graph').css('cursor', 'grab');
        }
    });

    // Click on background: deselect (only if not just finishing a pan/drag)
    $panel.on('click', '#openvault_side_graph', (e) => {
        // Ignore clicks that were actually drags/pans (> 4px movement)
        if (_mouseDownPos) {
            const moved = Math.abs(e.clientX - _mouseDownPos.x) + Math.abs(e.clientY - _mouseDownPos.y);
            if (moved > 4) return;
        }
        if (_hoveredIndex < 0) {
            _selectedIndex = -1;
            hideDetails();
            renderFrame();
        }
    });

    // Wheel: zoom
    $panel.on('wheel', '#openvault_side_graph', function (e) {
        e.preventDefault();
        const $svg = $(this).find('.openvault-graph-svg');
        if (!$svg.length) return;
        const svg = $svg[0];
        const rect = svg.getBoundingClientRect();
        const focusX = e.clientX - rect.left;
        const focusY = e.clientY - rect.top;
        const delta = e.originalEvent?.deltaY || e.deltaY || 0;
        const factor = delta < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        zoomAt(factor, focusX, focusY);
    });

    // Tooltip on hover (delegated — survives SVG re-renders)
    $panel.on('mouseenter', '.openvault-graph-node', function () {
        const idx = parseInt($(this).attr('data-index') || '-1', 10);
        if (idx >= 0 && idx < nodes.length) {
            showNodeTooltip(nodes[idx], $(this));
        }
    });

    $panel.on('mouseleave', '.openvault-graph-node', () => {
        hideNodeTooltip();
    });

    // -------------------------------------------------------------------------
    // Toolbar events
    // -------------------------------------------------------------------------

    // Search input
    let _searchTimeout = null;
    $panel.on('input', '#openvault_graph_search', function () {
        clearTimeout(_searchTimeout);
        const val = String($(this).val() || '').trim();
        _searchTimeout = setTimeout(() => {
            _searchQuery = val;
            _hoveredIndex = -1;
            renderFrame();
        }, 150);
    });

    // Type filter
    $panel.on('change', '#openvault_graph_type_filter', function () {
        _typeFilter = String($(this).val() || '');
        _hoveredIndex = -1;
        renderFrame();
    });

    // Zoom buttons
    $panel.on('click', '#openvault_graph_zoom_in', () => {
        zoomAt(ZOOM_STEP);
    });
    $panel.on('click', '#openvault_graph_zoom_out', () => {
        zoomAt(1 / ZOOM_STEP);
    });
    $panel.on('click', '#openvault_graph_zoom_reset', () => {
        resetView();
    });

    // Details panel close button
    $panel.on('click', '.openvault-graph-details-close', () => {
        _selectedIndex = -1;
        hideDetails();
        renderFrame();
    });
}

/**
 * Sync the toolbar controls with current filter state (called on render).
 */
function syncFilterControls() {
    const $search = $('#openvault_graph_search');
    const $type = $('#openvault_graph_type_filter');
    if ($search.length && $search.val() !== _searchQuery) $search.val(_searchQuery);
    if ($type.length && $type.val() !== _typeFilter) $type.val(_typeFilter);
}

/**
 * Show tooltip with full entity info.
 * @param {object} node
 */
function showNodeTooltip(node, _$el) {
    removeTooltip();

    const data = getOpenVaultData();
    const entity = data?.graph?.nodes?.[node.key];
    if (!entity) return;

    const typeLabel = (entity.type || 'CONCEPT').charAt(0) + (entity.type || 'CONCEPT').slice(1).toLowerCase();
    const aliasesText =
        entity.aliases?.length > 0
            ? `<div class="ov-graph-tooltip-aliases">Also: ${escapeHtml(entity.aliases.join(', '))}</div>`
            : '';
    const desc = entity.description || 'No description';

    const tooltip = $(`
        <div class="openvault-graph-tooltip">
            <div class="ov-graph-tooltip-name">${escapeHtml(entity.name || node.key)} <span class="ov-graph-tooltip-type">${typeLabel}</span></div>
            <div class="ov-graph-tooltip-desc">${escapeHtml(desc.length > 120 ? desc.slice(0, 120) + '...' : desc)}</div>
            ${aliasesText}
            <div class="ov-graph-tooltip-meta">${entity.mentions || 0} mentions · click for details</div>
        </div>
    `);

    // Position tooltip based on SVG container bounds + node graph coordinates
    // transformed through the viewport (zoom/pan).
    const $svg = $('#openvault_side_graph').find('.openvault-graph-svg');
    if ($svg.length) {
        const svgRect = $svg[0].getBoundingClientRect();
        // Apply zoom/pan transform to node position to get screen offset within SVG
        const screenX = svgRect.left + node.x * _scale + _panX;
        const screenY = svgRect.top + node.y * _scale + _panY;
        let left = screenX + node.radius * _scale + 10;
        let top = screenY - 15;

        // Keep tooltip on-screen
        const tooltipW = 260;
        if (left + tooltipW > window.innerWidth - 10) {
            left = screenX - node.radius * _scale - tooltipW - 10;
        }
        if (top < 10) top = 10;

        tooltip.css({ left, top });
    }

    $('body').append(tooltip);
    tooltip.fadeIn(100);
}

function hideNodeTooltip() {
    removeTooltip();
}

function removeTooltip() {
    $('.openvault-graph-tooltip').remove();
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * @param {string} type
 * @param {number} mentions
 * @returns {number}
 */
function getNodeRadius(type, mentions) {
    const base = 10;
    const typeBonus = type === 'PERSON' ? 2 : 0;
    const mentionBonus = Math.min(8, Math.log2(mentions + 1) * 3);
    return base + typeBonus + mentionBonus;
}

/**
 * Get the raw color for an entity type (used by legend + nodes).
 * @param {string} type
 * @returns {string}
 */
function getTypeColor(type) {
    const colors = {
        PERSON: '#4ecdc4',
        PLACE: '#45b7d1',
        ORGANIZATION: '#96ceb4',
        OBJECT: '#ffeaa7',
        CONCEPT: '#dfe6e9',
    };
    return colors[type] || colors.CONCEPT;
}

/**
 * @param {string} type
 * @param {boolean} isSelected
 * @param {boolean} isHovered
 * @returns {string}
 */
function getNodeColor(type, isSelected, isHovered) {
    if (isSelected) return '#ff6b6b';
    if (isHovered) return '#ffd93d';
    return getTypeColor(type);
}

/**
 * @param {string} label
 * @returns {string}
 */
function truncateLabel(label) {
    if (label.length <= LABEL_MAX_LENGTH) return label;
    return label.slice(0, LABEL_MAX_LENGTH - 1) + '\u2026';
}

export { nodes, edges, _selectedIndex as selectedNodeIndex, _hoveredIndex as hoveredNodeIndex };
