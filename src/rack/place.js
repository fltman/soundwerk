// Where modules sit: rows of rail, measured in HP. Modules never overlap; one dropped on another
// pushes it along the rail, as sliding a real module would.
import { layoutPanel } from '../wall/layout.js';

export const WALL_HP = 184;

export const widthOf = (graph, node) => layoutPanel(graph.def(node)).hp;

export function rowsUsed(graph) {
  let rows = 0;
  for (const n of graph.nodes.values()) rows = Math.max(rows, n.row + 1);
  return rows;
}

const inRow = (graph, row, skip) => [...graph.nodes.values()].filter((n) => n.row === row && !skip.has(n.id)).sort((a, b) => a.hp - b.hp);

// The first gap wide enough, from the top of the wall; a new row if nothing has room.
export function findGap(graph, width, { startRow = 0, skip = new Set() } = {}) {
  for (let row = startRow; ; row++) {
    let x = 0;
    for (const n of inRow(graph, row, skip)) {
      if (n.hp - x >= width) break;
      x = Math.max(x, n.hp + widthOf(graph, n));
    }
    if (x + width <= WALL_HP) return { row, hp: x };
  }
}

// Put `node` at (row, hp); whatever is in the way shifts right, and anything shifted pushes the next one.
export function dropAt(graph, node, row, hp) {
  const width = widthOf(graph, node);
  hp = Math.max(0, Math.min(WALL_HP - width, hp));
  graph.moveNode(node.id, row, hp);
  let edge = hp + width;
  for (const n of inRow(graph, row, new Set([node.id]))) {
    const w = widthOf(graph, n);
    if (n.hp + w <= hp) continue;
    if (n.hp >= edge) break;
    // pushed off the end of the rail, a module drops to the next gap below
    if (edge + w > WALL_HP) {
      const at = findGap(graph, w, { startRow: row + 1, skip: new Set([n.id]) });
      graph.moveNode(n.id, at.row, at.hp);
      continue;
    }
    graph.moveNode(n.id, row, edge);
    edge += w;
  }
}
