// The page's line to the plugin host, off the main thread: the wall drawing a frame must not make a
// block of audio late. Blocks go between the audio thread's modules and the socket directly, each
// module on a port of its own; everything else is for src/ui/plugins.js.
const BLOCK = 1;
const socket = new WebSocket(`ws://${location.host}/api/vst`);
socket.binaryType = 'arraybuffer';
const ports = new Map();   // the plugin's number → its module
const waiting = [];

socket.onopen = () => { for (const frame of waiting.splice(0)) socket.send(frame); };
socket.onclose = (e) => postMessage({ gone: e.reason || 'the plugin host could not be reached' });
socket.onmessage = ({ data }) => {
  const head = new DataView(data);
  if (head.getUint8(0) === BLOCK) ports.get(head.getUint32(8, true))?.postMessage(data, [data]);
  else postMessage({ frame: data }, [data]);
};

const send = (frame) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(frame);
  else waiting.push(frame);
};

onmessage = ({ data: { frame, number, port, closed } }) => {
  if (frame) send(frame);
  if (port) {
    ports.set(number, port);
    port.onmessage = (e) => {
      new DataView(e.data).setUint32(8, number, true);
      send(e.data);
    };
  }
  if (closed) {
    ports.get(number)?.close();
    ports.delete(number);
  }
};
