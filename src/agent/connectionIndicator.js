const STATES = Object.freeze({
  connecting: { label: 'AGENT CONNECTING', tone: 'pending' },
  open: { label: 'AGENT CONNECTED', tone: 'connected' },
  reconnecting: { label: 'AGENT RECONNECTING', tone: 'pending' },
  closed: { label: 'AGENT DISCONNECTED', tone: 'offline' },
  destroyed: { label: 'AGENT DISCONNECTED', tone: 'offline' },
});

/**
 * Connect a browserClient onStateChange callback to the small, opt-in status
 * affordance. The element remains hidden until enabled by the MCP bootstrap.
 */
export function createAgentConnectionIndicator({
  element,
  enabled = false,
} = {}) {
  if (!element || typeof element.setAttribute !== 'function')
    throw new TypeError('element is required');

  let active = Boolean(enabled);
  let destroyed = false;
  const setVisibility = () => {
    element.hidden = !active || destroyed;
    element.setAttribute('aria-hidden', String(!active || destroyed));
  };
  const update = (event = {}) => {
    if (destroyed || !event || typeof event.type !== 'string') return;
    const state = STATES[event.type];
    if (!state) return;
    element.dataset.state = event.type;
    element.dataset.tone = state.tone;
    element.textContent = state.label;
    if (event.attempt) element.dataset.attempt = String(event.attempt);
    else delete element.dataset.attempt;
    setVisibility();
  };
  const setEnabled = (value) => {
    if (destroyed) return;
    active = Boolean(value);
    setVisibility();
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    setVisibility();
    element.textContent = '';
  };

  setVisibility();
  return Object.freeze({ update, setEnabled, destroy });
}

export { STATES as AGENT_CONNECTION_STATES };
