/**
 * Graph Visualization Module
 *
 * Renders the entity-relationship graph as an interactive force-directed
 * layout inside the side panel's "Graph" tab.
 *
 * Architecture:
 * - Pure SVG rendering (no third-party library)
 * - Simple force simulation: repulsion between all nodes, attraction along edges
 * - Interactive: drag nodes, hover for tooltips, click to select
 * - Responsive: auto-resizes to container
 * - Performance: skips simulation when tab is hidden; caps at ~200 nodes
 */
// @ts-check

import { getOpenVaultData } from '../store/chat-data.js';
import { escapeHtml } from '../utils/dom.js';

// =============================================================================
// Physics Constants
// =============================================================================

const REPULSION = 600;
const ATTRACTION = 0.003;
const DAMPING = 0.65;
const MIN_VELOCITY = 0.15;
const MAX_SIMULATION_TIME = 8000;
const MAX_NODES = 200;
const NODE_RADIUS = 12;
const LABEL_MAX_LENGTH = 14;

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
        stopSimulation();
        return;
    }

    const graph = data.graph;
    const nodeEntries = Object.entries(graph.nodes || {});

    if (nodeEntries.length === 0) {
        $container.html('<p class="openvault-side-placeholder">No entities extracted yet</p>');
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

    const tickStart = performance.now();

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

        // Clamp to bounds
        n.x = Math.max(n.radius, Math.min(_containerWidth - n.radius, n.x));
        n.y = Math.max(n.radius, Math.min(_containerHeight - n.radius, n.y));

        totalVelocity += Math.abs(n.vx) + Math.abs(n.vy);
    }

    // Render
    renderFrame();

    // Continue simulation if there's still energy or we're dragging
    const avgVelocity = totalVelocity / nodes.length;
    if (avgVelocity > MIN_VELOCITY || _dragging) {
        // Throttle simulation steps for perf (target ~30fps when settled)
        const elapsed = performance.now() - tickStart;
        const delay = avgVelocity < 2 ? 33 : 16;
        _animationId = setTimeout(() => requestAnimationFrame(simulateStep), Math.max(0, delay - elapsed));
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
// SVG Rendering
// =============================================================================

function renderFrame() {
    const now = performance.now();
    if (now - _lastRenderTime < 16) return; // Cap at ~60fps
    _lastRenderTime = now;

    const $container = $('#openvault_side_graph');
    if (!$container.length) return;

    // Build SVG string directly (faster than DOM manipulation for small graphs)
    let svg = `<svg width="${_containerWidth}" height="${_containerHeight}" class="openvault-graph-svg">`;

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
        const sw = Math.min(3, 0.5 + e.weight * 0.5);
        const opacity = 0.3 + Math.min(0.5, e.weight * 0.1);
        const isSelectedEdge =
            _selectedIndex >= 0 && (e.source === _selectedIndex || e.target === _selectedIndex);
        const strokeColor = isSelectedEdge
            ? 'var(--SmartThemeEmColor, #48c)'
            : 'var(--SmartThemeBorderColor, #555)';
        svg += `
            <line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}"
                stroke="${strokeColor}" stroke-width="${sw}" opacity="${opacity}"
                marker-end="url(#ov-graph-arrow)" />
        `;
    }

    // Node circles and labels
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const isHovered = i === _hoveredIndex;
        const isSelected = i === _selectedIndex;
        const fillColor = getNodeColor(n.type, isSelected, isHovered);
        const strokeWidth = isSelected ? 3 : isHovered ? 2 : 1;
        const r = isHovered ? n.radius + 3 : n.radius;

        svg += `
            <g class="openvault-graph-node" data-index="${i}">
                <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${fillColor}"
                    stroke="var(--SmartThemeEmColor, #48c)" stroke-width="${strokeWidth}"
                    opacity="${isSelected || isHovered ? 1 : 0.85}" />
        `;

        // Label (always visible for small graphs, abbreviated)
        if (nodes.length <= 50 || isHovered || isSelected) {
            const fontSize = isHovered ? '11px' : '9px';
            svg += `
                <text x="${n.x}" y="${n.y + n.radius + 13}" text-anchor="middle"
                    fill="var(--SmartThemeBodyColor, #ccc)" font-size="${fontSize}"
                    font-family="sans-serif" pointer-events="none">${escapeHtml(n.label)}</text>
            `;
        }

        svg += '</g>';
    }

    svg += '</svg>';

    // Update DOM
    $container.html(svg);

    // Bind events after render
    bindGraphEvents();
}

// =============================================================================
// Interaction
// =============================================================================

let _eventsBound = false;

