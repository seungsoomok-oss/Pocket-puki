// 뉴럴 맵: d3-force + d3-zoom (전역 d3)
// 비슷하거나 상위·하위 관계인 아이디어는 "물방울"(그룹 노드) 하나로 합쳐 보이고,
// 탭하면 갈라져 각각 보이며, 바깥을 탭하면 다시 하나로 뭉친다.
const d3 = window.d3;

// 어두운 배경에서 은은하게 보이는 색
const HUES = [205, 160, 32, 280, 340, 95, 250, 15, 185, 55, 310, 130];
export const clusterColor = (i) =>
  i == null ? 'hsl(220, 8%, 62%)' : `hsl(${HUES[i % HUES.length]}, ${i >= HUES.length ? 35 : 48}%, 70%)`;

const GID = (gid) => 'g:' + gid;
const MERGE_MS = 520;   // 뭉치는 애니메이션
const SPLIT_MS = 1400;  // 갈라지는 동안 물방울 효과 유지

export function createMap(svgEl, { onTap, onAim } = {}) {
  const svg = d3.select(svgEl);

  // 물방울(gooey) 필터: 가까운 원들이 액체처럼 붙었다 떨어짐
  const defs = svg.append('defs');
  const goo = defs.append('filter').attr('id', 'goo')
    .attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
  goo.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', 4).attr('result', 'b');
  goo.append('feColorMatrix').attr('in', 'b')
    .attr('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7');

  const root = svg.append('g');
  const gHalo = root.append('g');
  const gRing = root.append('g');
  const gLinks = root.append('g');
  const gBlobs = root.append('g').attr('class', 'blobs').attr('filter', 'url(#goo)');
  const gNodes = root.append('g');

  let W = svgEl.clientWidth, H = svgEl.clientHeight;
  let nodes = [], links = [], centers = new Map();
  const nodeById = new Map();

  // 최신 데이터
  let data = { ideas: [], clusters: [], groups: [] };
  let expanded = null;               // 펼친 그룹 id
  const pulling = new Map();         // ideaId -> 뭉칠 그룹 id (애니메이션 중)
  const splitting = new Map();       // ideaId -> 갈라지기 끝나는 시각
  let mergeTimer = null;
  let skipMerge = false;             // 뭉치기 애니메이션 직후 한 번은 바로 합침

  const zoom = d3.zoom()
    .scaleExtent([0.25, 5])
    .clickDistance(8)
    .on('zoom', (e) => { root.attr('transform', e.transform); updateAim(); });
  svg.call(zoom).on('dblclick.zoom', null);

  // 바깥(빈 곳) 탭 → 펼친 물방울 다시 합치기
  svg.on('click', (e) => {
    if (e.target === svgEl && expanded) collapse();
  });

  // 은은한 떠다님 + 뭉치기
  function drift() {
    const t = performance.now() / 1000;
    for (const n of nodes) {
      n.vx += Math.sin(t * 0.3 + n.seed) * 0.012;
      n.vy += Math.cos(t * 0.25 + n.seed * 1.3) * 0.012;
    }
    if (pulling.size) {
      const cent = new Map();
      for (const n of nodes) {
        const g = pulling.get(n.id);
        if (!g) continue;
        const c = cent.get(g) || { x: 0, y: 0, k: 0 };
        c.x += n.x; c.y += n.y; c.k++;
        cent.set(g, c);
      }
      for (const n of nodes) {
        const c = cent.get(pulling.get(n.id));
        if (!c) continue;
        n.vx += (c.x / c.k - n.x) * 0.22;
        n.vy += (c.y / c.k - n.y) * 0.22;
      }
    }
  }

  const sim = d3.forceSimulation()
    .alphaDecay(0.03)
    .velocityDecay(0.35)
    .force('charge', d3.forceManyBody().strength((d) => (pulling.has(d.id) ? 0 : d.kind === 'group' ? -110 : -70)).distanceMax(320))
    .force('link', d3.forceLink().id((d) => d.id).distance(70).strength(0.25))
    .force('collide', d3.forceCollide().radius((d) => (pulling.has(d.id) ? 0 : d.kind === 'group' ? 30 : 22)).strength(0.6))
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
  let ringSel = gRing.selectAll('g');
  let linkSel = gLinks.selectAll('line');
  let blobSel = gBlobs.selectAll('circle');
  let nodeSel = gNodes.selectAll('g');
  let tickN = 0;

  function tick() {
    linkSel
      .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    blobSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
    haloSel.attr('transform', (c) => {
      const m = nodes.filter((n) => n.clusterId === c.id);
      if (!m.length) return null;
      const x = d3.mean(m, (n) => n.x), y = d3.min(m, (n) => n.y);
      return `translate(${x},${y - 30})`;
    });
    // 펼친 물방울: 구성원을 감싸는 얇은 테두리와 이름
    ringSel.each(function (g) {
      const m = nodes.filter((n) => g.members.includes(n.id));
      if (!m.length) return;
      const cx = d3.mean(m, (n) => n.x), cy = d3.mean(m, (n) => n.y);
      const r = (d3.max(m, (n) => Math.hypot(n.x - cx, n.y - cy)) || 0) + 30;
      const s = d3.select(this);
      s.select('circle').attr('cx', cx).attr('cy', cy).attr('r', r);
      s.select('text').attr('x', cx).attr('y', cy - r - 6);
    });
    if (++tickN % 8 === 0) updateAim();
    // 갈라지기 끝난 노드는 물방울 효과 해제
    if (splitting.size && tickN % 15 === 0) {
      const now = performance.now();
      let changed = false;
      for (const [id, until] of splitting) if (now > until) { splitting.delete(id); changed = true; }
      if (changed) renderBlobs();
    }
  }

  // 화면에 그릴 단위 계산 (접힌 그룹은 노드 하나)
  function groupsOf() {
    const have = new Set(data.ideas.map((i) => i.id));
    const used = new Set();
    return (data.groups || []).map((g) => {
      const members = (g.members || []).filter((m) => have.has(m) && !used.has(m));
      members.forEach((m) => used.add(m));
      return { ...g, members };
    }).filter((g) => g.members.length >= 2);
  }

  function unitMapFor(groups, collapsedIds) {
    const unitOf = new Map();
    for (const g of groups) if (collapsedIds.has(g.id)) g.members.forEach((m) => unitOf.set(m, GID(g.id)));
    return unitOf;
  }

  function build() {
    const groups = groupsOf();
    if (expanded && !groups.some((g) => g.id === expanded)) expanded = null;
    const collapsedIds = new Set(groups.filter((g) => g.id !== expanded).map((g) => g.id));

    // 지금 따로 떠 있는데 접혀야 하는 그룹 → 먼저 뭉치는 애니메이션
    const current = new Set(nodes.filter((n) => n.kind === 'idea').map((n) => n.id));
    const toMerge = skipMerge ? [] : groups.filter((g) => collapsedIds.has(g.id) && g.members.filter((m) => current.has(m)).length >= 2);
    skipMerge = false;
    if (toMerge.length && !mergeTimer) {
      for (const g of toMerge) for (const m of g.members) if (current.has(m)) { pulling.set(m, g.id); splitting.set(m, performance.now() + MERGE_MS + 200); }
      renderBlobs();
      sim.alpha(0.7).restart();
      mergeTimer = setTimeout(() => { mergeTimer = null; pulling.clear(); skipMerge = true; build(); }, MERGE_MS);
      return;
    }
    if (mergeTimer) return; // 뭉치는 중에는 끝난 뒤 반영

    const { ideas, clusters } = data;
    const colorOf = new Map(clusters.map((c) => [c.id, c.color]));
    const ideaById = new Map(ideas.map((i) => [i.id, i]));
    const unitOf = unitMapFor(groups, collapsedIds);
    const counts = d3.rollup(ideas, (v) => v.length, (d) => d.clusterId);
    layoutCenters(clusters, counts);

    const prev = new Map(nodes.map((n) => [n.id, n]));
    const next = [];

    for (const i of ideas) {
      if (unitOf.has(i.id)) continue;
      let n = prev.get(i.id);
      if (!n) {
        // 방금 펼친 그룹의 구성원이면 물방울 자리에서 갈라져 나옴
        const gp = [...prev.values()].find((p) => p.kind === 'group' && p.members.includes(i.id));
        const c = gp || centers.get(i.clusterId) || { x: W / 2, y: H / 2 };
        const spread = gp ? 4 : 40;
        n = { id: i.id, seed: Math.random() * 100, x: c.x + (Math.random() - 0.5) * spread, y: c.y + (Math.random() - 0.5) * spread };
        if (gp) splitting.set(i.id, performance.now() + SPLIT_MS);
      }
      n.kind = 'idea';
      n.clusterId = i.clusterId || null;
      n.color = clusterColor(colorOf.has(i.clusterId) ? colorOf.get(i.clusterId) : null);
      n.status = i.status;
      n.label = (i.origin === 'ai' ? '✦ ' : '') + (i.status === 'done' && i.keyword ? i.keyword : i.text.replace(/\s+/g, ' ').slice(0, 8) + '…');
      n.degree = 0;
      next.push(n);
    }

    for (const g of groups) {
      if (!collapsedIds.has(g.id)) continue;
      const id = GID(g.id);
      let n = prev.get(id);
      if (!n) {
        const ms = g.members.map((m) => prev.get(m)).filter(Boolean);
        const c = ms.length ? { x: d3.mean(ms, (p) => p.x), y: d3.mean(ms, (p) => p.y) } : null;
        const mc = ideaById.get(g.members[0])?.clusterId;
        const cc = c || centers.get(mc) || { x: W / 2, y: H / 2 };
        n = { id, seed: Math.random() * 100, x: cc.x, y: cc.y };
      }
      // 구성원 다수가 속한 묶음 색
      const cl = d3.rollups(g.members, (v) => v.length, (m) => ideaById.get(m)?.clusterId || null).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      n.kind = 'group';
      n.gid = g.id;
      n.members = g.members;
      n.clusterId = cl;
      n.color = clusterColor(colorOf.has(cl) ? colorOf.get(cl) : null);
      n.status = 'done';
      n.label = g.name || ideaById.get(g.members[0])?.keyword || '';
      n.count = g.members.length;
      n.degree = 0;
      next.push(n);
    }

    nodes = next;
    nodeById.clear();
    nodes.forEach((n) => nodeById.set(n.id, n));

    const seen = new Set();
    links = [];
    for (const i of ideas) {
      for (const j of i.links || []) {
        if (!ideaById.has(j)) continue;
        const a = unitOf.get(i.id) || i.id, b = unitOf.get(j) || j;
        if (a === b || !nodeById.has(a) || !nodeById.has(b)) continue;
        const k = a < b ? a + '|' + b : b + '|' + a;
        if (seen.has(k)) continue;
        seen.add(k);
        links.push({ source: a, target: b, key: k });
        nodeById.get(a).degree++;
        nodeById.get(b).degree++;
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
        g.append('text').attr('class', 'count');
        g.append('text').attr('class', 'label').attr('dy', 16);
        g.transition().duration(500).style('opacity', 1).on('end', function () { this.style.removeProperty('opacity'); });
        return g;
      })
      .classed('pending', (d) => d.status !== 'done')
      .classed('group', (d) => d.kind === 'group')
      .on('click', (e, d) => {
        e.stopPropagation();
        if (d.kind === 'group') expand(d.gid);
        else onTap?.(d.id);
      });
    nodeSel.select('circle.hit').attr('r', (d) => (d.kind === 'group' ? 30 : 22));
    nodeSel.select('circle.dot').attr('fill', (d) => d.color);
    nodeSel.select('text.count').text((d) => (d.kind === 'group' ? d.count : ''));
    nodeSel.select('text.label').text((d) => d.label).attr('fill', (d) => d.color)
      .attr('dy', (d) => (d.kind === 'group' ? 24 : 16));

    const shown = clusters.filter((c) => (counts.get(c.id) || 0) >= 2);
    haloSel = gHalo.selectAll('text').data(shown, (c) => c.id)
      .join('text').attr('class', 'cluster')
      .text((c) => c.name)
      .attr('fill', (c) => clusterColor(c.color));

    gHalo.style('display', expanded ? 'none' : null); // 펼친 동안엔 묶음 이름과 겹치지 않게
    const exp = expanded ? groups.filter((g) => g.id === expanded) : [];
    ringSel = gRing.selectAll('g.ring').data(exp, (g) => g.id)
      .join((e) => {
        const g = e.append('g').attr('class', 'ring');
        g.append('circle');
        g.append('text');
        return g;
      });
    ringSel.select('text').text((g) => g.name);

    renderBlobs();
    applyLens();
    sim.nodes(nodes);
    sim.force('link').links(links);
    sim.alpha(prev.size ? 0.5 : 0.9).restart();
  }

  // 물방울 층: 그룹 노드 + 갈라지거나 뭉치는 중인 노드만 (필터 비용 최소화)
  function renderBlobs() {
    const list = nodes.filter((n) => n.kind === 'group' || splitting.has(n.id) || pulling.has(n.id));
    blobSel = gBlobs.selectAll('circle').data(list, (d) => d.id)
      .join('circle')
      .attr('r', (d) => (d.kind === 'group' ? 9 + 2.2 * Math.sqrt(d.count) : 6.5))
      .attr('fill', (d) => d.color)
      .attr('cx', (d) => d.x).attr('cy', (d) => d.y);
  }

  function update(ideas, clusters, groups = []) {
    data = { ideas, clusters, groups };
    build();
  }

  function expand(gid) {
    if (expanded === gid) return;
    expanded = gid;
    build();
    const g = groupsOf().find((x) => x.id === gid);
    if (g) setTimeout(() => fit(g.members, { viewH: H * 0.7, maxK: 2.4 }), 250);
  }

  function collapse() {
    if (!expanded) return;
    expanded = null;
    build();
  }

  // 아이디어 id → 지금 화면의 단위 id
  function unitIdOf(id) {
    if (nodeById.has(id)) return id;
    const g = nodes.find((n) => n.kind === 'group' && n.members.includes(id));
    return g ? g.id : null;
  }

  // 접힌 물방울 안의 아이디어를 보여줘야 할 때 펼침
  function reveal(id) {
    if (nodeById.get(id)?.kind === 'idea') return;
    const g = nodes.find((n) => n.kind === 'group' && n.members.includes(id));
    if (g) expand(g.gid);
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
    reveal(id);
    setTimeout(() => {
      const n = nodeById.get(unitIdOf(id));
      if (!n) return;
      const t = d3.zoomTransform(svgEl);
      const k = Math.max(t.k, 1.2);
      svg.transition().duration(600).call(zoom.transform,
        d3.zoomIdentity.translate(W / 2 - n.x * k, H * 0.32 - n.y * k).scale(k));
    }, 60);
  }

  function select(id) {
    const u = id ? unitIdOf(id) : null;
    nodeSel.classed('selected', (d) => d.id === u);
    linkSel.classed('lit', (d) => u && (d.source.id === u || d.target.id === u));
  }

  // 질문 결과: 고른 노드만 밝게, 점수만큼 크게 (물방울은 구성원 중 최고 점수)
  let lensMap = null;
  const scoreOf = (d) => {
    if (!lensMap) return 0;
    if (d.kind === 'group') return Math.max(0, ...d.members.map((m) => lensMap.get(m) || 0));
    return lensMap.get(d.id) || 0;
  };
  const baseR = (d) => (d.kind === 'group' ? 6 + 1.5 * Math.sqrt(d.count) : 2.6 + Math.min(d.degree, 5) * 0.5);
  function applyLens() {
    const on = !!lensMap;
    svg.classed('lens', on);
    nodeSel.classed('picked', (d) => on && scoreOf(d) > 0);
    nodeSel.select('circle.dot').attr('r', (d) => baseR(d) + scoreOf(d) * 0.45);
    linkSel.classed('picked', (d) => on && scoreOf(d.source) > 0 && scoreOf(d.target) > 0);
  }
  function lens(scores) { lensMap = scores && scores.size ? scores : null; applyLens(); }

  // 고른 아이디어들이 한 화면에 들어오게
  function fit(ids, { viewH = H * 0.42, maxK = 2 } = {}) {
    const units = new Set(ids.map(unitIdOf).filter(Boolean));
    const m = nodes.filter((n) => units.has(n.id));
    if (!m.length) return;
    const [x0, x1] = d3.extent(m, (n) => n.x), [y0, y1] = d3.extent(m, (n) => n.y);
    const pad = 70;
    const k = Math.max(0.4, Math.min(maxK, (W - pad * 2) / Math.max(1, x1 - x0), (viewH - pad) / Math.max(1, y1 - y0)));
    svg.transition().duration(700).call(zoom.transform,
      d3.zoomIdentity.translate(W / 2 - ((x0 + x1) / 2) * k, viewH / 2 + 30 - ((y0 + y1) / 2) * k).scale(k));
  }

  // 화면 가운데 조준점(+) 근처의 단위 → 영감의 씨앗
  const AIM_R = 90; // 화면 px
  let aimId = null;
  function aimPoint() {
    const r = svgEl.getBoundingClientRect();
    return [window.innerWidth / 2 - r.left, window.innerHeight / 2 - r.top];
  }
  function updateAim() {
    const t = d3.zoomTransform(svgEl);
    const [sx, sy] = aimPoint();
    let best = null, bd = Infinity;
    for (const n of nodes) {
      if (n.status !== 'done') continue;
      const [x, y] = t.apply([n.x, n.y]);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = n; }
    }
    const id = best && bd <= AIM_R ? best.id : null;
    if (id === aimId) return;
    aimId = id;
    nodeSel.classed('anchor', (d) => d.id === aimId);
    onAim?.(aim());
  }
  // 지금 조준 중인 대상: { ideaIds, label } 또는 null
  function aim() {
    const n = aimId && nodeById.get(aimId);
    if (!n) return null;
    return { ideaIds: n.kind === 'group' ? [...n.members] : [n.id], label: n.label };
  }

  return { update, focus, select, lens, fit, aim, collapse, reveal };
}
