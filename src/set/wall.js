// What a Set needs on the wall before anyone can plan with it. Only the graph, so it's the same in
// Node. Where its sound goes is the assistant's to decide, along with the rest of the setup.
import { findGap, widthOf } from '../rack/place.js';

function place(graph, node) {
  const at = findGap(graph, widthOf(graph, node), { skip: new Set([node.id]) });
  graph.moveNode(node.id, at.row, at.hp);
  return node;
}

export function wireSet(graph, id) {
  const clock = [...graph.nodes.values()].find((n) => n.type === 'clock') ?? place(graph, graph.addNode('clock', 0, 0));
  if (!graph.linkInto(id, 'clk')) graph.connect(clock.id, 's16', id, 'clk');
  graph.commit();
}