function bindGraphEvents() {
    if (_eventsBound) return;
    _eventsBound = true;

    const $container = $('#openvault_side_graph');

    // Mouse move: hover detection
    $container.on('mousemove', '.openvault-graph-svg', function (e) {
        const svg = this;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return;
        const svgPt = pt.matrixTransform(ctm.inverse());

        // Hit test all nodes (reverse order for z-index)
        let found = -1;
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            const dx = svgPt.x - n.x;
            const dy = svgPt.y - n.y;
            if (dx * dx + dy * dy <= (n.radius + 5) * (n.radius + 5)) {
                found = i;
                break;
            }
        }

        if (found !== _hoveredIndex) {
            _hoveredIndex = found;
            // Update cursor
            $container.css('cursor', found >= 0 ? 'pointer' : 'default');
        }

        // Drag update
        if (_dragging !== null) {
            const n = nodes[_dragging];
            n.fx = svgPt.x - _dragOffsetX;
            n.fy = svgPt.y - _dragOffsetY;
            n.x = n.fx;
            n.y = n.fy;
            n.vx = 0;
            n.vy = 0;
        }
    });

    // Mouse down: start drag
    $container.on('mousedown', '.openvault-graph-svg', function (e) {
        if (_hoveredIndex < 0) return;
        e.preventDefault();
        _dragging = _hoveredIndex;
        _selectedIndex = _hoveredIndex;

        const n = nodes[_dragging];
        const svg = this;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const ctm = svg.getScreenCTM();
        if (ctm) {
            const svgPt = pt.matrixTransform(ctm.inverse());
            _dragOffsetX = svgPt.x - n.x;
            _dragOffsetY = svgPt.y - n.y;
        }

        if (!_simRunning) startSimulation();
    });

    // Mouse up / leave: end drag
    $(document).on('mouseup.graphviz', () => {
        if (_dragging !== null) {
            const n = nodes[_dragging];
            n.fx = null;
            n.fy = null;
            _dragging = null;
        }
    });

    // Click on background: deselect
    $container.on('click', '.openvault-graph-svg', function (e) {
        if (_hoveredIndex < 0) {
            _selectedIndex = -1;
        }
    });

    // Tooltip on hover
    $container.on('mouseenter', '.openvault-graph-node', function () {
        const idx = parseInt($(this).attr('data-index') || '-1', 10);
        if (idx >= 0 && idx < nodes.length) {
            showNodeTooltip(nodes[idx], $(this));
        }
    });

    $container.on('mouseleave', '.openvault-graph-node', function () {
        hideNodeTooltip();
    });
}

/**
 * Show tooltip with full entity info.
 * @param {object} node
 * @param {JQuery} $el
 */
function showNodeTooltip(node, $el) {
    removeTooltip();

    const data = getOpenVaultData();
    const entity = data?.graph?.nodes?.[node.key];
    if (!entity) return;

    const typeLabel = (entity.type || 'CONCEPT').charAt(0) + (entity.type || 'CONCEPT').slice(1).toLowerCase();
    const aliasesText = entity.aliases?.length > 0
        ? `<div class="ov-graph-tooltip-aliases">Also: ${escapeHtml(entity.aliases.join(', '))}</div>`
        : '';
    const desc = entity.description || 'No description';

    const tooltip = $(`
        <div class="openvault-graph-tooltip">
            <div class="ov-graph-tooltip-name">${escapeHtml(entity.name || node.key)} <span class="ov-graph-tooltip-type">${typeLabel}</span></div>
            <div class="ov-graph-tooltip-desc">${escapeHtml(desc.length > 120 ? desc.slice(0, 120) + '...' : desc)}</div>
            ${aliasesText}
            <div class="ov-graph-tooltip-meta">${entity.mentions || 0} mentions</div>
        </div>
    `);

    // Position tooltip based on SVG container bounds + node SVG coordinates
    // (jQuery .offset() is unreliable on SVG elements)
    const $svg = $('#openvault_side_graph').find('.openvault-graph-svg');
    if ($svg.length) {
        const svgRect = $svg[0].getBoundingClientRect();
        const left = svgRect.left + node.x + node.radius + 10;
        const top = svgRect.top + node.y - 15;
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
 * @param {string} type
 * @param {boolean} isSelected
 * @param {boolean} isHovered
 * @returns {string}
 */
function getNodeColor(type, isSelected, isHovered) {
    if (isSelected) return '#ff6b6b';
    if (isHovered) return '#ffd93d';
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
 * @param {string} label
 * @returns {string}
 */
function truncateLabel(label) {
    if (label.length <= LABEL_MAX_LENGTH) return label;
    return label.slice(0, LABEL_MAX_LENGTH - 1) + '\u2026';
}

export { nodes, edges, _selectedIndex as selectedNodeIndex, _hoveredIndex as hoveredNodeIndex };
