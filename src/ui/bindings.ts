export interface Binding {
  keys: string[];
  label: string;
  /**
   * Only true in Pro. In the default mode the watch trims and braces, so these
   * keys do nothing — and a book that lists a key which does nothing is worse
   * than a book that lists nothing at all.
   */
  pro?: boolean;
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
      { keys: ['←', '→'], label: 'Helm to port / starboard' },
      { keys: ['↑', '↓'], label: 'Make sail / take in sail', pro: true },
      { keys: ['A', 'D'], label: 'Helm, the other hand' },
      { keys: ['W', 'S'], label: 'Sail, the other hand', pro: true },
      { keys: ['Q', 'E'], label: 'Brace the yards', pro: true },
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
      { keys: ['I'], label: 'Simple / full instruments' },
      { keys: ['H'], label: 'Hide the instruments' },
      { keys: ['P'], label: 'Pause' },
      { keys: ['F2'], label: 'Photo mode' },
      { keys: ['F3'], label: 'Performance overlay' },
    ],
  },
];

/** The short list shown once on a first voyage — Pro mode only. */
export const FIRST_RUN: Binding[] = [
  { keys: ['←', '→'], label: 'helm' },
  { keys: ['↑', '↓'], label: 'sail' },
  { keys: ['Q', 'E'], label: 'brace' },
  { keys: ['C'], label: 'camera' },
  { keys: ['Tab'], label: 'settings' },
];
