// 뉴럴 맵: d3-force + d3-zoom (전역 d3)
const d3 = window.d3;

// 어두운 배경에서 은은하게 보이는 색
const HUES = [205, 160, 32, 280, 340, 95, 250, 15, 185, 55, 310, 130];
export const clusterColor = (i) =>
  i == null ? 'hsl(220, 8%, 62%)' : `hsl(${HUES[i % HUES.length]}, ${i >= HUES.length ? 35 : 48}%, 70%)`;

export function createMap(svgEl, { onTap }) {
  const svg = d3.select(svgEl);
  const root = svg.append('g');
  const gHalo = root.append('g');
  const gLinks = root.append('g');
  const gNodes = root.append('g');

  let W = svgEl.clientWidth, H = svgEl.clientHeight;
  let nodes = [], links = [], centers = new Map();
  const nodeById = new Map();

  const zoom = d3.zoom()
    .scaleExtent([0.25, 5])
    .clickDistance(8)
    .on('zoom', (e) => root.attr('transform', e.transform));
  svg.call(zoom).on('dblclick.zoom', null);

  // 은은한 떠다님
  function drift(alpha) {
    const t = performance.now() / 1000;
    for (const n of nodes) {
      n.vx += Math.sin(t * 0.3 + n.seed) * 0.012;
      n.vy += Math.cos(t * 0.25 + n.seed * 1.3) * 0.012;
    }
  }

  const sim = d3.forceSimulation()
    .alphaDecay(0.03)
    .velocityDecay(0.35)
    .force('charge', d3.forceManyBody().strength(-70).distanceMax(320))
    .force('link', d3.forceLink().id((d) => d.id).distance(70).strength(0.25))
    .force('collide', d3.forceCollide().radius(22).strength(0.6))
    .force('x', d3.forceX((d) => centerOf(d).x).strength(0.07))
    .force('y', d3.forceY((d) => centerOf(d).y).strength(0.07))
    .force('drift', drift)
    .alphaTarget(0.008)
    .on('tick', tick);

  function centerOf(d) {
    return centers.get(d.clusterId) || { x: W / 2, y: H / 2 };
  }

  // 묶음 중심을 화면 가운데 둘레에 배치
  function layoutCenters(clusters, counts) {
    const list = clusters.filter((c) => counts.get(c.id));
    const R = Math.min(W, H) * (list.length > 1 ? 0.28 + Math.min(list.length, 10) * 0.012 : 0);
    centers = new Map();
    list.forEach((c, i) => {
      const a = (i / list.length) * Math.PI * 2 - Math.PI / 2;
      centers.set(c.id, { x: W / 2 + Math.cos(a) * R, y: H / 2 + Math.sin(a) * R * 1.15 });
    });
  }

  let haloSel = gHalo.selectAll('text');
  let linkSel = gLinks.selectAll('line');
  let nodeSel = gNodes.selectAll('g');
  let clusterList = [];

  function tick() {
    linkSel
      .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    // 묶음 이름은 구성원 중심에
    haloSel.attr('transform', (c) => {
      const m = nodes.filter((n) => n.clusterId === c.id);
      if (!m.length) return null;
      const x = d3.mean(m, (n) => n.x), y = d3.min(m, (n) => n.y);
      return `translate(${x},${y - 26})`;
    });
  }

  function update(ideas, clusters) {
    clusterList = clusters;
    const colorOf = new Map(clusters.map((c) => [c.id, c.color]));
    const counts = d3.rollup(ideas, (v) => v.length, (d) => d.clusterId);
    layoutCenters(clusters, counts);

    const prev = new Map(nodes.map((n) => [n.id, n]));
    nodes = ideas.map((i) => {
      const p = prev.get(i.id);
      const c = centers.get(i.clusterId);
      const n = p || {
        id: i.id,
        seed: Math.random() * 100,
        x: (c?.x ?? W / 2) + (Math.random() - 0.5) * 40,
        y: (c?.y ?? H / 2) + (Math.random() - 0.5) * 40,
      };
      n.clusterId = i.clusterId || null;
      n.color = clusterColor(colorOf.has(i.clusterId) ? colorOf.get(i.clusterId) : null);
      n.status = i.status;
      n.label = i.status === 'done' && i.keyword ? i.keyword : i.text.replace(/\s+/g, ' ').slice(0, 8) + '…';
      n.degree = 0;
      return n;
    });
    nodeById.clear();
    nodes.forEach((n) => nodeById.set(n.id, n));

    const seen = new Set();
    links = [];
    for (const i of ideas) {
      for (const j of i.links || []) {
        if (!nodeById.has(j)) continue;
        const k = i.id < j ? i.id + '|' + j : j + '|' + i.id;
        if (seen.has(k)) continue;
        seen.add(k);
        links.push({ source: i.id, target: j, key: k });
        nodeById.get(i.id).degree++;
        nodeById.get(j).degree++;
      }
    }

    linkSel = gLinks.selectAll('line').data(links, (d) => d.key)
      .join((e) => e.append('line').attr('class', 'link').style('opacity', 0)
        .call((s) => s.transition().duration(800).style('opacity', null)));

    nodeSel = gNodes.selectAll('g.node').data(nodes, (d) => d.id)
      .join((e) => {
        const g = e.append('g').attr('class', 'node').style('opacity', 0);
        g.append('circle').attr('class', 'hit').attr('r', 22);
        g.append('circle').attr('class', 'dot');
        g.append('text').attr('class', 'label').attr('dy', 16);
        g.transition().duration(700).style('opacity', 1).on('end', function () { this.style.removeProperty('opacity'); });
        return g;
      })
      .classed('pending', (d) => d.status !== 'done')
      .on('click', (e, d) => onTap?.(d.id));
    nodeSel.select('circle.dot').attr('fill', (d) => d.color);
    nodeSel.select('text.label').text((d) => d.label).attr('fill', (d) => d.color);

    const shown = clusters.filter((c) => (counts.get(c.id) || 0) >= 2);
    haloSel = gHalo.selectAll('text').data(shown, (c) => c.id)
      .join('text').attr('class', 'cluster')
      .text((c) => c.name)
      .attr('fill', (c) => clusterColor(c.color));

    applyLens();
    sim.nodes(nodes);
    sim.force('link').links(links);
    sim.alpha(prev.size ? 0.5 : 0.9).restart();
  }

  function resize() {
    W = svgEl.clientWidth; H = svgEl.clientHeight;
    sim.alpha(0.3).restart();
  }
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sim.stop(); else sim.restart();
  });

  function focus(id) {
    const n = nodeById.get(id);
    if (!n) return;
    const t = d3.zoomTransform(svgEl);
    const k = Math.max(t.k, 1.2);
    svg.transition().duration(600).call(zoom.transform,
      d3.zoomIdentity.translate(W / 2 - n.x * k, H * 0.32 - n.y * k).scale(k));
  }

  function select(id) {
    nodeSel.classed('selected', (d) => d.id === id);
    linkSel.classed('lit', (d) => id && (d.source.id === id || d.target.id === id));
  }

  // 질문 결과: 고른 노드만 밝게, 점수만큼 크게
  let lensMap = null;
  const baseR = (d) => 2.6 + Math.min(d.degree, 5) * 0.5;
  function applyLens() {
    const on = !!lensMap;
    svg.classed('lens', on);
    nodeSel.classed('picked', (d) => on && lensMap.has(d.id));
    nodeSel.select('circle.dot').attr('r', (d) => baseR(d) + (on && lensMap.has(d.id) ? lensMap.get(d.id) * 0.45 : 0));
    linkSel.classed('picked', (d) => on && lensMap.has(d.source.id ?? d.source) && lensMap.has(d.target.id ?? d.target));
  }
  function lens(scores) { lensMap = scores && scores.size ? scores : null; applyLens(); }

  // 고른 노드들이 한 화면에 들어오게
  function fit(ids) {
    const m = nodes.filter((n) => ids.includes(n.id));
    if (!m.length) return;
    const [x0, x1] = d3.extent(m, (n) => n.x), [y0, y1] = d3.extent(m, (n) => n.y);
    const viewH = H * 0.42, pad = 60;
    const k = Math.max(0.4, Math.min(2, (W - pad * 2) / Math.max(1, x1 - x0), (viewH - pad) / Math.max(1, y1 - y0)));
    svg.transition().duration(700).call(zoom.transform,
      d3.zoomIdentity.translate(W / 2 - ((x0 + x1) / 2) * k, viewH / 2 + 30 - ((y0 + y1) / 2) * k).scale(k));
  }

  return { update, focus, select, lens, fit };
}
