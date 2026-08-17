export interface Binding {
  keys: string[];
  label: string;
}

export interface BindingGroup {
  title: string;
  items: Binding[];
}

/** The single source of truth for the controls overlay and the panel. */
export const BINDINGS: BindingGroup[] = [
  {
    title: 'Working the ship',
    items: [
      { keys: ['A', 'D'], label: 'Helm to port / starboard' },
      { keys: ['W', 'S'], label: 'Make sail / take in sail' },
      { keys: ['Q', 'E'], label: 'Brace the yards' },
    ],
  },
  {
    title: 'Looking about',
    items: [
      { keys: ['C'], label: 'Next camera' },
      { keys: ['drag'], label: 'Look around' },
      { keys: ['wheel'], label: 'Zoom' },
    ],
  },
  {
    title: 'Interface',
    items: [
      { keys: ['Tab'], label: "Open the ship's book" },
      { keys: ['Esc'], label: 'Close / back' },
      { keys: ['H'], label: 'Hide the instruments' },
      { keys: ['P'], label: 'Pause' },
      { keys: ['F2'], label: 'Photo mode' },
      { keys: ['F3'], label: 'Performance overlay' },
    ],
  },
];

/** The short list shown once, on a first voyage. */
export const FIRST_RUN: Binding[] = [
  { keys: ['A', 'D'], label: 'helm' },
  { keys: ['W', 'S'], label: 'sail' },
  { keys: ['Q', 'E'], label: 'brace' },
  { keys: ['C'], label: 'camera' },
  { keys: ['Tab'], label: 'settings' },
];
