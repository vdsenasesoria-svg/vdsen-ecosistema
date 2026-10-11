// Firebase App double for the VDSEN Image Upload harness. Never touches the network.
export function initializeApp(cfg) { return { name: '[harness]', options: cfg || {} }; }
export default { initializeApp };
